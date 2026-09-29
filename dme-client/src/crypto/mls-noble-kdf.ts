/**
 * crypto/mls-noble-kdf.ts - Pure-JS CiphersuiteImpl assembly for dme-client.
 *
 * ts-mls's `nobleCryptoProvider` only replaces *some* primitives with pure-JS
 * helpers, but its Ed25519 signature implementation still prefers
 * `globalThis.crypto.subtle.importKey("pkcs8", ..., "Ed25519")` when subtle is
 * present, and its DHKEM-X25519 KEM is backed by @hpke/core which uses
 * WebCrypto X25519. Both fail on iOS Safari versions before Ed25519/X25519
 * WebCrypto support (iOS < 17.4).
 *
 * This file assembles the full CiphersuiteImpl by hand, with zero dependency
 * on WebCrypto `subtle` and zero call into `nobleCryptoProvider` /
 * `defaultCryptoProvider` / `getCiphersuiteImpl()`. All five fields are pure JS:
 *
 *   hash      -> @noble/hashes (sha256 + hmac)
 *   kdf       -> @noble/hashes/hkdf
 *   signature -> @noble/curves/ed25519
 *   hpke      -> ./hpke-noble.ts (DHKEM-X25519/HKDF-SHA256/AES-128-GCM)
 *   rng       -> ./rng.ts
 *
 * This mirrors the miniapp implementation and is byte-compatible with it.
 */

import { sha256, sha384, sha512 } from '@noble/hashes/sha2';
import { hmac } from '@noble/hashes/hmac';
import type { CHash } from '@noble/hashes/utils';
import { extract, expand } from '@noble/hashes/hkdf';
import { ed25519 } from '@noble/curves/ed25519';
import type {
  CiphersuiteImpl,
  Hash,
  HashAlgorithm,
  Kdf,
  Signature,
} from 'ts-mls';
import { MLS_CIPHERSUITE_NAME } from './mls-config';
import { createNobleHpke } from './hpke-noble';
import { nobleRng } from './rng';

// ---------------------------------------------------------------------------
// KDF: HKDF-SHA256 (pure JS)
// ---------------------------------------------------------------------------

/** ts-mls-compatible pure-JS HKDF-SHA256. */
export const nobleHkdfSha256: Kdf = {
  async extract(salt: Uint8Array, ikm: Uint8Array): Promise<Uint8Array> {
    // @noble/hashes signature: extract(hash, ikm, salt). Empty salt must be
    // undefined so noble uses the zero IV internally.
    return extract(sha256, ikm, salt.length === 0 ? undefined : salt);
  },

  async expand(prk: Uint8Array, info: Uint8Array, len: number): Promise<Uint8Array> {
    return expand(sha256, prk, info, len);
  },

  size: 32,
};

// ---------------------------------------------------------------------------
// Hash: SHA-256 digest + HMAC + constant-time compare (pure JS)
// ---------------------------------------------------------------------------

const HASH_FNS: Record<HashAlgorithm, CHash> = {
  'SHA-256': sha256,
  'SHA-384': sha384,
  'SHA-512': sha512,
};

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  const len = a.length > b.length ? a.length : b.length;
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}

/** Build a ts-mls `Hash` implementation backed by @noble/hashes. */
export function createNobleHash(h: HashAlgorithm): Hash {
  const fn = HASH_FNS[h];
  if (!fn) throw new Error(`dme: unsupported hash algorithm ${h}`);
  return {
    async digest(data: Uint8Array): Promise<Uint8Array> {
      return fn(data);
    },
    async mac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
      return hmac(fn, key, data);
    },
    async verifyMac(key: Uint8Array, mac: Uint8Array, data: Uint8Array): Promise<boolean> {
      return constantTimeEqual(mac, hmac(fn, key, data));
    },
  };
}

// ---------------------------------------------------------------------------
// Signature: Ed25519 (pure JS, no subtle probing)
// ---------------------------------------------------------------------------

/** Build a ts-mls `Signature` implementation backed by @noble/curves. */
export function createNobleSignature(): Signature {
  return {
    async sign(signKey: Uint8Array, message: Uint8Array): Promise<Uint8Array> {
      // @noble/curves uses sign(message, secretKey).
      return ed25519.sign(message, signKey);
    },
    async verify(
      publicKey: Uint8Array,
      message: Uint8Array,
      signature: Uint8Array,
    ): Promise<boolean> {
      return ed25519.verify(signature, message, publicKey);
    },
    async keygen(): Promise<{ publicKey: Uint8Array; signKey: Uint8Array }> {
      const signKey = ed25519.utils.randomSecretKey();
      return { signKey, publicKey: ed25519.getPublicKey(signKey) };
    },
  };
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

let cachedImpl: CiphersuiteImpl | null = null;

/**
 * Return the single pure-JS CiphersuiteImpl used everywhere in dme-client.
 *
 * Never calls into `nobleCryptoProvider` / `getCiphersuiteImpl()`, because
 * those internally instantiate @hpke/core classes that rely on WebCrypto.
 */
export async function getNobleMlsImpl(): Promise<CiphersuiteImpl> {
  if (cachedImpl) return cachedImpl;

  cachedImpl = {
    hash: createNobleHash('SHA-256'),
    kdf: nobleHkdfSha256,
    signature: createNobleSignature(),
    hpke: createNobleHpke(),
    rng: nobleRng,
    name: MLS_CIPHERSUITE_NAME,
  } as CiphersuiteImpl;

  return cachedImpl;
}
