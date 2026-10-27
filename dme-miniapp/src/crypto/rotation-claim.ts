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
 *         宣言过期（age >= TTL）→ 进入「云端备份是否覆盖该推进」判定：
 *           覆盖（备份含该推进）→ stale：本端真落后且恢复备份**能**修好，
 *             提示恢复备份，绝不允许 commit；
 *           不覆盖（备份不含该推进）→ adopt：本端落后但恢复备份只会倒灌
 *             旧状态、**修不好**——此时要求用户恢复备份是死路（恢复后
 *             仍撞同一高水位）。改为接管高水位（seq = existing.seq）继续
 *             正常操作，不再阻断整个账号。
 *       PDS seq  < 本地 seq → 异常（本地不可能超前），fail-closed taken；
 *   - putRecord 有原生 CAS（swapRecord：当前记录 CID 比对）+ createRecord
 *     显式 rkey 的原子 create-if-absent：并发双写时服务端只让先到者成功，
 *     落败方 CAS 失败 → taken（fail-closed）。nonce 回读保留作兜底
 *     （防 PDS 实现忽略 swapRecord）；
 *   - commit 成功后宣言保留（高水位），仅投递失败回滚 / commit 失败时
 *     release 删除，避免虚高水位。
 *
 * 恢复完整重放的两大前提之一（用户拍板）：备份点足够新（所有影响解密
 * 的变更都联动备份）+ 备份不分叉（本机制检测：seq 高水位暴露任何端的
 * 任何 commit，落后端无法假装最新）。
 *
 * v3 修正（2026-10-27，实测踩过）：v2 把「PDS 高水位 > 本地 seq」一律
 * 当作「备份分叉 → 提示恢复备份」，混淆了三件本质不同的事：
 *   1) 本机真落后且**云端备份含**该推进 → 恢复备份有效（stale）；
 *   2) 本机落后但**云端备份不含**该推进（兄弟端 commit 后备份联动失败，
 *      或本机是全新设备）→ 恢复备份只会倒灌旧状态、救不了（adopt）；
 *   3) 账号级计数器顺延（别的会话被 commit）→ 与本机操作的会话无关，
 *      不该阻断任何操作。
 * v2 把 2) 和 3) 都判成 stale → 全新设备永远过不了宣言门禁（建群/握手/
 * 踢人/拉人/轮换全被拦），且横幅文案让用户去恢复一份**根本不含所需
 * 状态**的备份——实测用户反馈「我没备份过，为什么叫我恢复备份」。
 * v3 引入云端备份覆盖判定（cloudBackupCoversClaim）分流 stale / adopt。
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

/** 宣言槽位读结果：密文 + 记录 CID（CID 供 CAS 写入/删除比对）。 */
export interface ClaimSlotRecord {
  payload: string;
  cid: string;
}

/**
 * 判定 XRPC 错误是否为 CAS 并发冲突（并发落败，非网络/系统故障）：
 * - putRecord swapRecord 不匹配 → InvalidSwap；
 * - createRecord 显式 rkey 已存在 → RecordAlreadyExists。
 */
export function isClaimCasConflict(err: unknown): boolean {
  const e = err as { error?: unknown; message?: unknown; body?: unknown };
  const hay = [e?.error, e?.message, e?.body].filter((s): s is string => typeof s === 'string').join(' ');
  return /InvalidSwap|RecordAlreadyExists|record already exists/i.test(hay);
}

