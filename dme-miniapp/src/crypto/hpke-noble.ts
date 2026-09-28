/**
 * crypto/hpke-noble.ts - 纯 JS HPKE（RFC 9180）实现，替换 ts-mls 的 WebCrypto 版本。
 *
 * 【为什么需要】
 * ts-mls 的 `nobleCryptoProvider` 里，除 KDF 之外的 HPKE（KEM=DHKEM-X25519）
 * 仍走 @hpke/core，而 @hpke/core 的 X25519 原语继承 `NativeAlgorithm`，
 * 全部依赖 `globalThis.crypto.subtle`（importKey / deriveBits / generateKey / exportKey）。
 * 微信小程序运行时**没有 WebCrypto** → MLS 建群 / Welcome / 消息加解密会崩溃。
 *
 * 【本文件做什么】
 * 用 @noble/curves（x25519）+ @noble/hashes（hkdf/hmac/sha256）+ @noble/ciphers（gcm）
 * 实现 ts-mls `Hpke` 接口所需的全部能力。由于 DME 固定使用
 * `MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519`（cipher suite 1），
 * 且 ts-mls 只用 HPKE base mode，这里只实现这一个组合（出口函数 `createNobleHpke()`）。
 *
 * 【与 @hpke 的字节级对齐要点】（逐行核对 @hpke/core + @hpke/common 源码得出）
 *   - suite_id（KEM）= "KEM" || kem_id(0x0020, 2字节大端)      → 6 字节
 *   - suite_id（HPKE）= "HPKE" || kem_id || kdf_id || aead_id  → 10 字节
 *   - labeledExtract(salt, label, ikm) = HKDF-Extract(salt, "HPKE-v1" || suite_id || label || ikm)
 *   - labeledExpand(prk, label, info, len) = HKDF-Expand(prk, I2OSP(len,2) || "HPKE-v1" || suite_id || label || info, len)
 *   - KEM shared secret = labeledExtractAndExpand(EMPTY, "eae_prk", dh, "shared_secret" || kem_context)
 *       其中 extractAndExpand 等价于 HKDF(salt=dh, ikm=labeledIkm, info=labeledInfo, len)
 *   - key schedule（base mode: mode=0x00, psk=EMPTY, psk_id=EMPTY）
 *       psk_id_hash = labeledExtract(EMPTY, "psk_id_hash", EMPTY)
 *       info_hash   = labeledExtract(EMPTY, "info_hash", info)
 *       ks_context  = mode || psk_id_hash || info_hash
 *       ikm         = labeledIkm("secret", EMPTY)
 *       exporter_secret = extractAndExpand(dh, ikm, labeledInfo("exp", ks_context, 32), 32)
 *       key             = extractAndExpand(dh, ikm, labeledInfo("key", ks_context, 16), 16)
 *       base_nonce      = extractAndExpand(dh, ikm, labeledInfo("base_nonce", ks_context, 12), 12)
 *   - AEAD: AES-128-GCM，nonce = base_nonce XOR I2OSP(seq, 12)，AAD 可为空
 *   - exporter: labeledExpand(exporter_secret, "sec", exporter_context, len)
 *
 * 任一字节不一致都会导致与 web 端握手失败（Phase 5 是验错点）。
 */

import { x25519 } from '@noble/curves/ed25519';
import { gcm } from '@noble/ciphers/aes';
import { sha256 } from '@noble/hashes/sha256';
import { hmac } from '@noble/hashes/hmac';
import { expand as hkdfExpand } from '@noble/hashes/hkdf';
import type { Hpke } from 'ts-mls';

// ---------------------------------------------------------------------------
// 常量（RFC 9180 §7.1 / §7.2 / §7.3）
// ---------------------------------------------------------------------------

/** HPKE version label: "HPKE-v1"（7 字节，注意中间的连字符 0x2d）。 */
const HPKE_VERSION = new Uint8Array([0x48, 0x50, 0x4b, 0x45, 0x2d, 0x76, 0x31]);

/** KEM suite id: "KEM" || I2OSP(0x0020, 2)（共 5 字节）。 */
const SUITE_ID_KEM = new Uint8Array([0x4b, 0x45, 0x4d, 0x00, 0x20]);

/** HPKE suite id: "HPKE" || I2OSP(0x0020,2) || I2OSP(0x0001,2) || I2OSP(0x0001,2)（共 10 字节）。 */
const SUITE_ID_HPKE = new Uint8Array([
  0x48, 0x50, 0x4b, 0x45, 0x00, 0x20, 0x00, 0x01, 0x00, 0x01,
]);

