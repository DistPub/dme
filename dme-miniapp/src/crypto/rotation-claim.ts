/**
 * crypto/rotation-claim.ts - 密钥轮换宣言（commit 前置检查）。
 *
 * 背景：轮换 commit 的原前置检查依赖「commit 前 poll 一轮信封」——只有
 * poller 恰好在 commit 前扫到同账号兄弟设备的 wrapper 才能发现重复轮换；
 * poll 间隔（最长几十秒）就是竞态窗口。同账号多端同时到期的首轮轮换里
 * 实测撞槽：两端的 wrapper queueId 相同（旧状态一致），server
 * last-write-wins，后写者覆盖先写者，一端的 commit 被静默丢失、会话分叉。
 *
 * 宣言机制：commit 前先向本账号 PDS 写一条「宣言记录」，相当于宣告
 * 「本次 commit 由我执行」：
 *   - rkey = HKDF(exporterSecret)（本 epoch 所有端可推导出同一 rkey；
 *     epoch 换代后自然换槽，旧槽作废，无需清理也能防止误读）；
 *   - 内容 = { groupId, epoch, nonce, createdAt }，用 HKDF(exporterSecret)
 *     派生的 AES-256-GCM 密钥加密——atproto 仓库公开可读，内容必须不透明。
 *
 * 及时性：判定靠「commit 前主动读 PDS」而非被动等 poller 扫到信封，
 * 读到的就是 server 当前真相，不依赖 poll 时机：
 *   - 读不到 → 写宣言并回读比对 nonce（atproto putRecord 是
 *     last-write-wins、无原子 CAS，回读把并发双写窗口压到一个网络往返）；
 *   - 读到同 epoch 的新鲜宣言 → 另一端已认领本次轮换，本端跳过本周期
 *     （其 wrapper 稍后经正常 poll 投递，克隆端走既有 sibling-rotated 路径）；
 *   - 宣言者崩溃未 commit 时由 TTL 兜底，其他端超时后可接管。
 *
 * 与 pollOnce 的关系：poll 保留（消费已投出的 wrapper → sibling 信号），
 * 宣言在其后执行，作为 commit 的硬性门槛——宣言不可用（网络失败等）
 * 时 fail-closed：宁可本周期不轮换，也不在无仲裁的情况下 commit。
 */

import { mlsExporter } from 'ts-mls';
import { gcm } from '@noble/ciphers/aes';
import { utf8ToBytes } from '@noble/hashes/utils';
import { getNobleMlsImpl } from './mls-noble-kdf';
import { bytesToBase64url, base64urlToBytes, bytesToHex } from './utils';
import {
  ROTATION_CLAIM_ENC_KEY_LENGTH,
  ROTATION_CLAIM_LABEL,
  ROTATION_CLAIM_RKEY_LENGTH,
} from './mls-config';

/** 宣言有效期：超过视为宣言者已崩溃，其他端可接管。 */
export const ROTATION_CLAIM_TTL_MS = 10 * 60 * 1000;

/** GCM nonce 长度（字节）。 */
const CLAIM_NONCE_LENGTH = 12;

/** 宣言派生参数（由 pre-commit 状态的 exporterSecret 推导，本 epoch 恒定）。 */
export interface RotationClaimParams {
  /** PDS 记录 rkey（base64url，atproto rkey 字符集兼容）。 */
  rkey: string;
  /** 宣言内容 AES-256-GCM 密钥。 */
  encKey: Uint8Array;
}

/** 宣言明文内容（加密前）。 */
export interface RotationClaim {
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
 * 从 exporterSecret 派生宣言槽位参数。本 epoch 的所有设备（含克隆端）
 * 推导出相同结果；epoch 换代后 exporterSecret 变化 → 自然换槽。
 */
export async function deriveRotationClaimParams(
  exporterSecret: Uint8Array,
): Promise<RotationClaimParams> {
  const impl = await getNobleMlsImpl();
  const rkey = await mlsExporter(
    exporterSecret,
    ROTATION_CLAIM_LABEL,
    utf8ToBytes('rkey'),
    ROTATION_CLAIM_RKEY_LENGTH,
    impl,
  );
  const encKey = await mlsExporter(
    exporterSecret,
    ROTATION_CLAIM_LABEL,
    utf8ToBytes('enc'),
    ROTATION_CLAIM_ENC_KEY_LENGTH,
    impl,
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
    return JSON.parse(new TextDecoder().decode(plaintext)) as RotationClaim;
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

/** 认领结果：acquired = 本端拿到执行权；taken = 另一端已认领/并发落败。 */
export type RotationClaimResult = 'acquired' | 'taken';

/**
 * 认领本次轮换。PDS 不可用时抛出——调用方必须 fail-closed（跳过本周期），
 * 绝不在无仲裁的情况下 commit。
 */
export async function acquireRotationClaim(
  params: RotationClaimParams,
  claim: { groupId: string; epoch: number },
  store: RotationClaimStore,
): Promise<RotationClaimResult> {
  const existing = await readClaim(params, store);
  if (existing) {
    if (existing.epoch > claim.epoch) {
      // 对端已推进到更新的 epoch（本端尚未应用其 wrapper）
      return 'taken';
    }
    const age = Date.now() - Date.parse(existing.createdAt);
    if (existing.epoch === claim.epoch && Number.isFinite(age) && age < ROTATION_CLAIM_TTL_MS) {
      // 同 epoch 的新鲜宣言：另一端已认领本次轮换
      return 'taken';
    }
    // epoch 更小（陈旧槽位）或宣言超时（宣言者可能崩溃未 commit）→ 抢占
  }

  const nonce = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
  await store.put(
    params.rkey,
    encryptClaim(params.encKey, {
      groupId: claim.groupId,
      epoch: claim.epoch,
      nonce,
      createdAt: new Date().toISOString(),
    }),
  );

  // putRecord 无原子 CAS（last-write-wins）：回读比对 nonce，
  // 把并发双写窗口从「poll 间隔」压缩到一个网络往返
  const verify = await readClaim(params, store);
  if (!verify || verify.nonce !== nonce) return 'taken';
  return 'acquired';
}

/** 释放宣言：commit 成功后（epoch 已换代，槽位自然作废）或投递失败回滚后调用。尽力而为。 */
export async function releaseRotationClaim(
  params: RotationClaimParams,
  store: RotationClaimStore,
): Promise<void> {
  try {
    await store.del(params.rkey);
  } catch {
    // 删除失败无碍：epoch 换代后槽位不再被读取；崩溃未 commit 时由 TTL 兜底
  }
}
