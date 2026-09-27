/**
 * crypto/mls-noble-kdf.ts - 纯 JS HKDF 实现，替代 WebCrypto 版本。
 *
 * ts-mls 的 nobleCryptoProvider 仍用 @hpke/core 的 WebCrypto HKDF，
 * iOS 16 Safari 下 crypto.subtle.importKey 会返回 undefined 导致崩溃。
 * 这里用 @noble/hashes 的 hkdf 彻底规避 WebCrypto。
 */

import { hkdf, extract, expand } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha2';
import type { Kdf, CiphersuiteImpl } from 'ts-mls';
import {
  getCiphersuiteImpl,
  getCiphersuiteFromName,
  nobleCryptoProvider,
} from 'ts-mls';
import { MLS_CIPHERSUITE_NAME } from './mls-config';

/** 兼容 ts-mls CiphersuiteImpl.kdf 接口的纯 JS HKDF-SHA256 */
export const nobleHkdfSha256: Kdf = {
  /** HKDF-Extract: salt + IKM -> PRK */
  async extract(salt: Uint8Array, ikm: Uint8Array): Promise<Uint8Array> {
    // @noble/hashes: extract(hash, ikm, salt) - 参数顺序与 RFC 相反
    return extract(sha256, ikm, salt.length === 0 ? undefined : salt);
  },

  /** HKDF-Expand: PRK + info + len -> OKM */
  async expand(prk: Uint8Array, info: Uint8Array, len: number): Promise<Uint8Array> {
    return expand(sha256, prk, info, len);
  },

  /** HKDF 输出长度 (SHA-256 = 32 bytes) */
  size: 32,
};

/** 组装完整的 CiphersuiteImpl（仅替换 KDF，其余复用 nobleCryptoProvider） */
export async function getNobleMlsImpl(): Promise<CiphersuiteImpl> {
  // 先拿 nobleCryptoProvider 生成的完整 impl
  const baseImpl = await nobleCryptoProvider.getCiphersuiteImpl(
    getCiphersuiteFromName(MLS_CIPHERSUITE_NAME)
  );

  // 仅替换 kdf 为纯 JS 版本，保持 name 为字面量类型
  return {
    ...baseImpl,
    kdf: nobleHkdfSha256,
    name: MLS_CIPHERSUITE_NAME,
  } as CiphersuiteImpl;
}