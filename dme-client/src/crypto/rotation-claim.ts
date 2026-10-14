/**
 * crypto/rotation-claim.ts - 密钥轮换宣言 v2：账号级单调 commit 计数高水位。
 *
 * v1（用完即删的并发锁）缺陷：a 端 commit 完删除宣言，b 端来查查不到 →
 * 也 commit → 同会话跨端分叉，且永无感知（2026-10-14 用户拍板改为 v2）。
 *
 * v2 设计：宣言 = 账号 commit 高水位（seq 单调递增，commit 成功后保留不删）：
 *   - rkey/encKey 从身份签名公钥稳定派生——账号级恒定、全端可推导、不随
 *     epoch 变（v1 从 exporterSecret 派生，epoch 换代槽位即废，历史计数
 *     无法保留，这正是 v1 只能"用完即删"的根源）；
 *   - 本地维护 commitSeq（随备份走），commit 前主动读 PDS 比对：
 *       PDS seq == 本地 seq → 本端最新，允许 commit（写 seq+1，保留）；
 *       PDS seq  > 本地 seq → 其他端已推进：
 *         同会话且宣言 epoch <= 本端 epoch → 崩溃残留（声称 seq 高但会话
 *           未推进），允许抢占（写 existing.seq）；
 *         宣言新鲜（age < TTL）→ taken：对端正在/刚完成，静默跳过本周期，
 *           其 wrapper 经正常 poll 走 sibling-rotated 路径；
 *         宣言过期（age >= TTL）→ stale：对端早已完成而本端长期未同步
 *           （wrapper 可能已超 7 天 TTL 丢失 = 静默失败场景），明确提示
 *           恢复备份；
 *       PDS seq  < 本地 seq → 异常（本地不可能超前），fail-closed taken；
 *   - putRecord 无原子 CAS（last-write-wins）：写后回读比 nonce，把并发
 *     双写窗口压到一个网络往返；
 *   - commit 成功后宣言保留（高水位），仅投递失败回滚 / commit 失败时
 *     release 删除，避免虚高水位。
 *
 * 恢复完整重放的两大前提之一（用户拍板）：备份点足够新（所有影响解密
 * 的变更都联动备份）+ 备份不分叉（本机制检测：seq 高水位暴露任何端的
 * 任何 commit，落后端无法假装最新）。
 */

import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { gcm } from '@noble/ciphers/aes';
import { utf8ToBytes } from '@noble/hashes/utils';
import { bytesToBase64url, base64urlToBytes, bytesToHex } from './utils';
import {
  ROTATION_CLAIM_ENC_KEY_LENGTH,
  ROTATION_CLAIM_LABEL,
  ROTATION_CLAIM_RKEY_LENGTH,
} from './mls-config';

/** 宣言有效期：超过视为崩溃残留/已完成很久，其他端按 stale 处理。 */
export const ROTATION_CLAIM_TTL_MS = 10 * 60 * 1000;

/** GCM nonce 长度（字节）。 */
const CLAIM_NONCE_LENGTH = 12;

/** 宣言派生参数（由身份签名公钥稳定派生，账号级恒定，全端一致）。 */
export interface RotationClaimParams {
  /** PDS 记录 rkey（base64url，atproto rkey 字符集兼容）。 */
  rkey: string;
  /** 宣言内容 AES-256-GCM 密钥。 */
  encKey: Uint8Array;
}

/** 宣言明文内容（加密前）。 */
export interface RotationClaim {
  /**
   * 账号级 commit 高水位（v2 核心）：每次成功 commit 单调 +1，保留不删。
   * 旧格式（v1）无此字段 → 按可抢占处理。
   */
  seq: number;
  groupId: string;
  epoch: number;
  /** 写入端随机数，用于 putRecord 回读防并发双写。 */
  nonce: string;
  /** 写入时刻（ISO），用于 TTL 判定。 */
  createdAt: string;
}

/** PDS 记录读写抽象（AppContext 用 DmePds 组装）。 */
export interface RotationClaimStore {
  /** 读宣言密文；记录不存在返回 null。网络等未知错误应 throw（fail-closed）。 */
  get(rkey: string): Promise<string | null>;
  /** 写入/覆盖宣言密文（upsert）。 */
  put(rkey: string, payload: string): Promise<void>;
  /** 删除宣言记录（尽力而为）。 */
  del(rkey: string): Promise<void>;
}

/**
 * 从身份签名公钥稳定派生宣言槽位参数。账号级恒定：所有设备推导一致，
 * 不随会话 epoch 变化（v2 高水位必须跨换代保留，这是与 v1 的本质区别）。
 */
export async function deriveRotationClaimParams(
  identitySigningPublicKey: Uint8Array,
): Promise<RotationClaimParams> {
  const material = hkdf(
    sha256,
    identitySigningPublicKey,
    undefined,
    utf8ToBytes(ROTATION_CLAIM_LABEL),
    32,
  );
  const rkey = hkdf(
    sha256,
    material,
    undefined,
    utf8ToBytes('rkey'),
    ROTATION_CLAIM_RKEY_LENGTH,
  );
  const encKey = hkdf(
    sha256,
    material,
    undefined,
    utf8ToBytes('enc'),
    ROTATION_CLAIM_ENC_KEY_LENGTH,
  );
  return { rkey: bytesToBase64url(rkey), encKey };
}

