/**
 * crypto/ratchet.ts - Double Ratchet state machine.
 *
 * Implements the Double Ratchet algorithm (Signal protocol variant) using
 * @noble/curves for X25519 ECDH, @noble/hashes for HKDF/HMAC/SHA-256,
 * and @noble/ciphers for AES-256-GCM.
 *
 * Key differences from standard Signal Double Ratchet:
 *   1. No PreKey bundle - the shared secret comes from the X3DH handshake
 *      (via QR code exchange).
 *   2. QueueID - each message has a deterministic QueueID derived from the
 *      ratchet state, used as the PDS record key and AppView lookup key.
 *   3. No separate message key ratchet - only chain keys and root keys.
 *
 * Crypto parameters (see constants.ts):
 *   KDF_RK: HKDF-SHA256(salt=rootKey, ikm=dhOut, info="DME-RK", len=64)
 *           -> first 32 bytes = new rootKey, last 32 bytes = new chainKey
 *   KDF_CK: HMAC-SHA256(key=chainKey, 0x01) -> messageKey
 *           HMAC-SHA256(key=chainKey, 0x02) -> nextChainKey
 *   ENCRYPT: AES-256-GCM(key=messageKey, nonce=random12, aad=headerBytes)
 *   QueueID: SHA-256("DME-QueueID-v1" || dhPub || msgNum || chainKey)
 *   MKSKIPPED_MAX: 1000 (max cached skipped message keys)
 */

import { x25519 } from '@noble/curves/ed25519';
import { gcm } from '@noble/ciphers/aes';
import { hkdf } from '@noble/hashes/hkdf';
import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha256';
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils';

import {
  GCM_NONCE_LENGTH,
  KDF_CK_MESSAGE_KEY,
  KDF_CK_NEXT_CHAIN_KEY,
  KDF_RK_INFO,
  KEY_LENGTH,
  MKSKIPPED_MAX,
} from './constants';
import { deriveQueueId } from './queue-id';

/**
 * Header prepended to every ratcheted message. Carries the DH public key
 * and message numbers needed by the receiver to locate the correct chain.
 */
export interface RatchetHeader {
  /** Sender's current DH ratchet public key (32 bytes). */
  dhPub: Uint8Array;
  /** Number of messages in the previous chain (0 if first chain). */
  prevCount: number;
  /** Sequence number of this message within the current chain. */
  messageNum: number;
}

/**
 * Internal state of the Double Ratchet. Serialized to AsyncStorage via
 * DoubleRatchet.serialize().
 */
export interface RatchetState {
  dhSelfPriv: Uint8Array;
  dhSelfPub: Uint8Array;
  dhRemotePub: Uint8Array | null;
  rootKey: Uint8Array;
  sendChainKey: Uint8Array | null;
  recvChainKey: Uint8Array | null;
  sendCount: number;
  recvCount: number;
  prevSendCount: number;
  skippedKeys: Map<string, Uint8Array>;
  firstSendQueueId: string | null;
}

/**
 * Result of encrypt(): the header, ciphertext, and QueueID.
 */
export interface EncryptResult {
  header: RatchetHeader;
  ciphertext: Uint8Array;
  nonce: Uint8Array;
  queueId: string;
}

/**
 * JSON-safe representation of RatchetState for serialization.
 * Uint8Arrays are stored as base64 strings; Map as array of pairs.
 */
interface SerializedState {
  dhSelfPriv: string;
  dhSelfPub: string;
  dhRemotePub: string | null;
  rootKey: string;
  sendChainKey: string | null;
  recvChainKey: string | null;
  sendCount: number;
  recvCount: number;
  prevSendCount: number;
  skippedKeys: [string, string][];
  firstSendQueueId: string | null;
}

// ---------------------------------------------------------------------------
// KDF helper functions
// ---------------------------------------------------------------------------

/**
 * KDF_RK: Derive new root key and chain key from a DH output.
 *
 * Uses HKDF-SHA256 with the current root key as salt, the DH shared
 * secret as input keying material, and "DME-RK" as info.
 * Produces 64 bytes: first 32 = new root key, last 32 = new chain key.
 *
 * @param rootKey - Current root key (32 bytes, used as HKDF salt).
 * @param dhOut   - X25519 shared secret from DH ratchet step (32 bytes).
 * @returns Tuple of [newRootKey, newChainKey], each 32 bytes.
 */
