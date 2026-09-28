/**
 * crypto/mls-noble-kdf.ts - 纯 JS 密码套件实现（小程序版）。
 *
 * 【为什么必须完全手工组装，而不是"复用 nobleCryptoProvider 再覆盖两个字段"】
 *
 * 早期实现是：
 *     const baseImpl = await nobleCryptoProvider.getCiphersuiteImpl(cs);
 *     return { ...baseImpl, kdf: nobleHkdfSha256, hpke: createNobleHpke() };
 *
 * 这条路在真机上必然崩溃：
 *
 *     TypeError: undefined is not a constructor (evaluating 'new Ys.HkdfSha256()')
 *     DmePoller: poll cycle error ...
 *
 * 原因（已逐行核对 node_modules/ts-mls 源码）：
 *   `nobleCryptoProvider.getCiphersuiteImpl()` 内部**同步且立即**求值
 *   `makeKdfImpl(makeKdf(cs.hpke.kdf))` 与 `await makeHpke(cs.hpke)`，而：
 *
 *     ts-mls/dist/src/crypto/implementation/default/makeKdfImpl.js:1
 *         import { HkdfSha256, HkdfSha384, HkdfSha512 } from "@hpke/core";
 *     ts-mls/dist/src/crypto/implementation/default/makeKdfImpl.js:19
 *         return new HkdfSha256();
 *     ts-mls/dist/src/crypto/implementation/default/makeDhKem.js:1
 *         import { DhkemP256HkdfSha256, ... } from "@hpke/core";
 *     ts-mls/dist/src/crypto/implementation/default/makeAead.js:1
 *         import { Aes128Gcm, Aes256Gcm } from "@hpke/core";
 *     ts-mls/dist/src/crypto/implementation/default/makeHpke.js:2
 *         import { CipherSuite } from "@hpke/core";
 *
 *   本项目在 webpack 里把 `@hpke/*` alias 成 `false`（小程序装不下 / 依赖 WebCrypto），
 *   于是这些 import 全部变成 `undefined`。`makeKdf` 是**同步函数**，
 *   在 provider 内部就被调用并抛错 —— 此时 `{ ...baseImpl }` 的覆盖**根本没机会执行**。
 *
 *   注意 `noble/makeKdfImpl.js`、`noble/makeDhKem.js`、`noble/makeAead.js` 都只是
 *   `export * from "../default/....js"` —— noble 分支并没有自己的纯 JS 实现。
 *
 * 【结论】`nobleCryptoProvider` / `defaultCryptoProvider` / `getMlsImpl()` 在本项目
 *   **一律不可用**。本文件是唯一的 CiphersuiteImpl 来源，五个字段全部手工提供：
 *
 *     hash      → @noble/hashes（sha256/sha384/sha512 + hmac + 常量时间比较）
 *     kdf       → @noble/hashes/hkdf（nobleHkdfSha256）
 *     signature → @noble/curves/ed25519（Ed25519）
 *     hpke      → ./hpke-noble.ts（自实现 RFC 9180 DHKEM-X25519/HKDF-SHA256/AES-128-GCM）
 *     rng       → ./rng.ts（wx.getRandomValues + CSPRNG 兜底）
 *
 * 全部路径不引用任何 `@hpke/*` 符号。
 *
 * 【安全约束】`signature` 绝不能走 WebCrypto：
 *   ts-mls 的 `makeNobleSignatureImpl` 会先探 `globalThis.crypto?.subtle`，探到就走
 *   WebCrypto 分支。本项目 **有意不定义 `crypto.subtle`**（详见 AGENTS.md 关键设计 §2），
 *   所以这里直接写死 noble 实现，不做任何 subtle 探测，避免将来 polyfill 改动把它带偏。
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
// KDF：HKDF-SHA256（纯 JS）
// ---------------------------------------------------------------------------

/** 兼容 ts-mls `Kdf` 接口的纯 JS HKDF-SHA256。 */
export const nobleHkdfSha256: Kdf = {
  /** HKDF-Extract: salt + IKM -> PRK */
  async extract(salt: Uint8Array, ikm: Uint8Array): Promise<Uint8Array> {
    // @noble/hashes 的签名是 extract(hash, ikm, salt)，与 RFC 9420 参数顺序相反；
    // salt 为空串时必须传 undefined，让 noble 用全零 IV 而非空输入。
    return extract(sha256, ikm, salt.length === 0 ? undefined : salt);
  },

  /** HKDF-Expand: PRK + info + len -> OKM */
  async expand(prk: Uint8Array, info: Uint8Array, len: number): Promise<Uint8Array> {
    return expand(sha256, prk, info, len);
  },

  /** HKDF 输出长度（SHA-256 = 32 字节）。 */
  size: 32,
};