function encryptClaim(encKey: Uint8Array, claim: RotationClaim): string {
  const iv = crypto.getRandomValues(new Uint8Array(CLAIM_NONCE_LENGTH));
  const ciphertext = gcm(encKey, iv).encrypt(utf8ToBytes(JSON.stringify(claim)));
  const out = new Uint8Array(CLAIM_NONCE_LENGTH + ciphertext.length);
  out.set(iv, 0);
  out.set(ciphertext, CLAIM_NONCE_LENGTH);
  return bytesToBase64url(out);
}

function decryptClaim(encKey: Uint8Array, payload: string): RotationClaim | null {
  try {
    const data = base64urlToBytes(payload);
    if (data.length <= CLAIM_NONCE_LENGTH) return null;
    const iv = data.slice(0, CLAIM_NONCE_LENGTH);
    const ciphertext = data.slice(CLAIM_NONCE_LENGTH);
    const plaintext = gcm(encKey, iv).decrypt(ciphertext);
    const parsed = JSON.parse(new TextDecoder().decode(plaintext)) as Partial<RotationClaim>;
    // v1 旧格式无 seq → 归一化为 -1（按可抢占处理）
    return { ...parsed, seq: typeof parsed.seq === 'number' ? parsed.seq : -1 } as RotationClaim;
  } catch {
    // 解不开（外部写入/记录损坏）→ 视为陈旧槽位，由调用方抢占
    return null;
  }
}

async function readClaim(
  params: RotationClaimParams,
  store: RotationClaimStore,
): Promise<RotationClaim | null> {
  const payload = await store.get(params.rkey);
  if (payload === null) return null;
  return decryptClaim(params.encKey, payload);
}

/** 只读 peek：读取当前高水位 seq（供兄弟端 commit 应用成功后追平本地计数）。 */
export async function peekCommitSeq(
  params: RotationClaimParams,
  store: RotationClaimStore,
): Promise<number | null> {
  const claim = await readClaim(params, store);
  if (!claim || claim.seq < 0) return null;
  return claim.seq;
}

/**
 * 认领判定结果：
 * - acquired：本端拿到执行权，seq 为应写入的高水位（commit 成功后保留宣言）；
 * - taken：另一端已认领 / 并发落败 / 本地异常超前 → 静默跳过本周期；
 * - stale：PDS 高水位高于本地且宣言已过期 → 本端长期落后（备份分叉），
 *   调用方必须提示恢复备份，绝不允许 commit。
 */
export type RotationClaimVerdict = 'acquired' | 'taken' | 'stale';

export interface RotationClaimOutcome {
  verdict: RotationClaimVerdict;
  seq: number;
}

/**
 * v2 认领：账号级单调 commit 高水位仲裁。PDS 不可用时抛出——调用方必须
 * fail-closed（跳过本周期），绝不在无仲裁的情况下 commit。
 *
 * @param claim.localSeq 本地 commitSeq（随备份走）；backupSeq 用于崩溃残留判别。
 */
export async function acquireRotationClaim(
  params: RotationClaimParams,
  claim: { groupId: string; epoch: number; localSeq: number },
  store: RotationClaimStore,
): Promise<RotationClaimOutcome> {
  const existing = await readClaim(params, store);

  let nextSeq = claim.localSeq + 1;

  if (existing) {
    const age = Date.now() - Date.parse(existing.createdAt);
    const fresh = Number.isFinite(age) && age < ROTATION_CLAIM_TTL_MS;

    if (existing.seq > claim.localSeq) {
      if (existing.groupId === claim.groupId && existing.epoch <= claim.epoch) {
        // 同会话且对端 epoch 没超前 → 崩溃残留（声称 seq 高但会话未推进）。
        // 抢占并沿用其序号：真实完成的 commit 数就是 existing.seq
        console.warn('[dme:claim] preempting crashed claim residue, seq', existing.seq);
        nextSeq = existing.seq;
      } else if (fresh) {
        // 对端正在/刚完成 commit：静默跳过，其 wrapper 经 poll 走 sibling 路径
        return { verdict: 'taken', seq: existing.seq };
      } else {
        // 宣言已过期且 seq 仍高于本地 → 对端早已完成、本端长期未同步
        //（wrapper 可能已超 7 天 TTL 丢失）→ 备份分叉，提示恢复备份
        return { verdict: 'stale', seq: existing.seq };
      }
    } else if (existing.seq === claim.localSeq) {
      // 本端与云端一致，最新 → 允许 commit
    } else {
      // existing.seq < localSeq：本地不可能超前（本地 commit 必写宣言）→ 异常
      return { verdict: 'taken', seq: existing.seq };
    }
  }

  const nonce = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
  await store.put(
    params.rkey,
    encryptClaim(params.encKey, {
      seq: nextSeq,
      groupId: claim.groupId,
      epoch: claim.epoch,
      nonce,
      createdAt: new Date().toISOString(),
    }),
  );

  // putRecord 无原子 CAS（last-write-wins）：回读比对 nonce，
  // 把并发双写窗口从「poll 间隔」压缩到一个网络往返
  const verify = await readClaim(params, store);
  if (!verify || verify.nonce !== nonce) return { verdict: 'taken', seq: nextSeq };
  return { verdict: 'acquired', seq: nextSeq };
}

/**
 * 释放宣言：仅在 commit 失败/投递失败回滚时调用（避免虚高水位）。
 * commit 成功后宣言保留为账号高水位，绝不删除。
 */
export async function releaseRotationClaim(
  params: RotationClaimParams,
  store: RotationClaimStore,
): Promise<void> {
  try {
    await store.del(params.rkey);
  } catch {
    // 删除失败无碍：崩溃残留由「同会话 epoch 未超前」判别 + TTL 兜底
  }
}