function kdfRk(
  rootKey: Uint8Array,
  dhOut: Uint8Array,
): [Uint8Array, Uint8Array] {
  const okm = hkdf(sha256, dhOut, rootKey, utf8ToBytes(KDF_RK_INFO), KEY_LENGTH * 2);
  return [okm.slice(0, KEY_LENGTH), okm.slice(KEY_LENGTH)];
}

/**
 * KDF_CK: Derive message key and next chain key from the current chain key.
 *
 * Uses HMAC-SHA256 with the chain key as the HMAC key:
 *   messageKey  = HMAC-SHA256(chainKey, 0x01)
 *   nextChainKey = HMAC-SHA256(chainKey, 0x02)
 *
 * @param chainKey - Current chain key (32 bytes).
 * @returns Tuple of [messageKey, nextChainKey], each 32 bytes.
 */
function kdfCk(
  chainKey: Uint8Array,
): [Uint8Array, Uint8Array] {
  const messageKey = hmac(sha256, chainKey, KDF_CK_MESSAGE_KEY);
  const nextChainKey = hmac(sha256, chainKey, KDF_CK_NEXT_CHAIN_KEY);
  return [messageKey, nextChainKey];
}

/**
 * Serialize a RatchetHeader to bytes for use as AES-GCM AAD.
 *
 * Format: dhPub (32 bytes) || prevCount (uint32 LE) || messageNum (uint32 LE)
 */
function headerToBytes(header: RatchetHeader): Uint8Array {
  const prevCountBytes = new Uint8Array(4);
  const msgNumBytes = new Uint8Array(4);
  // Write as little-endian uint32
  new DataView(prevCountBytes.buffer).setUint32(0, header.prevCount, true);
  new DataView(msgNumBytes.buffer).setUint32(0, header.messageNum, true);
  return concatBytes(header.dhPub, prevCountBytes, msgNumBytes);
}

// ---------------------------------------------------------------------------
// Serialization helpers
// ---------------------------------------------------------------------------

/** Convert Uint8Array to base64 string for JSON serialization. */
function bytesToB64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

/** Convert base64 string back to Uint8Array. */
function b64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Convert a Uint8Array to a lowercase hex string. Local copy (same as
 * queue-id.ts) for skippedKeys cache keys: `${hex(dhPub)}:${messageNum}`.
 */
function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i]!.toString(16).padStart(2, '0');
  }
  return hex;
}

/**
 * Non-constant-time Uint8Array equality. Safe only for public DH keys
 * (NOT secret material); used to detect a new DH ratchet public key.
 */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// DoubleRatchet class
// ---------------------------------------------------------------------------

/**
 * Double Ratchet state machine for a single conversation.
 *
 * One instance per conversation partner. After initialization (via
 * initSender or initReceiver), call encrypt/decrypt for each message.
 * Persist the state via serialize() after every operation.
 */
export class DoubleRatchet {
  private state: RatchetState;

  private constructor(state: RatchetState) {
    this.state = state;
  }

  static initSender(
    sharedSecret: Uint8Array,
    selfPriv: Uint8Array,
    remotePub: Uint8Array,
    firstSendQueueId?: string,
  ): DoubleRatchet {
    const dhSelfPriv = selfPriv;
    const dhSelfPub = x25519.getPublicKey(selfPriv);
    const dhOut = x25519.getSharedSecret(selfPriv, remotePub);
    const [rootKey1, sendChainKey] = kdfRk(sharedSecret, dhOut);
    const [rootKey, recvChainKey] = kdfRk(rootKey1, dhOut);

    const state: RatchetState = {
      dhSelfPriv,
      dhSelfPub,
      dhRemotePub: remotePub,
      rootKey,
      sendChainKey,
      recvChainKey,
      sendCount: 0,
      recvCount: 0,
      prevSendCount: 0,
      skippedKeys: new Map(),
      firstSendQueueId: firstSendQueueId ?? null,
    };

    return new DoubleRatchet(state);
  }

