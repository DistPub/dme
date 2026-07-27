/**
 * crypto/identity.ts - Ed25519 + X25519 identity key management.
 *
 * Each DME user has two long-term key pairs:
 *   - Ed25519 signing key  -> MLS credential signature + DID #dme_signing
 *   - X25519 encryption key -> KeyPackage QR encryption + DID #dme_encryption
 *
 * Both are published in the DID document. The signing key authenticates
 * MLS credentials; the encryption key encrypts KeyPackages in QR codes.
 *
 * Private keys are stored as base64 in AsyncStorage (via DmeStorage)
 * because @noble does not support non-extractable keys.
 */

import { ed25519, x25519 } from '@noble/curves/ed25519';

/** DID verificationMethod fragment for the X25519 encryption key. */
export const DME_ENCRYPTION_KEY_ID = '#dme_encryption' as const;

/** DID verificationMethod fragment for the Ed25519 signing key. */
export const DME_SIGNING_KEY_ID = '#dme_signing' as const;

/** A single key pair (private + public). */
interface KeyPair {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
}

/** Dual identity keys: Ed25519 for signing, X25519 for encryption. */
export interface IdentityKeys {
  /** Ed25519 signing keypair (MLS credentials, DID #dme_signing). */
  signing: KeyPair;
  /** X25519 encryption keypair (KeyPackage QR, DID #dme_encryption). */
  encryption: KeyPair;
}

/** JSON-safe representation of IdentityKeys for AsyncStorage. */
interface SerializedIdentityKeys {
  signing: { privateKey: string; publicKey: string };
  encryption: { privateKey: string; publicKey: string };
}

function bytesToB64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

function b64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Generate a new dual identity (Ed25519 signing + X25519 encryption).
 *
 * @returns New IdentityKeys with random private keys.
 */
export function generateIdentityKeys(): IdentityKeys {
  const signingPriv = ed25519.utils.randomPrivateKey();
  const signingPub = ed25519.getPublicKey(signingPriv);
  const encPriv = x25519.utils.randomPrivateKey();
  const encPub = x25519.getPublicKey(encPriv);
  return {
    signing: { privateKey: signingPriv, publicKey: signingPub },
    encryption: { privateKey: encPriv, publicKey: encPub },
  };
}

/**
 * Serialize IdentityKeys to a JSON string for AsyncStorage.
 *
 * Uint8Arrays are stored as base64 strings.
 *
 * @param keys - The identity key pairs.
 * @returns JSON string.
 */
export function exportIdentityKeys(keys: IdentityKeys): string {
  const serialized: SerializedIdentityKeys = {
    signing: {
      privateKey: bytesToB64(keys.signing.privateKey),
      publicKey: bytesToB64(keys.signing.publicKey),
    },
    encryption: {
      privateKey: bytesToB64(keys.encryption.privateKey),
      publicKey: bytesToB64(keys.encryption.publicKey),
    },
  };
  return JSON.stringify(serialized);
}

/**
 * Deserialize IdentityKeys from a JSON string.
 *
 * @param serialized - JSON string from exportIdentityKeys().
 * @returns Reconstructed IdentityKeys.
 */
export function importIdentityKeys(serialized: string): IdentityKeys {
  const s = JSON.parse(serialized) as SerializedIdentityKeys;
  return {
    signing: {
      privateKey: b64ToBytes(s.signing.privateKey),
      publicKey: b64ToBytes(s.signing.publicKey),
    },
    encryption: {
      privateKey: b64ToBytes(s.encryption.privateKey),
      publicKey: b64ToBytes(s.encryption.publicKey),
    },
  };
}

/**
 * Compute the X25519 shared secret between a private key and a remote
 * public key. Used for KeyPackage encryption in QR handshake.
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