const LABEL_EAE_PRK = new Uint8Array([101, 97, 101, 95, 112, 114, 107]); // "eae_prk"
const LABEL_SHARED_SECRET = new Uint8Array([
  115, 104, 97, 114, 101, 100, 95, 115, 101, 99, 114, 101, 116, // "shared_secret"
]);
const LABEL_PSK_ID_HASH = new Uint8Array([
  112, 115, 107, 95, 105, 100, 95, 104, 97, 115, 104, // "psk_id_hash"
]);
const LABEL_INFO_HASH = new Uint8Array([105, 110, 102, 111, 95, 104, 97, 115, 104]); // "info_hash"
const LABEL_SECRET = new Uint8Array([115, 101, 99, 114, 101, 116]); // "secret"
const LABEL_KEY = new Uint8Array([107, 101, 121]); // "key"
const LABEL_BASE_NONCE = new Uint8Array([
  98, 97, 115, 101, 95, 110, 111, 110, 99, 101, // "base_nonce"
]);
const LABEL_EXP = new Uint8Array([101, 120, 112]); // "exp"
const LABEL_SEC = new Uint8Array([115, 101, 99]); // "sec"

/** HPKE base mode。 */
const MODE_BASE = 0x00;

const HASH_SIZE = 32; // SHA-256
const AEAD_KEY_SIZE = 16; // AES-128
const AEAD_NONCE_SIZE = 12;
const N_SECRET = 32;

/** ts-mls 的密钥用 CryptoKey 类型标注，这里实际是裸字节；用该类型别名兼容签名。 */
type HpkeKey = Uint8Array;

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

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

/** I2OSP(n, 2) 大端 2 字节。 */
function i2osp2(n: number): Uint8Array {
  return new Uint8Array([(n >> 8) & 0xff, n & 0xff]);
}

/** HKDF-Extract（salt 为空时按 RFC 用全零 hashSize 字节）。 */
function extract(salt: Uint8Array, ikm: Uint8Array): Uint8Array {
  const realSalt = salt.length === 0 ? new Uint8Array(HASH_SIZE) : salt;
  return hmac(sha256, realSalt, ikm);
}

/** HKDF-Expand（prk 必须是已 extract 的伪随机密钥）。 */
function expand(prk: Uint8Array, info: Uint8Array, len: number): Uint8Array {
  return hkdfExpand(sha256, prk, info, len);
}

/** HKDF(salt, ikm, info, len) —— 对齐 @hpke 的 extractAndExpand（等价 extract→expand）。 */
function extractAndExpand(
  salt: Uint8Array,
  ikm: Uint8Array,
  info: Uint8Array,
  len: number,
): Uint8Array {
  return expand(extract(salt, ikm), info, len);
}

/** labeledIkm: "HPKE-v1" || suiteId || label || ikm。 */
function buildLabeledIkm(suiteId: Uint8Array, label: Uint8Array, ikm: Uint8Array): Uint8Array {
  return concat(HPKE_VERSION, suiteId, label, ikm);
}

/** labeledInfo: I2OSP(len,2) || "HPKE-v1" || suiteId || label || info。 */
function buildLabeledInfo(
  suiteId: Uint8Array,
  label: Uint8Array,
  info: Uint8Array,
  len: number,
): Uint8Array {
  return concat(i2osp2(len), HPKE_VERSION, suiteId, label, info);
}

/** labeledExtract（此处用于 HPKE suite）。 */
function labeledExtractKdf(salt: Uint8Array, label: Uint8Array, ikm: Uint8Array): Uint8Array {
  return extract(salt, buildLabeledIkm(SUITE_ID_HPKE, label, ikm));
}

/** labeledExpand（此处用于 HPKE suite）。 */
function labeledExpandKdf(
  prk: Uint8Array,
  label: Uint8Array,
  info: Uint8Array,
  len: number,
): Uint8Array {
  return expand(prk, buildLabeledInfo(SUITE_ID_HPKE, label, info, len), len);
}

/** 从字节数组派生 X25519 密钥对（对齐 @hpke 的 DeriveKeyPair）。 */
function deriveKeyPairFromIkm(ikm: Uint8Array): { privateKey: HpkeKey; publicKey: HpkeKey } {
  const dkpPrk = labeledExtractKem(LABEL_DKP_PRK, ikm);
  const sk = labeledExpandKem(dkpPrk, LABEL_SK, new Uint8Array(0), 32);
  return {
    privateKey: sk,
    publicKey: x25519.getPublicKey(sk),
  };
}