  static initReceiver(
    sharedSecret: Uint8Array,
    selfPriv: Uint8Array,
    firstSendQueueId?: string,
  ): DoubleRatchet {
    const dhSelfPub = x25519.getPublicKey(selfPriv);
    const rootKey = sharedSecret;

    const state: RatchetState = {
      dhSelfPriv: selfPriv,
      dhSelfPub,
      dhRemotePub: null,
      rootKey,
      sendChainKey: null,
      recvChainKey: null,
      sendCount: 0,
      recvCount: 0,
      prevSendCount: 0,
      skippedKeys: new Map(),
      firstSendQueueId: firstSendQueueId ?? null,
    };

    return new DoubleRatchet(state);
  }

  /**
   * Encrypt a plaintext message.
   *
   * Flow:
   *   1. If sendChainKey is null, perform a DH ratchet step:
   *      - Generate new DH key pair
   *      - dhOut = X25519(dhSelfPriv, dhRemotePub)
   *      - { rootKey, sendChainKey } = KDF_RK(rootKey, dhOut)
   *   2. Derive queueId from current state (before KDF_CK)
   *   3. { messageKey, sendChainKey } = KDF_CK(sendChainKey)
   *   4. header = { dhPub, prevCount, messageNum: sendCount }
   *   5. nonce = random(12)
   *   6. ciphertext = AES-256-GCM(messageKey, nonce, headerBytes)
   *   7. sendCount++
   *
   * @param plaintext - Message content as raw bytes.
   * @returns Header, ciphertext, and QueueID.
   */
  encrypt(plaintext: Uint8Array): EncryptResult {
    if (!this.state.sendChainKey) {
      if (!this.state.dhRemotePub) {
        throw new Error('DoubleRatchet.encrypt: dhRemotePub is null, cannot perform DH ratchet');
      }
      const dhOut = x25519.getSharedSecret(this.state.dhSelfPriv, this.state.dhRemotePub);
      const [newRoot, newChain] = kdfRk(this.state.rootKey, dhOut);
      this.state.prevSendCount = this.state.sendCount;
      this.state.sendCount = 0;
      this.state.rootKey = newRoot;
      this.state.sendChainKey = newChain;
    }

    const queueId = this.state.firstSendQueueId ?? deriveQueueId(
      this.state.dhSelfPub,
      this.state.sendCount,
      this.state.sendChainKey,
    );
    this.state.firstSendQueueId = null;

    // Derive message key and advance chain key
    const [messageKey, nextChainKey] = kdfCk(this.state.sendChainKey);
    this.state.sendChainKey = nextChainKey;

    // Build header
    const header: RatchetHeader = {
      dhPub: this.state.dhSelfPub,
      prevCount: this.state.prevSendCount,
      messageNum: this.state.sendCount,
    };

    // Generate random nonce
    const nonce = crypto.getRandomValues(new Uint8Array(GCM_NONCE_LENGTH));

    // Encrypt: AES-256-GCM with header as AAD
    const aad = headerToBytes(header);
    const cipher = gcm(messageKey, nonce, aad);
    const ciphertext = cipher.encrypt(plaintext);

    // Advance counter
    this.state.sendCount++;

    return { header, ciphertext, nonce, queueId };
  }

