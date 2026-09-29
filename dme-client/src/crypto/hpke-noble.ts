/**
 * crypto/hpke-noble.ts - Pure-JS HPKE (RFC 9180) implementation for dme-client.
 *
 * Replaces ts-mls's default HPKE stack (which uses WebCrypto via @hpke/core)
 * with a fully JavaScript implementation based on @noble/curves, @noble/hashes,
 * and @noble/ciphers. This guarantees compatibility on iOS Safari where
 * WebCrypto Ed25519 / X25519 support is incomplete or missing (iOS < 17.4).
 *
 * This implementation is byte-for-byte aligned with the miniapp version and
 * the original @hpke/core behavior for:
 *   - DHKEM-X25519-HKDF-SHA256 (KEM id 0x0020)
 *   - HKDF-SHA256 (KDF id 0x0001)
 *   - AES-128-GCM (AEAD id 0x0001)
 *   - HPKE base mode (mode 0x00, no PSK)
 */

import { x25519 } from '@noble/curves/ed25519';
import { gcm } from '@noble/ciphers/aes';
import { sha256 } from '@noble/hashes/sha2';
import { hmac } from '@noble/hashes/hmac';
import { expand as hkdfExpand } from '@noble/hashes/hkdf';
import type { Hpke } from 'ts-mls';

// ---------------------------------------------------------------------------
// RFC 9180 constants for DHKEM-X25519 + HKDF-SHA256 + AES-128-GCM
// ---------------------------------------------------------------------------

const HPKE_VERSION = new Uint8Array([0x48, 0x50, 0x4b, 0x45, 0x2d, 0x76, 0x31]);
const SUITE_ID_KEM = new Uint8Array([0x4b, 0x45, 0x4d, 0x00, 0x20]);
const SUITE_ID_HPKE = new Uint8Array([
  0x48, 0x50, 0x4b, 0x45, 0x00, 0x20, 0x00, 0x01, 0x00, 0x01,
]);

const LABEL_EAE_PRK = utf8('eae_prk');
const LABEL_SHARED_SECRET = utf8('shared_secret');
const LABEL_PSK_ID_HASH = utf8('psk_id_hash');
const LABEL_INFO_HASH = utf8('info_hash');
const LABEL_SECRET = utf8('secret');
const LABEL_KEY = utf8('key');
const LABEL_BASE_NONCE = utf8('base_nonce');
const LABEL_EXP = utf8('exp');
const LABEL_SEC = utf8('sec');
const LABEL_DKP_PRK = utf8('dkp_prk');
const LABEL_SK = utf8('sk');

const MODE_BASE = 0x00;
const HASH_SIZE = 32;
const AEAD_KEY_SIZE = 16;
const AEAD_NONCE_SIZE = 12;
const N_SECRET = 32;

/** ts-mls types keys as CryptoKey, but we use raw Uint8Array bytes throughout. */
type HpkeKey = Uint8Array;

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function i2osp2(n: number): Uint8Array {
  return new Uint8Array([(n >> 8) & 0xff, n & 0xff]);
}

function extract(salt: Uint8Array, ikm: Uint8Array): Uint8Array {
  const realSalt = salt.length === 0 ? new Uint8Array(HASH_SIZE) : salt;
  return hmac(sha256, realSalt, ikm);
}

function expand(prk: Uint8Array, info: Uint8Array, len: number): Uint8Array {
  return hkdfExpand(sha256, prk, info, len);
}

function extractAndExpand(
  salt: Uint8Array,
  ikm: Uint8Array,
  info: Uint8Array,
  len: number,
): Uint8Array {
  return expand(extract(salt, ikm), info, len);
}

function buildLabeledIkm(
  suiteId: Uint8Array,
  label: Uint8Array,
  ikm: Uint8Array,
): Uint8Array {
  return concat(HPKE_VERSION, suiteId, label, ikm);
}

function buildLabeledInfo(
  suiteId: Uint8Array,
  label: Uint8Array,
  info: Uint8Array,
  len: number,
): Uint8Array {
  return concat(i2osp2(len), HPKE_VERSION, suiteId, label, info);
}

function labeledExtractKdf(salt: Uint8Array, label: Uint8Array, ikm: Uint8Array): Uint8Array {
  return extract(salt, buildLabeledIkm(SUITE_ID_HPKE, label, ikm));
}