// ---------------------------------------------------------------------------
// Hash：SHA-256 摘要 + HMAC + 常量时间比较（纯 JS）
// ---------------------------------------------------------------------------

const HASH_FNS: Record<HashAlgorithm, CHash> = {
  'SHA-256': sha256,
  'SHA-384': sha384,
  'SHA-512': sha512,
};

/** 常量时间比较，避免 MAC 校验泄漏时序信息。 */
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  const len = a.length > b.length ? a.length : b.length;
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}

/** 构造纯 JS 的 ts-mls `Hash` 实现（hash / mac / verifyMac）。 */
export function createNobleHash(h: HashAlgorithm): Hash {
  const fn = HASH_FNS[h];
  if (!fn) throw new Error(`dme: 不支持的 hash 算法 ${h}`);
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
// Signature：Ed25519（纯 JS，不做任何 subtle 探测）
// ---------------------------------------------------------------------------

/** 兼容 ts-mls `Signature` 接口的纯 JS Ed25519。 */
export function createNobleSignature(): Signature {
  return {
    async sign(signKey: Uint8Array, message: Uint8Array): Promise<Uint8Array> {
      // 注意参数顺序：@noble/curves 是 sign(message, secretKey)。
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
// 组装
// ---------------------------------------------------------------------------

let cachedImpl: CiphersuiteImpl | null = null;

/**
 * 组装完整的 `CiphersuiteImpl`（**唯一合法来源**）。
 *
 * 五个字段全部纯 JS 手工提供，**绝不调用** `nobleCryptoProvider` /
 * `defaultCryptoProvider` / `getCiphersuiteImpl`（它们内部会 `new HkdfSha256()`，
 * 而 `@hpke/core` 已被 alias 成 false → undefined is not a constructor）。
 *
 * 结果做单例缓存：hpke/hash/signature 都是无状态对象，复用安全。
 */
export async function getNobleMlsImpl(): Promise<CiphersuiteImpl> {
  if (cachedImpl) return cachedImpl;

  cachedImpl = {
    // SHA-256 + HMAC-SHA256（MLS cipher suite 1）
    hash: createNobleHash('SHA-256'),
    // 纯 JS HKDF-SHA256
    kdf: nobleHkdfSha256,
    // 纯 JS Ed25519
    signature: createNobleSignature(),
    // 纯 JS HPKE：DHKEM-X25519 / HKDF-SHA256 / AES-128-GCM（./hpke-noble.ts）
    hpke: createNobleHpke(),
    // wx.getRandomValues 预取缓冲 + @noble CSPRNG 兜底（./rng.ts）
    rng: nobleRng,
    name: MLS_CIPHERSUITE_NAME,
  } as CiphersuiteImpl;

  return cachedImpl;
}

// 构建后冒烟验证钩子：`node scripts/verify-artifact.mjs` 会从产物里取这个函数，
// 在模拟的「无 WebCrypto」沙箱里跑一遍 hash/kdf/hpke/signature/rng 并做 seal↔open 往返。
// 仅挂在 globalThis 上供 Node 侧读取，小程序运行时不使用，无副作用。
(globalThis as unknown as Record<string, unknown>).__dmeTestGetNobleMlsImpl = getNobleMlsImpl;