  /**
   * Decrypt a ciphertext message.
   *
   * Flow:
   *   1. Check skippedKeys cache for this (dhPub, messageNum) pair
   *   2. If header.dhPub is new (DH ratchet trigger):
   *      - Skip any missing messages in the old receiving chain
   *      - Generate new DH key pair
   *      - dhOut = X25519(dhSelfPriv, header.dhPub)
   *      - { rootKey, recvChainKey } = KDF_RK(rootKey, dhOut)
   *      - Reset counters
   *   3. { messageKey, recvChainKey } = KDF_CK(recvChainKey)
   *   4. plaintext = AES-256-GCM-decrypt(messageKey, nonce, headerBytes, ciphertext)
   *   5. recvCount++
   *
   * @param header     - Ratchet header from the sender.
   * @param ciphertext - Encrypted message bytes (includes GCM tag).
   * @param nonce      - AES-GCM nonce (12 bytes, sent alongside ciphertext).
   * @returns Decrypted plaintext bytes.
   */
  decrypt(header: RatchetHeader, ciphertext: Uint8Array, nonce: Uint8Array): Uint8Array {
    // 1. Skipped-keys cache: a message keyed under a previously-skipped
    //    (dhPub, messageNum) is decrypted with the cached message key
    //    WITHOUT advancing any chain state. This is the out-of-order path.
    const skipKey = `${bytesToHex(header.dhPub)}:${header.messageNum}`;
    const cachedMessageKey = this.state.skippedKeys.get(skipKey);
    if (cachedMessageKey) {
      this.state.skippedKeys.delete(skipKey);
      const aad = headerToBytes(header);
      const plaintext = gcm(cachedMessageKey, nonce, aad).decrypt(ciphertext);
      return plaintext;
    }

    // 2. DH ratchet trigger: header carries a DH pub we don't recognise
    //    (either a brand-new remote key, or dhRemotePub is null for the
    //    very first received message).
    const isNewRemotePub = this.state.dhRemotePub === null
      || !bytesEqual(this.state.dhRemotePub, header.dhPub);
    if (isNewRemotePub) {
      if (this.state.recvChainKey !== null && this.state.dhRemotePub !== null) {
        let chainKey = this.state.recvChainKey;
        const oldRemotePub = this.state.dhRemotePub;
        for (let n = this.state.recvCount; n < header.prevCount; n++) {
          if (this.state.skippedKeys.size >= MKSKIPPED_MAX) {
            throw new Error('DoubleRatchet.decrypt: skippedKeys cache full (MKSKIPPED_MAX exceeded)');
          }
          const [skippedMsgKey, nextChain] = kdfCk(chainKey);
          this.state.skippedKeys.set(`${bytesToHex(oldRemotePub)}:${n}`, skippedMsgKey);
          chainKey = nextChain;
        }
        this.state.recvChainKey = chainKey;
      }

      this.state.prevSendCount = this.state.sendCount;
      this.state.dhRemotePub = header.dhPub;

      const dhRecv = x25519.getSharedSecret(this.state.dhSelfPriv, header.dhPub);
      [this.state.rootKey, this.state.recvChainKey] = kdfRk(this.state.rootKey, dhRecv);

      if (!this.state.sendChainKey) {
        const dhSend = x25519.getSharedSecret(this.state.dhSelfPriv, header.dhPub);
        [this.state.rootKey, this.state.sendChainKey] = kdfRk(this.state.rootKey, dhSend);
      }

      this.state.recvCount = 0;
    }

    if (!this.state.recvChainKey || !this.state.dhRemotePub) {
      throw new Error('DoubleRatchet.decrypt: recvChainKey or dhRemotePub is null after DH ratchet step');
    }

    // 3. Skip ahead in the CURRENT receiving chain: cache message keys
    //    for any messages between recvCount and header.messageNum so
    //    out-of-order delivery within the same chain decrypts later.
    //    Mirrors Signal RatchetDecrypt's second skip_message_keys call.
    {
      let chainKey = this.state.recvChainKey;
      const currentRemotePub = this.state.dhRemotePub;
      while (this.state.recvCount < header.messageNum) {
        if (this.state.skippedKeys.size >= MKSKIPPED_MAX) {
          throw new Error('DoubleRatchet.decrypt: skippedKeys cache full (MKSKIPPED_MAX exceeded)');
        }
        const [skippedMsgKey, nextChain] = kdfCk(chainKey);
        this.state.skippedKeys.set(
          `${bytesToHex(currentRemotePub)}:${this.state.recvCount}`,
          skippedMsgKey,
        );
        chainKey = nextChain;
        this.state.recvCount++;
      }
      this.state.recvChainKey = chainKey;
    }

    // 4. Final chain step: derive this message's key, advance, decrypt.
    const [messageKey, nextChainKey] = kdfCk(this.state.recvChainKey);
    this.state.recvChainKey = nextChainKey;

    const aad = headerToBytes(header);
    const plaintext = gcm(messageKey, nonce, aad).decrypt(ciphertext);

    this.state.recvCount++;

    return plaintext;
  }

  /**
   * Predict the next QueueID without encrypting.
   *
   * The receiver calls this to know which QueueID to poll for.
   * Does not advance the ratchet state.
   *
   * @returns The QueueID that the next encrypt() will produce.
   */
  nextQueueId(): string {
    if (!this.state.sendChainKey) {
      throw new Error('DoubleRatchet.nextQueueId: sendChainKey is null');
    }
    return deriveQueueId(
      this.state.dhSelfPub,
      this.state.sendCount,
      this.state.sendChainKey,
    );
  }