const LABEL_DKP_PRK = new Uint8Array([100, 107, 112, 95, 112, 114, 107]); // "dkp_prk"
const LABEL_SK = new Uint8Array([115, 107]); // "sk"

/** KEM 层的 labeledExtract。 */
function labeledExtractKem(label: Uint8Array, ikm: Uint8Array): Uint8Array {
  return extract(new Uint8Array(0), buildLabeledIkm(SUITE_ID_KEM, label, ikm));
}

/** KEM 层的 labeledExpand。 */
function labeledExpandKem(
  prk: Uint8Array,
  label: Uint8Array,
  info: Uint8Array,
  len: number,
): Uint8Array {
  return expand(prk, buildLabeledInfo(SUITE_ID_KEM, label, info, len), len);
}

/** DH：X25519(sk, pk) —— @noble 的 getSharedSecret 会做 clamping 与坐标检查，与 WebCrypto 一致。 */
function dh(privateKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
  return x25519.getSharedSecret(privateKey, publicKey);
}

/** KEM 共享密钥计算（base mode，无 senderKey）。 */
function generateSharedSecret(dhResult: Uint8Array, kemContext: Uint8Array): Uint8Array {
  const labeledIkm = buildLabeledIkm(SUITE_ID_KEM, LABEL_EAE_PRK, dhResult);
  const labeledInfo = buildLabeledInfo(SUITE_ID_KEM, LABEL_SHARED_SECRET, kemContext, N_SECRET);
  return extractAndExpand(new Uint8Array(0), labeledIkm, labeledInfo, N_SECRET);
}

/** AEAD 加密。 */
function aeadEncrypt(
  key: Uint8Array,
  nonce: Uint8Array,
  aad: Uint8Array,
  plaintext: Uint8Array,
): Uint8Array {
  return gcm(key, nonce, aad).encrypt(plaintext);
}

/** AEAD 解密。 */
function aeadDecrypt(
  key: Uint8Array,
  nonce: Uint8Array,
  aad: Uint8Array,
  ciphertext: Uint8Array,
): Uint8Array {
  return gcm(key, nonce, aad).decrypt(ciphertext);
}

/** nonce = base_nonce XOR I2OSP(seq, Nn)。 */
function computeNonce(baseNonce: Uint8Array, seq: number): Uint8Array {
  const out = new Uint8Array(baseNonce.length);
  out.set(baseNonce);
  const seqBytes = new Uint8Array(12);
  let v = seq;
  for (let i = 11; i >= 0 && v > 0; i--) {
    seqBytes[i] = v & 0xff;
    v = Math.floor(v / 256);
  }
  for (let i = 0; i < out.length; i++) out[i] ^= seqBytes[i];
  return out;
}

/** key schedule 结果。 */
interface KeyScheduleResult {
  exporterSecret: Uint8Array;
  key: Uint8Array;
  baseNonce: Uint8Array;
}

/** HPKE base mode key schedule（无 psk / psk_id）。 */
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
// ts-mls Hpke 接口实现
// ---------------------------------------------------------------------------

/**
 * 构造纯 JS 的 ts-mls `Hpke` 实现（仅 DHKEM-X25519 + HKDF-SHA256 + AES-128-GCM，base mode）。
 */
export function createNobleHpke(): Hpke {
  return {
    keyLength: AEAD_KEY_SIZE,
    nonceLength: AEAD_NONCE_SIZE,

    // --- 密钥导入导出（裸字节透传） ---
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

    // --- 密钥派生 ---
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

    // --- 直接 AEAD（ts-mls 的 encryptAead/decryptAead 接口） ---
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

    // --- 单次封装 / 解封装（base mode） ---
    async seal(
      publicKey: never,
      plaintext: Uint8Array,
      info: Uint8Array,
      aad?: Uint8Array,
    ): Promise<{ ct: Uint8Array; enc: Uint8Array }> {
      const recipientPk = publicKey as unknown as Uint8Array;
      // encap：生成临时密钥对，执行 DH
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
      const ephPk = kemOutput; // enc
      const dhResult = dh(recipientSk, ephPk);
      const kemContext = concat(ephPk, recipientPk);
      const sharedSecret = generateSharedSecret(dhResult, kemContext);
      const ks = keySchedule(sharedSecret, info);
      return aeadDecrypt(ks.key, ks.baseNonce, aad ?? new Uint8Array(0), ciphertext);
    },

    // --- 导出密钥（MLS exporter secret / queueId 派生依赖它） ---
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
