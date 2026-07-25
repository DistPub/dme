/**
 * crypto/envelope.ts - Message encryption/decryption + envelope construction.
 *
 * Wraps the Double Ratchet to produce DmeEnvelope records that can be
 * written to the PDS and queried from the AppView.
 *
 * The envelope payload format is:
 *   base64url(nonce[12] || ciphertext[variable] || gcmTag[16])
 *
 * The nonce is prepended to the ciphertext so the receiver can extract
 * it without a separate field in the Lexicon record.
 */

import type { DmeEnvelope } from '../protocol/index';

import { GCM_NONCE_LENGTH } from './constants';
import type { DoubleRatchet, RatchetHeader } from './ratchet';
import { gcm } from '@noble/ciphers/aes';
import { sha256 } from '@noble/hashes/sha256';
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils';

export function encryptMessage(
  ratchet: DoubleRatchet,
  plaintext: Uint8Array,
): DmeEnvelope {
  const { header, ciphertext, nonce, queueId } = ratchet.encrypt(plaintext);

  const payloadBytes = serializeEncryptedMessage(header, ciphertext, nonce);
  const payload = bytesToBase64url(payloadBytes);

  return {
    $type: 'dme.queue.envelope',
    queueId,
    payload,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Decrypt a DmeEnvelope's payload back to plaintext.
 *
 * @param ratchet - The Double Ratchet for this conversation.
 * @param env     - The received DmeEnvelope.
 * @returns Decrypted plaintext bytes.
 */
export function decryptMessage(
  ratchet: DoubleRatchet,
  env: DmeEnvelope,
): Uint8Array {
  const payloadBytes = base64urlToBytes(env.payload);
  const { header, ciphertext, nonce } = deserializeEncryptedMessage(payloadBytes);
  return ratchet.decrypt(header, ciphertext, nonce);
}

/**
 * Serialized encrypted message format:
 *   nonce[12] || dhPub[32] || prevCount[4 LE] || messageNum[4 LE] || ciphertext
 *
 * This is the binary format stored as base64url in the DmeEnvelope payload.
 */
interface SerializedEncryptedMessage {
  header: RatchetHeader;
  ciphertext: Uint8Array;
  nonce: Uint8Array;
}

/**
 * Serialize an encrypted message (header + nonce + ciphertext) into a
 * single byte array for the envelope payload.
 */
function serializeEncryptedMessage(
  header: RatchetHeader,
  ciphertext: Uint8Array,
  nonce: Uint8Array,
): Uint8Array {
  const prevCountBytes = new Uint8Array(4);
  const msgNumBytes = new Uint8Array(4);
  new DataView(prevCountBytes.buffer).setUint32(0, header.prevCount, true);
  new DataView(msgNumBytes.buffer).setUint32(0, header.messageNum, true);

  const parts = [nonce, header.dhPub, prevCountBytes, msgNumBytes, ciphertext];
  let totalLength = 0;
  for (const part of parts) {
    totalLength += part.length;
  }
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

/**
 * Deserialize an encrypted message from the envelope payload.
 */
function deserializeEncryptedMessage(
  data: Uint8Array,
): SerializedEncryptedMessage {
  let offset = 0;

  const nonce = data.slice(offset, offset + GCM_NONCE_LENGTH);
  offset += GCM_NONCE_LENGTH;

  const dhPub = data.slice(offset, offset + 32);
  offset += 32;

  const prevCount = new DataView(data.buffer, data.byteOffset + offset, 4).getUint32(0, true);
  offset += 4;

  const messageNum = new DataView(data.buffer, data.byteOffset + offset, 4).getUint32(0, true);
  offset += 4;

  const ciphertext = data.slice(offset);

  return {
    header: { dhPub, prevCount, messageNum },
    ciphertext,
    nonce,
  };
}

// ---------------------------------------------------------------------------
// base64url helpers
// ---------------------------------------------------------------------------

function bytesToBase64url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlToBytes(str: string): Uint8Array {
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// ACK encryption (uses shared secret from X3DH handshake, NOT Double Ratchet)
// ---------------------------------------------------------------------------

export function encryptAck(sharedSecret: Uint8Array, plaintext: Uint8Array): string {
  const key = sha256(concatBytes(utf8ToBytes('DME-ACK-v1'), sharedSecret));
  const nonce = crypto.getRandomValues(new Uint8Array(GCM_NONCE_LENGTH));
  const ciphertext = gcm(key, nonce).encrypt(plaintext);
  const payload = new Uint8Array(nonce.length + ciphertext.length);
  payload.set(nonce, 0);
  payload.set(ciphertext, nonce.length);
  return bytesToBase64url(payload);
}

export function decryptAck(sharedSecret: Uint8Array, payload: string): Uint8Array {
  const key = sha256(concatBytes(utf8ToBytes('DME-ACK-v1'), sharedSecret));
  const bytes = base64urlToBytes(payload);
  const nonce = bytes.slice(0, GCM_NONCE_LENGTH);
  const ciphertext = bytes.slice(GCM_NONCE_LENGTH);
  return gcm(key, nonce).decrypt(ciphertext);
}