  /**
   * Predict the next INCOMING QueueID for polling.
   *
   * The receiver calls this to know which QueueID to poll for. Uses the
   * receiving chain state (dhRemotePub, recvCount, recvChainKey) which
   * mirrors the sender's sending chain after a DH ratchet step.
   *
   * @returns The QueueID that the remote party's next encrypt() will produce.
   * @throws if the receiving chain is not yet initialized (no message received).
   */
  nextRecvQueueId(): string {
    if (!this.state.recvChainKey || !this.state.dhRemotePub) {
      throw new Error('DoubleRatchet.nextRecvQueueId: recvChainKey or dhRemotePub is null');
    }
    return deriveQueueId(
      this.state.dhRemotePub,
      this.state.recvCount,
      this.state.recvChainKey,
    );
  }

  /**
   * Whether the receiving chain is initialized (ready to predict incoming
   * QueueIDs). False until the first DH ratchet on decrypt.
   */
  get isRecvReady(): boolean {
    return this.state.recvChainKey !== null && this.state.dhRemotePub !== null;
  }

  get canSend(): boolean {
    return this.state.sendChainKey !== null;
  }

  /**
   * Serialize the ratchet state to a JSON string for AsyncStorage storage.
   *
   * Uint8Arrays are converted to base64; the skippedKeys Map becomes
   * an array of [key, value] pairs.
   *
   * @returns JSON string.
   */
  serialize(): string {
    const s = this.state;
    const serialized: SerializedState = {
      dhSelfPriv: bytesToB64(s.dhSelfPriv),
      dhSelfPub: bytesToB64(s.dhSelfPub),
      dhRemotePub: s.dhRemotePub ? bytesToB64(s.dhRemotePub) : null,
      rootKey: bytesToB64(s.rootKey),
      sendChainKey: s.sendChainKey ? bytesToB64(s.sendChainKey) : null,
      recvChainKey: s.recvChainKey ? bytesToB64(s.recvChainKey) : null,
      sendCount: s.sendCount,
      recvCount: s.recvCount,
      prevSendCount: s.prevSendCount,
      skippedKeys: Array.from(s.skippedKeys.entries()).map(
        ([k, v]) => [k, bytesToB64(v)] as [string, string],
      ),
      firstSendQueueId: s.firstSendQueueId,
    };
    return JSON.stringify(serialized);
  }

  /**
   * Deserialize a ratchet state from a JSON string.
   *
   * @param json - JSON string from serialize().
   * @returns A new DoubleRatchet instance.
   */
  static deserialize(json: string): DoubleRatchet {
    const s = JSON.parse(json) as SerializedState;
    const skippedKeys = new Map<string, Uint8Array>();
    for (const [k, v] of s.skippedKeys) {
      skippedKeys.set(k, b64ToBytes(v));
    }
    const state: RatchetState = {
      dhSelfPriv: b64ToBytes(s.dhSelfPriv),
      dhSelfPub: b64ToBytes(s.dhSelfPub),
      dhRemotePub: s.dhRemotePub ? b64ToBytes(s.dhRemotePub) : null,
      rootKey: b64ToBytes(s.rootKey),
      sendChainKey: s.sendChainKey ? b64ToBytes(s.sendChainKey) : null,
      recvChainKey: s.recvChainKey ? b64ToBytes(s.recvChainKey) : null,
      sendCount: s.sendCount,
      recvCount: s.recvCount,
      prevSendCount: s.prevSendCount,
      skippedKeys,
      firstSendQueueId: s.firstSendQueueId ?? null,
    };
    return new DoubleRatchet(state);
  }

  /**
   * Get the number of cached skipped message keys.
   * Useful for debugging and enforcing MKSKIPPED_MAX.
   */
  get skippedKeysCount(): number {
    return this.state.skippedKeys.size;
  }

  /**
   * Check if the skipped keys cache has reached its maximum size.
   * If so, new skipped keys should be rejected (DoS protection).
   */
  get isSkippedKeysFull(): boolean {
    return this.state.skippedKeys.size >= MKSKIPPED_MAX;
  }
}
