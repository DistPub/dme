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
      } else if (existing.epoch === 0) {
        // 过期备份锁（epoch 恒为 0，不推进任何会话）→ 崩溃残留：抢占并
        // 沿用其序号。备份锁释放失败/进程崩溃只剩这一种残留形态
        console.warn('[dme:claim] preempting crashed backup lock, seq', existing.seq);
        nextSeq = existing.seq;
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

// ---------------------------------------------------------------------------
// 手动备份锁（约定：任何备份点都必须先遵守宣言）
//
// 手动备份没有前置 commit 动作，但它把「本机当前状态」写进云端备份——
// 若本机已落后（PDS 高水位更高），手动备份会用旧状态覆盖新备份，制造
// 备份分叉。因此手动备份同样必须先过宣言仲裁：
//   - 高水位高于本地且新鲜（另一端正在/刚完成 commit）→ busy，稍后再试；
//   - 高水位高于本地且已过期（另一端早已推进、本端长期未同步）→ stale，
//     必须先恢复最新备份，绝不允许上传可能过期的状态；
//   - 通过 → 持锁备份：锁会挡住备份窗口内兄弟端的 commit（否则兄弟端
//     提交+自动备份落在前面，本端更旧的快照后上传仍会覆盖）。
//
// 备份本身不推进账号状态，所以与 commit 宣言不同：
//   - 锁的 epoch 固定为 0（不引用任何会话，崩溃残留判别见
//     acquireRotationClaim 的 epoch===0 分支）；
//   - 释放时不是删除记录，而是恢复占用前的记录内容——兄弟端 commit
//     留下的高水位必须原样保留，绝不能被备份锁抹掉。
// ---------------------------------------------------------------------------

/** 备份锁句柄：占用前的高水位记录内容 + 本锁 nonce，供释放时恢复。 */
export interface BackupLockHandle {
  readonly params: RotationClaimParams;
  readonly nonce: string;
  /** 占用前 PDS 上的记录密文（高水位宣言或旧备份锁），null 表示原本为空。 */
  readonly previousPayload: string | null;
}

export type BackupLockVerdict = 'acquired' | 'busy' | 'stale';

export type BackupLockOutcome =
  | { readonly verdict: 'acquired'; readonly handle: BackupLockHandle }
  | { readonly verdict: 'busy' | 'stale'; readonly seq: number };

/**
 * 占用手动备份锁。PDS 不可用/读取失败时抛出（fail-closed）——无法仲裁
 * 时宁可不备份，也不上传可能已过期的状态。
 */
export async function acquireBackupLock(
  params: RotationClaimParams,
  localSeq: number,
  store: RotationClaimStore,
): Promise<BackupLockOutcome> {
  const previousPayload = await store.get(params.rkey);
  const existing = previousPayload === null ? null : decryptClaim(params.encKey, previousPayload);

  if (existing && existing.seq > localSeq) {
    const age = Date.now() - Date.parse(existing.createdAt);
    const fresh = Number.isFinite(age) && age < ROTATION_CLAIM_TTL_MS;
    if (fresh) {
      // 另一端正在 commit（或其高水位刚落盘）：本端状态可能马上过时，
      // 稍后再试（对方完成并同步后高水位会与本地追平）
      return { verdict: 'busy', seq: existing.seq };
    }
    // 过期且高水位仍高于本地：另一端早已推进、本端长期未同步（wrapper
    // 可能已超 7 天 TTL 丢失）。即使是崩溃残留，对备份来说结论也一样——
    // 本机状态可疑，必须先恢复最新备份（fail-closed，可恢复）。
    return { verdict: 'stale', seq: existing.seq };
  }

  // seq <= localSeq（一致或残留旧锁）→ 允许备份，持锁挡窗
  const nonce = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
  await store.put(
    params.rkey,
    encryptClaim(params.encKey, {
      seq: localSeq + 1, // 仅作为互斥信号；释放时恢复原记录，不保留
      groupId: 'backup',
      epoch: 0,
      nonce,
      createdAt: new Date().toISOString(),
    }),
  );

  // putRecord 无原子 CAS：回读比对 nonce，压缩并发双写窗口
  const verify = await readClaim(params, store);
  if (!verify || verify.nonce !== nonce) {
    // 并发落败：无法安全持锁，按 busy 处理（原记录可能已被改写，也无法恢复）
    return { verdict: 'busy', seq: verify?.seq ?? localSeq + 1 };
  }
  return { verdict: 'acquired', handle: { params, nonce, previousPayload } };
}

/**
 * 释放手动备份锁：仅当 PDS 记录仍是本锁（nonce 一致）时恢复占用前的
 * 内容；若已被改写（兄弟端趁隙 commit 落了新高水位）则原样保留。
 * 尽力而为，绝不删除——删除会抹掉兄弟端 commit 的高水位。
 */
export async function releaseBackupLock(
  handle: BackupLockHandle,
  store: RotationClaimStore,
): Promise<void> {
  try {
    const currentPayload = await store.get(handle.params.rkey);
    if (currentPayload === null) return; // 已被外力删除，无可恢复
    const current = decryptClaim(handle.params.encKey, currentPayload);
    if (!current || current.nonce !== handle.nonce) return; // 已易主，保留现状
    if (handle.previousPayload === null) {
      await store.del(handle.params.rkey);
    } else {
      await store.put(handle.params.rkey, handle.previousPayload);
    }
  } catch {
    // 释放失败最坏后果：锁记录 TTL 后过期，epoch=0 被判别为崩溃残留抢占
  }
}
