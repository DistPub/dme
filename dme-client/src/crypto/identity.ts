/**
 * crypto/identity.ts - X25519 identity key management.
 *
 * Each DME user has a long-term X25519 key pair. The public key is
 * published in the user's did:plc DID document under a
 * `#dme_encryption` verificationMethod so that handshake partners can
 * discover it without a separate key server.
 *
 * Why @noble/curves instead of WebCrypto?
 *   WebCrypto does not support X25519 in all browsers (Safari < 17,
 *   older Firefox). @noble/curves is a pure-JS, audited, zero-dependency
 *   implementation that works everywhere.
 *
 * The private key is stored in AsyncStorage (via DmeStorage) because
 * WebCrypto's non-extractable key mechanism is unavailable for X25519
 * in @noble. The key is stored as raw bytes.
 */

import { x25519 } from '@noble/curves/ed25519';

import { DME_ENCRYPTION_KEY_ID } from './constants';
import { x25519PubToDidKey } from './did-key';

/**
 * An X25519 identity key pair.
 *
 * The private key must never leave the device. The public key is safe
 * to share and is published in the DID document.
 */
export interface IdentityKey {
  /** X25519 private key (32 bytes). Stored as base64 in AsyncStorage via serializeIdentityKey(). */
  privateKey: Uint8Array;

  /** X25519 public key (32 bytes). Safe to share. */
  publicKey: Uint8Array;

  /** DID verificationMethod id fragment, always "#dme_encryption". */
  didKeyId: string;
}

/**
 * Serialized form of an IdentityKey for AsyncStorage storage.
 * Uint8Arrays are converted to arrays of numbers for JSON compatibility.
 */
export interface SerializedIdentityKey {
  /** Private key bytes as number array. */
  privateKey: number[];
  /** Public key bytes as number array. */
  publicKey: number[];
  /** DID verificationMethod id fragment. */
  didKeyId: string;
}

/**
 * Generate a new X25519 identity key pair.
 *
 * Uses `x25519.utils.randomPrivateKey()` which internally calls
 * `crypto.getRandomValues()` for cryptographically secure randomness.
 *
 * @returns A new IdentityKey with a random private key.
 */
export function generateIdentityKey(): IdentityKey {
  const privateKey = x25519.utils.randomPrivateKey();
  const publicKey = x25519.getPublicKey(privateKey);
  return {
    privateKey,
    publicKey,
    didKeyId: DME_ENCRYPTION_KEY_ID,
  };
}

/**
 * Export the public key as a did:key URI for inclusion in a DID
 * document's verificationMethods map.
 *
 * Uses standard X25519 multicodec (varint [0xec, 0x01]) + base58btc
 * multibase encoding, so the value round-trips through @atproto/identity
 * DID resolution into a verificationMethod's publicKeyMultibase field.
 *
 * @param key - The identity key pair.
 * @returns did:key URI, e.g. `did:key:z6LSphwcdxk3...`.
 */
export function exportPublicKeyForDid(key: IdentityKey): string {
  return x25519PubToDidKey(key.publicKey);
}

/**
 * Import a previously stored identity key from its serialized form.
 *
 * @param stored - The serialized key from AsyncStorage.
 * @returns The reconstructed IdentityKey.
 */
export function importIdentityKey(stored: SerializedIdentityKey): IdentityKey {
  return {
    privateKey: Uint8Array.from(stored.privateKey),
    publicKey: Uint8Array.from(stored.publicKey),
    didKeyId: stored.didKeyId,
  };
}

/**
 * Serialize an IdentityKey for AsyncStorage storage.
 *
 * @param key - The identity key pair.
 * @returns JSON-safe serialized form.
 */
export function serializeIdentityKey(key: IdentityKey): SerializedIdentityKey {
  return {
    privateKey: Array.from(key.privateKey),
    publicKey: Array.from(key.publicKey),
    didKeyId: key.didKeyId,
  };
}

/**
 * Compute the X25519 shared secret between a private key and a
 * remote public key. Used during the X3DH handshake.
 *
 * @param ourPrivateKey - Our X25519 private key (32 bytes).
 * @param theirPublicKey - Their X25519 public key (32 bytes).
 * @returns 32-byte shared secret.
 */
export function computeSharedSecret(
  ourPrivateKey: Uint8Array,
  theirPublicKey: Uint8Array,
): Uint8Array {
  return x25519.getSharedSecret(ourPrivateKey, theirPublicKey);
}