function labeledExpandKdf(
  prk: Uint8Array,
  label: Uint8Array,
  info: Uint8Array,
  len: number,
): Uint8Array {
  return expand(prk, buildLabeledInfo(SUITE_ID_HPKE, label, info, len), len);
}

function labeledExtractKem(label: Uint8Array, ikm: Uint8Array): Uint8Array {
  return extract(new Uint8Array(0), buildLabeledIkm(SUITE_ID_KEM, label, ikm));
}

function labeledExpandKem(
  prk: Uint8Array,
  label: Uint8Array,
  info: Uint8Array,
  len: number,
): Uint8Array {
  return expand(prk, buildLabeledInfo(SUITE_ID_KEM, label, info, len), len);
}

function deriveKeyPairFromIkm(ikm: Uint8Array): { privateKey: HpkeKey; publicKey: HpkeKey } {
  const dkpPrk = labeledExtractKem(LABEL_DKP_PRK, ikm);
  const sk = labeledExpandKem(dkpPrk, LABEL_SK, new Uint8Array(0), 32);
  return { privateKey: sk, publicKey: x25519.getPublicKey(sk) };
}

function dh(privateKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
  return x25519.getSharedSecret(privateKey, publicKey);
}

function generateSharedSecret(dhResult: Uint8Array, kemContext: Uint8Array): Uint8Array {
  const labeledIkm = buildLabeledIkm(SUITE_ID_KEM, LABEL_EAE_PRK, dhResult);
  const labeledInfo = buildLabeledInfo(SUITE_ID_KEM, LABEL_SHARED_SECRET, kemContext, N_SECRET);
  return extractAndExpand(new Uint8Array(0), labeledIkm, labeledInfo, N_SECRET);
}

function aeadEncrypt(
  key: Uint8Array,
  nonce: Uint8Array,
  aad: Uint8Array,
  plaintext: Uint8Array,
): Uint8Array {
  return gcm(key, nonce, aad).encrypt(plaintext);
}

function aeadDecrypt(
  key: Uint8Array,
  nonce: Uint8Array,
  aad: Uint8Array,
  ciphertext: Uint8Array,
): Uint8Array {
  return gcm(key, nonce, aad).decrypt(ciphertext);
}

interface KeyScheduleResult {
  exporterSecret: Uint8Array;
  key: Uint8Array;
  baseNonce: Uint8Array;
}

function keySchedule(sharedSecret: Uint8Array, info: Uint8Array): KeyScheduleResult {
  const pskIdHash = labeledExtractKdf(new Uint8Array(0), LABEL_PSK_ID_HASH, new Uint8Array(0));
  const infoHash = labeledExtractKdf(new Uint8Array(0), LABEL_INFO_HASH, info);
  const keyScheduleContext = concat(new Uint8Array([MODE_BASE]), pskIdHash, infoHash);

  const ikm = buildLabeledIkm(SUITE_ID_HPKE, LABEL_SECRET, new Uint8Array(0));

  const exporterSecret = extractAndExpand(
    sharedSecret,
    ikm,
    buildLabeledInfo(SUITE_ID_HPKE, LABEL_EXP, keyScheduleContext, HASH_SIZE),
    HASH_SIZE,
  );
  const key = extractAndExpand(
    sharedSecret,
    ikm,
    buildLabeledInfo(SUITE_ID_HPKE, LABEL_KEY, keyScheduleContext, AEAD_KEY_SIZE),
    AEAD_KEY_SIZE,
  );
  const baseNonce = extractAndExpand(
    sharedSecret,
    ikm,
    buildLabeledInfo(SUITE_ID_HPKE, LABEL_BASE_NONCE, keyScheduleContext, AEAD_NONCE_SIZE),
    AEAD_NONCE_SIZE,
  );

  return { exporterSecret, key, baseNonce };
}

// ---------------------------------------------------------------------------
// ts-mls Hpke interface
// ---------------------------------------------------------------------------

