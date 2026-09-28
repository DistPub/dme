/**
 * crypto/keypackage.ts - MLS KeyPackage generation, encryption, and
 * serialization.
 *
 * KeyPackages are NOT stored on the PDS. They are exchanged point-to-
 * point via QR code, encrypted with the recipient's X25519 public key
 * (from their DID document #dme_encryption).
 *
 * Flow:
 *   Alice: generateKeyPackageForUser -> encryptKeyPackage(Bob's X25519 pub)
 *   -> put ciphertext in QR code
 *   Bob:   scan QR -> deserializeEncryptedKeyPackage -> decryptKeyPackage
 *   -> use KeyPackage to Add(Alice) to MLS group
 */

import {
  decodeMlsMessage,
  defaultCapabilities,
  defaultLifetime,
  encodeMlsMessage,
  generateKeyPackageWithKey,
  type KeyPackage,
  type PrivateKeyPackage,
} from 'ts-mls';
import { x25519 } from '@noble/curves/ed25519';
import { gcm } from '@noble/ciphers/aes';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { utf8ToBytes } from '@noble/hashes/utils';

import { createDidCredential } from './mls-credential';
import { getNobleMlsImpl } from './mls-noble-kdf';

/** X25519 public key length. */
const X25519_KEY_LENGTH = 32;
/** AES-GCM nonce length. */
const GCM_NONCE_LENGTH = 12;
/** HKDF salt for KeyPackage encryption (domain separation). */
const KP_HKDF_SALT = 'dme-keypackage-v1';
/** HKDF info for KeyPackage encryption key derivation. */
const KP_HKDF_INFO = 'keypackage-encryption';

/** A public + private KeyPackage pair. */
export interface KeyPackagePair {
  publicPackage: KeyPackage;
  privatePackage: PrivateKeyPackage;
}

/** Encrypted KeyPackage ready for QR encoding. */
export interface EncryptedKeyPackage {
  ephemeralPublicKey: Uint8Array;
  ciphertext: Uint8Array;
}

/**
 * Generate a new KeyPackage pair for the current user.
 *
 * Uses the user's persistent Ed25519 signing key. A fresh HPKE (X25519)
 * key pair is generated internally for each KeyPackage.
 *
 * @param did                 - User's DID.
 * @param signingPrivateKey   - Ed25519 signing private key (32 bytes).
 * @param signingPublicKey    - Ed25519 signing public key (32 bytes).
 * @returns Public + private KeyPackage pair.
 */
export async function generateKeyPackageForUser(
  did: string,
  signingPrivateKey: Uint8Array,
  signingPublicKey: Uint8Array,
): Promise<KeyPackagePair> {
  const impl = await getNobleMlsImpl();
  const credential = createDidCredential(did);
  return generateKeyPackageWithKey(
    credential,
    defaultCapabilities(),
    defaultLifetime,
    [],
    { signKey: signingPrivateKey, publicKey: signingPublicKey },
    impl,
  );
}

/**
 * Encrypt a KeyPackage for a specific recipient using their X25519
 * public key.
 *
 * Uses X25519 ECDH to derive a shared secret, then HKDF-SHA256 to derive
 * an AES-256-GCM key. The ciphertext includes the nonce prefix.
 *
 * @param keyPackage             - KeyPackage to encrypt (wire-encoded first).
 * @param recipientX25519PublicKey - Recipient's X25519 public key (32 bytes).
 * @returns Ephemeral X25519 public key + ciphertext (nonce || encrypted).
 */