/** PDS 记录读写抽象（AppContext 用 DmePds 组装）。全方法 CAS 语义。 */
export interface RotationClaimStore {
  /** 读宣言槽位（密文 + CID）；记录不存在返回 null。网络等未知错误应 throw（fail-closed）。 */
  get(rkey: string): Promise<ClaimSlotRecord | null>;
  /**
   * CAS 写入：expectedCid 为 null → 原子 create-if-absent（槽位已存在则失败）；
   * 否则仅当当前记录 CID == expectedCid 时写入。返回 false = 并发落败
   * （他端先写），调用方必须按 taken 处理；网络等未知错误 throw（fail-closed）。
   */
  put(rkey: string, payload: string, expectedCid: string | null): Promise<boolean>;
  /** CAS 删除：仅当当前记录 CID == expectedCid 时删除（尽力而为，失败静默）。 */
  del(rkey: string, expectedCid: string): Promise<void>;
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

/** 读宣言槽位：解密后的声明 + 记录 CID + 原始密文（供备份锁恢复）。 */
interface ClaimView {
  claim: RotationClaim | null;
  cid: string | null;
  rawPayload: string | null;
}

async function readClaim(
  params: RotationClaimParams,
  store: RotationClaimStore,
): Promise<ClaimView> {
  const rec = await store.get(params.rkey);
  if (rec === null) return { claim: null, cid: null, rawPayload: null };
  return { claim: decryptClaim(params.encKey, rec.payload), cid: rec.cid, rawPayload: rec.payload };
}

/** 只读 peek：读取当前高水位 seq（供兄弟端 commit 应用成功后追平本地计数）。 */
export async function peekCommitSeq(
  params: RotationClaimParams,
  store: RotationClaimStore,
): Promise<number | null> {
  const { claim } = await readClaim(params, store);
  if (!claim || claim.seq < 0) return null;
  return claim.seq;
}

/**
 * 认领判定结果：
 * - acquired：本端拿到执行权，seq 为应写入的高水位（commit 成功后保留宣言）；
 * - taken：另一端已认领 / 并发落败 / 本地异常超前 → 静默跳过本周期；
 * - stale：PDS 高水位高于本地、宣言已过期、且**云端备份含该推进** →
 *   本端真落后且恢复备份**能**修好，调用方必须提示恢复备份，绝不允许 commit；
 * - adopt：PDS 高水位高于本地、宣言已过期、但**云端备份不含该推进** →
 *   本端落后但恢复备份只会倒灌旧状态、修不好（实测：全新设备本地 seq=0
 *   被判 stale，横幅让用户恢复一份不含所需状态的备份 → 死路）。此时
 *   调用方应接管高水位（seq = existing.seq）继续正常操作，不阻断账号。
 */
export type RotationClaimVerdict = 'acquired' | 'taken' | 'stale' | 'adopt';

export interface RotationClaimOutcome {
  verdict: RotationClaimVerdict;
  seq: number;
}

/**
 * 云端备份是否覆盖了「本次高水位推进」——决定 stale（恢复备份能修）还是
 * adopt（恢复备份修不了，必须接管）。
 *
 * 判据（全部来自外层明文元数据，不解密备份、不需要密码）：
 *   - meta.commitSeq >= claim.seq → 备份写于该推进之后 → **覆盖**；
 *   - meta.commitSeq <  claim.seq → 备份写于该推进之前 → **不覆盖**
 *     （恢复它只会倒灌到更旧的状态）；
 *   - meta 缺失或无 commitSeq（旧记录）→ 保守按**不覆盖**处理：
 *     无法证明备份含该推进，就不能承诺「恢复备份能修好」。
 *
 * 另一个正交信号：备份记录的写入时间是否晚于宣言的 createdAt。晚于说明
 * 备份是在那次推进之后写的，佐证「覆盖」；早于则佐证「不覆盖」。两者冲突
 * 时以 commitSeq 为准（它是账号级单调计数，语义最准）。
 */
export function cloudBackupCoversClaim(
  meta: { commitSeq?: number } | null | undefined,
  claimSeq: number,
): boolean {
  if (!meta || typeof meta.commitSeq !== 'number') return false;
  return meta.commitSeq >= claimSeq;
}

/**
 * 只读检视：当前高水位与本机的关系（**不写入任何记录**，纯判别）。
 *
 * 用途：让**已贴 sibling-rotated 标记的存量会话**能自愈。v3 修正之前，
 * 一旦某端被判 stale 就永久贴上标记，横幅无法关闭——哪怕后来条件已变化
 * （比如云端备份已刷新、或用户已在另一台设备推进），标记也一直在。
 * 启动时用本接口复检：若当前判定已是 adopt（恢复备份修不了）/一致，
 * 说明当初那个 stale 判定已过期（多半是云端备份后来才被刷新），标记应清除。
 *
 * 返回 'consistent'：本机与云端高水位一致（或云端无高水位）；
 * 返回 'ahead'：云端高水位高于本机；
 * 返回 'adoptable'：云端高水位高于本机、但云端备份不含该推进
 *                 （恢复备份修不了 → 应接管高水位并清除标记）。
 */
export type ClaimInspection = 'consistent' | 'ahead' | 'adoptable';

export async function inspectClaimWatermark(
  params: RotationClaimParams,
  localSeq: number,
  store: RotationClaimStore,
  cloudBackupMeta?: { commitSeq?: number } | null,
): Promise<ClaimInspection> {
  const { claim: existing } = await readClaim(params, store);
  if (!existing || existing.seq < 0) return 'consistent';
  if (existing.seq <= localSeq) return 'consistent';
  // 云端高水位高于本机：能否靠恢复备份修好？
  if (cloudBackupCoversClaim(cloudBackupMeta, existing.seq)) return 'ahead';
  return 'adoptable';
}

/**
 * v2/v3 认领：账号级单调 commit 高水位仲裁。PDS 不可用时抛出——调用方必须
 * fail-closed（跳过本周期），绝不在无仲裁的情况下 commit。
 *
 * @param claim.localSeq 本地 commitSeq（随备份走）；backupSeq 用于崩溃残留判别。
 * @param claim.cloudBackupMeta 云端备份外层元数据（可空）——用于判定
 *        「恢复备份能否修好」，分流 stale / adopt（见 cloudBackupCoversClaim）。
 */
export async function acquireRotationClaim(
  params: RotationClaimParams,
  claim: { groupId: string; epoch: number; localSeq: number; cloudBackupMeta?: { commitSeq?: number } | null },
  store: RotationClaimStore,
): Promise<RotationClaimOutcome> {
  const { claim: existing, cid: existingCid } = await readClaim(params, store);

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
        // 宣言已过期且 seq 仍高于本地 → 对端早已完成、本端长期未同步。
        // v3 修正（2026-10-27）：此时**不能一律**要求恢复备份——要先看
        // 云端备份是否含这次推进：
        //   含（stale）→ 本机真落后，恢复备份能修好 → 明确提示，绝不 commit；
        //   不含（adopt）→ 恢复备份只会倒灌旧状态、修不好（实测：全新设备
        //     本地 seq=0、云端备份写于推进之前，横幅让用户恢复备份是死路）
        //     → 接管高水位继续，不阻断整个账号。
        if (cloudBackupCoversClaim(claim.cloudBackupMeta, existing.seq)) {
          console.warn('[dme:claim] stale: backup fork, cloud backup covers claim, restore required');
          return { verdict: 'stale', seq: existing.seq };
        }
        console.warn(
          '[dme:claim] adopt: cloud backup does not cover claim seq',
          existing.seq,
          '- restoring backup would roll back to older state; taking over watermark',
        );
        return { verdict: 'adopt', seq: existing.seq };
      }
    } else if (existing.seq === claim.localSeq) {
      // 本端与云端一致，最新 → 允许 commit
    } else {
      // existing.seq < localSeq：本地不可能超前（本地 commit 必写宣言）→ 异常
      return { verdict: 'taken', seq: existing.seq };
    }
  }

  const nonce = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
  const payload = encryptClaim(params.encKey, {
    seq: nextSeq,
    groupId: claim.groupId,
    epoch: claim.epoch,
    nonce,
    createdAt: new Date().toISOString(),
  });

  // CAS 写入（原子仲裁）：槽位为空走 createRecord 显式 rkey 的
  // create-if-absent；槽位已有记录走 putRecord swapRecord 比对读到的 CID。
  // 并发双写时服务端只让先到者成功，落败方拿到 false → taken（fail-closed），
  // 「双端同时通过」在服务端串行化下不再可能。
  const written = await store.put(params.rkey, payload, existingCid);
  if (!written) return { verdict: 'taken', seq: nextSeq };

  // 兜底回读比 nonce：防 PDS 实现忽略 swapRecord（CAS 未生效）
  const verify = await readClaim(params, store);
  if (!verify.claim || verify.claim.nonce !== nonce) return { verdict: 'taken', seq: nextSeq };
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
    // CAS 删除：先读当前记录 CID，仅当记录未被兄弟端改写时才删——
    // 若并发期间兄弟端已落新高水位，CAS 失败、其记录原样保留
    const { cid } = await readClaim(params, store);
    if (cid === null) return;
    await store.del(params.rkey, cid);
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
//   - 高水位高于本地且已过期 → 按「云端备份是否覆盖该推进」分流（v3 修正，
//     2026-10-27）：
//       覆盖 → stale，必须先恢复最新备份，绝不允许上传可能过期的状态；
//       不覆盖 → adopt：云端备份本就缺这次推进（本机是全新设备，或兄弟端
//         commit 后备份联动失败），此时本机状态并不比云端旧——云端那份压根
//         没有这次推进的成果。拒绝备份毫无意义，反而让用户永远推不上
//         云端状态，且恢复备份也修不好（备份里没有所需状态）。放行。
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