/** Construct a pure-JS ts-mls `Hpke` implementation for the fixed DME suite. */
export function createNobleHpke(): Hpke {
  return {
    keyLength: AEAD_KEY_SIZE,
    nonceLength: AEAD_NONCE_SIZE,

    async importPrivateKey(k: Uint8Array): Promise<never> {
      return k as never;
    },
    async importPublicKey(k: Uint8Array): Promise<never> {
      return k as never;
    },
    async exportPublicKey(k: never): Promise<Uint8Array> {
      return k as unknown as Uint8Array;
    },
    async exportPrivateKey(k: never): Promise<Uint8Array> {
      return k as unknown as Uint8Array;
    },

    async deriveKeyPair(ikm: Uint8Array): Promise<{ privateKey: never; publicKey: never }> {
      const kp = deriveKeyPairFromIkm(ikm);
      return { privateKey: kp.privateKey as never, publicKey: kp.publicKey as never };
    },
    async generateKeyPair(): Promise<{ privateKey: never; publicKey: never }> {
      const sk = crypto.getRandomValues(new Uint8Array(32));
      return {
        privateKey: sk as never,
        publicKey: x25519.getPublicKey(sk) as never,
      };
    },

    async encryptAead(
      key: Uint8Array,
      nonce: Uint8Array,
      aad: Uint8Array | undefined,
      plaintext: Uint8Array,
    ): Promise<Uint8Array> {
      return aeadEncrypt(key, nonce, aad ?? new Uint8Array(0), plaintext);
    },
    async decryptAead(
      key: Uint8Array,
      nonce: Uint8Array,
      aad: Uint8Array | undefined,
      ciphertext: Uint8Array,
    ): Promise<Uint8Array> {
      return aeadDecrypt(key, nonce, aad ?? new Uint8Array(0), ciphertext);
    },

    async seal(
      publicKey: never,
      plaintext: Uint8Array,
      info: Uint8Array,
      aad?: Uint8Array,
    ): Promise<{ ct: Uint8Array; enc: Uint8Array }> {
      const recipientPk = publicKey as unknown as Uint8Array;
      const ephSk = crypto.getRandomValues(new Uint8Array(32));
      const ephPk = x25519.getPublicKey(ephSk);
      const dhResult = dh(ephSk, recipientPk);
      const kemContext = concat(ephPk, recipientPk);
      const sharedSecret = generateSharedSecret(dhResult, kemContext);
      const ks = keySchedule(sharedSecret, info);
      const ct = aeadEncrypt(ks.key, ks.baseNonce, aad ?? new Uint8Array(0), plaintext);
      return { ct, enc: ephPk };
    },

    async open(
      privateKey: never,
      kemOutput: Uint8Array,
      ciphertext: Uint8Array,
      info: Uint8Array,
      aad?: Uint8Array,
    ): Promise<Uint8Array> {
      const recipientSk = privateKey as unknown as Uint8Array;
      const recipientPk = x25519.getPublicKey(recipientSk);
      const ephPk = kemOutput;
      const dhResult = dh(recipientSk, ephPk);
      const kemContext = concat(ephPk, recipientPk);
      const sharedSecret = generateSharedSecret(dhResult, kemContext);
      const ks = keySchedule(sharedSecret, info);
      return aeadDecrypt(ks.key, ks.baseNonce, aad ?? new Uint8Array(0), ciphertext);
    },

    async exportSecret(
      publicKey: never,
      exporterContext: Uint8Array,
      length: number,
      info: Uint8Array,
    ): Promise<{ enc: Uint8Array; secret: Uint8Array }> {
      const recipientPk = publicKey as unknown as Uint8Array;
      const ephSk = crypto.getRandomValues(new Uint8Array(32));
      const ephPk = x25519.getPublicKey(ephSk);
      const dhResult = dh(ephSk, recipientPk);
      const kemContext = concat(ephPk, recipientPk);
      const sharedSecret = generateSharedSecret(dhResult, kemContext);
      const ks = keySchedule(sharedSecret, info);
      const secret = labeledExpandKdf(ks.exporterSecret, LABEL_SEC, exporterContext, length);
      return { enc: ephPk, secret };
    },

    async importSecret(
      privateKey: never,
      exporterContext: Uint8Array,
      kemOutput: Uint8Array,
      length: number,
      info: Uint8Array,
    ): Promise<Uint8Array> {
      const recipientSk = privateKey as unknown as Uint8Array;
      const recipientPk = x25519.getPublicKey(recipientSk);
      const ephPk = kemOutput;
      const dhResult = dh(recipientSk, ephPk);
      const kemContext = concat(ephPk, recipientPk);
      const sharedSecret = generateSharedSecret(dhResult, kemContext);
      const ks = keySchedule(sharedSecret, info);
      return labeledExpandKdf(ks.exporterSecret, LABEL_SEC, exporterContext, length);
    },
  } as unknown as Hpke;
}