export async function encryptKeyPackage(
  keyPackage: KeyPackage,
  recipientX25519PublicKey: Uint8Array,
): Promise<EncryptedKeyPackage> {
  const plaintext = encodeKeyPackageToWire(keyPackage);

  const ephPriv = x25519.utils.randomPrivateKey();
  const ephPub = x25519.getPublicKey(ephPriv);
  const sharedSecret = x25519.getSharedSecret(ephPriv, recipientX25519PublicKey);

  const key = hkdf(
    sha256,
    sharedSecret,
    utf8ToBytes(KP_HKDF_SALT),
    utf8ToBytes(KP_HKDF_INFO),
    32,
  );

  const nonce = crypto.getRandomValues(new Uint8Array(GCM_NONCE_LENGTH));
  const encrypted = gcm(key, nonce).encrypt(plaintext);

  const ciphertext = new Uint8Array(nonce.length + encrypted.length);
  ciphertext.set(nonce, 0);
  ciphertext.set(encrypted, nonce.length);

  return { ephemeralPublicKey: ephPub, ciphertext };
}

/**
 * Decrypt a KeyPackage using the user's X25519 private key.
 *
 * @param ephemeralPublicKey  - Ephemeral X25519 public key from the sender.
 * @param ciphertext          - Nonce || encrypted KeyPackage wire bytes.
 * @param ownX25519PrivateKey - Our X25519 private key (32 bytes).
 * @returns Decoded KeyPackage.
 */
export async function decryptKeyPackage(
  ephemeralPublicKey: Uint8Array,
  ciphertext: Uint8Array,
  ownX25519PrivateKey: Uint8Array,
): Promise<KeyPackage> {
  const sharedSecret = x25519.getSharedSecret(
    ownX25519PrivateKey,
    ephemeralPublicKey,
  );

  const key = hkdf(
    sha256,
    sharedSecret,
    utf8ToBytes(KP_HKDF_SALT),
    utf8ToBytes(KP_HKDF_INFO),
    32,
  );

  const nonce = ciphertext.slice(0, GCM_NONCE_LENGTH);
  const encrypted = ciphertext.slice(GCM_NONCE_LENGTH);
  const plaintext = gcm(key, nonce).decrypt(encrypted);

  return decodeKeyPackageFromWire(plaintext);
}

/**
 * Serialize an encrypted KeyPackage to a single byte array for QR encoding.
 *
 * Format: ephemeralPublicKey[32] || ciphertext
 */
export function serializeEncryptedKeyPackage(
  ephemeralPublicKey: Uint8Array,
  ciphertext: Uint8Array,
): Uint8Array {
  const result = new Uint8Array(ephemeralPublicKey.length + ciphertext.length);
  result.set(ephemeralPublicKey, 0);
  result.set(ciphertext, ephemeralPublicKey.length);
  return result;
}

/**
 * Deserialize an encrypted KeyPackage from a byte array (QR content).
 *
 * @returns Ephemeral public key (first 32 bytes) + ciphertext (remainder).
 * @throws if data is too short.
 */
export function deserializeEncryptedKeyPackage(data: Uint8Array): EncryptedKeyPackage {
  if (data.length < X25519_KEY_LENGTH + GCM_NONCE_LENGTH) {
    throw new Error(
      `keypackage: serialized data too short (${data.length} bytes, need at least ${X25519_KEY_LENGTH + GCM_NONCE_LENGTH})`,
    );
  }
  return {
    ephemeralPublicKey: data.slice(0, X25519_KEY_LENGTH),
    ciphertext: data.slice(X25519_KEY_LENGTH),
  };
}

/**
 * Encode a KeyPackage to MLS wire format.
 */
export function encodeKeyPackageToWire(kp: KeyPackage): Uint8Array {
  return encodeMlsMessage({
    keyPackage: kp,
    wireformat: 'mls_key_package',
    version: 'mls10',
  });
}

/**
 * Decode a KeyPackage from MLS wire format.
 *
 * @throws if the data is not a valid MLS key package message.
 */
export function decodeKeyPackageFromWire(data: Uint8Array): KeyPackage {
  const result = decodeMlsMessage(data, 0);
  if (!result) {
    throw new Error('keypackage: failed to decode MLS message');
  }
  const [msg] = result;
  if (msg.wireformat !== 'mls_key_package') {
    throw new Error(
      `keypackage: expected mls_key_package, got ${msg.wireformat}`,
    );
  }
  return msg.keyPackage;
}