export type BackupLockVerdict = 'acquired' | 'busy' | 'stale' | 'adopt';

export type BackupLockOutcome =
  | { readonly verdict: 'acquired'; handle: BackupLockHandle }
  | { readonly verdict: 'busy' | 'stale' | 'adopt'; seq: number };

/**
 * 占用手动备份锁。PDS 不可用/读取失败时抛出（fail-closed）——无法仲裁
 * 时宁可不备份，也不上传可能已过期的状态。
 *
 * @param cloudBackupMeta 云端备份外层元数据（可空）——判定备份是否覆盖
 *        当前高水位（v3 修正：stale vs adopt）。
 */
export async function acquireBackupLock(
  params: RotationClaimParams,
  localSeq: number,
  store: RotationClaimStore,
  cloudBackupMeta?: { commitSeq?: number } | null,
): Promise<BackupLockOutcome> {
  const previousPayload = await store.get(params.rkey);
  const existing = previousPayload === null ? null : decryptClaim(params.encKey, previousPayload.payload);
  const existingCid = previousPayload?.cid ?? null;

  if (existing && existing.seq > localSeq) {
    const age = Date.now() - Date.parse(existing.createdAt);
    const fresh = Number.isFinite(age) && age < ROTATION_CLAIM_TTL_MS;
    if (fresh) {
      // 另一端正在 commit（或其高水位刚落盘）：本端状态可能马上过时，
      // 稍后再试（对方完成并同步后高水位会与本地追平）
      return { verdict: 'busy', seq: existing.seq };
    }
    // 过期且高水位仍高于本地（v3 修正，2026-10-27）：
    //   云端备份含该推进 → stale：另一端早已推进、本端长期未同步（wrapper
    //     可能已超 7 天 TTL 丢失），本机状态可疑，必须先恢复最新备份
    //     （fail-closed，可恢复）；
    //   云端备份不含该推进 → adopt：本机状态并不比云端旧（云端那份压根
    //     没有这次推进的成果），拒绝备份只会让用户永远推不上云端状态，
    //     且恢复备份也修不好。放行。
    if (cloudBackupCoversClaim(cloudBackupMeta, existing.seq)) {
      return { verdict: 'stale', seq: existing.seq };
    }
    return { verdict: 'adopt', seq: existing.seq };
  }

  // seq <= localSeq（一致或残留旧锁）→ 允许备份，持锁挡窗
  const nonce = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
  const lockPayload = encryptClaim(params.encKey, {
    seq: localSeq + 1, // 仅作为互斥信号；释放时恢复原记录，不保留
    groupId: 'backup',
    epoch: 0,
    nonce,
    createdAt: new Date().toISOString(),
  });

  // CAS 写入：与 commit 宣言同款原子仲裁，并发落败 → busy
  const written = await store.put(params.rkey, lockPayload, existingCid);
  if (!written) {
    return { verdict: 'busy', seq: existing?.seq ?? localSeq + 1 };
  }

  // 兜底回读比 nonce：防 PDS 实现忽略 swapRecord
  const verify = await readClaim(params, store);
  if (!verify.claim || verify.claim.nonce !== nonce) {
    // 并发落败：无法安全持锁，按 busy 处理（原记录可能已被改写，也无法恢复）
    return { verdict: 'busy', seq: verify.claim?.seq ?? localSeq + 1 };
  }
  return {
    verdict: 'acquired',
    handle: { params, nonce, previousPayload: previousPayload?.payload ?? null },
  };
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
    const currentRecord = await store.get(handle.params.rkey);
    if (currentRecord === null) return; // 已被外力删除，无可恢复
    const current = decryptClaim(handle.params.encKey, currentRecord.payload);
    if (!current || current.nonce !== handle.nonce) return; // 已易主，保留现状
    if (handle.previousPayload === null) {
      // CAS 删除：期间兄弟端落了新高水位则失败、其记录原样保留
      await store.del(handle.params.rkey, currentRecord.cid);
    } else {
      // CAS 恢复占用前的记录内容：期间被改写则失败、保留改写者记录
      const restored = await store.put(handle.params.rkey, handle.previousPayload, currentRecord.cid);
      void restored;
    }
  } catch {
    // 释放失败最坏后果：锁记录 TTL 后过期，epoch=0 被判别为崩溃残留抢占
  }
}
