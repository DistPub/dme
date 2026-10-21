/**
 * rotation.ts - 定期密钥轮换执行器（key-rotation-plan.md 1.3 / 1.4 / 1.5）
 *
 * 职责：到期的会话执行 self-update commit（updateOwnLeaf），commit 包装信封
 * 经 commit-delivery.ts 投进群 queueId 空间（Phase 1.0 已解除成对 1v1 依赖，
 * 任何成员都可安全成为 committer）。
 *
 * 竞态防护（1.4）：
 *  - 单飞锁：同会话轮换进行中不重复触发（模块级 in-flight 集合）；
 *  - 随机抖动：commit 创建前随机延迟（0-JITTER_MAX_MS 均匀随机），压低
 *    同账号多端在同一轮询周期内同时 commit 的概率；
 *  - **宣言检查（rotation-claim.ts v2，commit 的硬性门槛）**：commit 前主动
 *    读本账号 PDS 的账号级单调 commit 高水位——本地 seq 与 PDS 一致才允许
 *    commit（写 seq+1，保留不删）；PDS 更高 = 其他端已推进（taken/stale，
 *    均宣言失败，置 sibling-rotated 提示恢复最新备份）；PDS 不可用
 *    fail-closed：宁可本周期不轮换，也不在无仲裁的情况下 commit；
 *  - 残余窗口：两设备在宣言写入→回读的一个网络往返内同时认领仍可能
 *    双 commit 撞槽，概率已从 (秒级窗口/抖动区间)² 降至可忽略；撞槽的
 *    一端会话分叉，其后续消息对端解不开 → 对端 desync 标记，最终以恢复
 *    备份收敛。
 *
 * 原子性：updateOwnLeaf 推进本地状态后若投递失败，从提交前快照回滚内存态、
 * 释放宣言、不记 lastRotationAt，下个周期自然重试——绝不允许"本地已换代而
 * commit 未投出"的状态落盘（那会让全员脱钩）。
 *
 * 备份联动（1.5）：轮换成功后由 deps.onRotated 回调处理——有缓存密码则
 * 静默刷新备份，否则置 backupRequired 强提示。
 */

import { deliverCommitViaGroupSpace } from '../state/commit-delivery';
import type { MlsSession } from './mls-session';
import {
  acquireRotationClaim,
  deriveRotationClaimParams,
  releaseRotationClaim,
  type RotationClaimStore,
} from './rotation-claim';
import type { DmeEnvelope } from '../protocol/types';

/** commit 前随机抖动上限（毫秒）。 */
export const JITTER_MAX_MS = 2 * 60 * 1000;

const inFlight = new Set<string>();

// ---------------------------------------------------------------------------

export interface RotationDeps {
  /** 全部会话（群聊 + 1v1）的 groupId 列表。 */
  listGroupIds(): Promise<string[]>;
  getSession(groupId: string): MlsSession | null;
  /** 回滚内存态：从序列化快照重建会话并重新挂到 poller。 */
  reloadSession(groupId: string, serialized: string): Promise<void>;
  putMlsSession(groupId: string, serialized: string): Promise<void>;
  createEnvelope(envelope: DmeEnvelope): Promise<unknown>;
  getIntervalMs(): Promise<number>;
  getLastRotationAt(groupId: string): Promise<number>;
  setLastRotationAt(groupId: string, ts: number): Promise<void>;
  /** 会话异常标记（desynced / sibling-rotated），无标记时 null。 */
  /** 会话异常标记（desynced / sibling-rotated / forked），无标记时 null。 */
  getSessionIssue(groupId: string): Promise<'sibling-rotated' | 'desynced' | 'forked' | null>;
  /** 群 commit 谱系账本：预留 per-group seq（group-fork-plan.md 3.1）。 */
  reserveGroupCommit(
    groupId: string,
  ): Promise<{ seq: number; parentQueueId: string | null }>;
  /** 群 commit 谱系账本：投递成功后写回信封 queueId。 */
  appendGroupCommitQueueId(
    groupId: string,
    seq: number,
    queueId: string,
  ): Promise<void>;
  /** PDS 宣言存取（AppContext 用 DmePds 组装，见 rotation-claim.ts）。 */
  claimStore: RotationClaimStore;
  /** 账号级 commit 高水位（本地计数，随备份走；宣言 v2 比对基准）。 */
  getCommitSeq(): Promise<number>;
  setCommitSeq(seq: number): Promise<void>;
  /** 身份签名公钥（宣言槽位账号级稳定派生源）。 */
  getIdentitySigningPublicKey(): Promise<Uint8Array>;
  /** 轮换成功后的备份联动（1.5）。 */
  onRotated(groupId: string): Promise<void>;
  /**
   * 轮换中止/失败的 UI 通知：
   * - sibling-rotated：另一台设备已轮换（poll 发现 wrapper）；
   * - stale：宣言 v2 检测到 PDS 高水位高于本地且已过期 = 备份分叉，
   *   必须提示恢复备份（用户拍板：seq 检测 desync）。
   */
  onAborted(groupId: string, reason: 'sibling-rotated' | 'stale'): void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 检查全部会话，对到期的执行轮换。非阻塞：每个会话独立异步执行，
 * 单飞锁防重入。由 app 启动 / 回前台 / 定时器调用。
 */
export function maybeRotateGroups(deps: RotationDeps): void {
  void (async () => {
    let groupIds: string[];
    try {
      groupIds = await deps.listGroupIds();
    } catch (err) {
      console.warn('[dme:rotation] listGroupIds failed:', err);
      return;
    }

    for (const groupId of groupIds) {
      if (inFlight.has(groupId)) continue;
      try {
        const interval = await deps.getIntervalMs();
        const last = await deps.getLastRotationAt(groupId);
        if (Date.now() - last < interval) continue;
        // 缺口②：带异常标记的会话不轮换——状态已废（需重握手/恢复备份），
        // 轮换无收益；且克隆端共享同一状态，一端轮换会在所有兄弟端触发
        // sibling-rotated 横幅风暴（实测踩过）
        const issue = await deps.getSessionIssue(groupId);
        if (issue) continue;
      } catch (err) {
        console.warn('[dme:rotation] rotation check failed for', groupId, err);
        continue;
      }

      inFlight.add(groupId);
      void rotateSession(groupId, deps)
        .catch((err) => {
          console.warn('[dme:rotation] rotation failed for', groupId, err);
        })
        .finally(() => inFlight.delete(groupId));
    }
  })();
}

async function rotateSession(groupId: string, deps: RotationDeps): Promise<void> {
  const session = deps.getSession(groupId);
  if (!session) return;

  // 随机抖动：错开同账号多端设备的同时触发（1.4）
  await sleep(Math.floor(Math.random() * JITTER_MAX_MS));

  // 抖动后重新校验：周期可能已被改、兄弟设备可能已轮换、会话可能已不在
  if (deps.getSession(groupId) !== session) return;
  const interval = await deps.getIntervalMs();
  const last = await deps.getLastRotationAt(groupId);
  if (Date.now() - last < interval) return;

  // 宣言检查 v2（commit 的硬性门槛，账号级单调 commit 高水位仲裁）：
  // 本地 seq 与 PDS 一致 → 允许 commit（写 seq+1，保留为高水位）；
  // PDS 更高 → 其他端已推进（taken/stale 均为宣言失败，同一恢复路径：
  // 置 sibling-rotated 提示恢复最新备份，绝不 commit）；
  // PDS 不可用 → fail-closed 跳过，宁可下个周期重试也不无仲裁地 commit
  const claimParams = await deriveRotationClaimParams(await deps.getIdentitySigningPublicKey());
  let claimSeq: number;
  try {
    const { verdict, seq } = await acquireRotationClaim(
      claimParams,
      { groupId, epoch: session.getEpoch(), localSeq: await deps.getCommitSeq() },
      deps.claimStore,
    );
    claimSeq = seq;
    if (verdict === 'taken') {
      // 对端正在/刚完成 commit：本端宣言失败（约定9）→ 提示恢复备份，
      // 静默跳过只会把恢复时机赌在「对端 wrapper 能否经 poll 到达」上
      console.warn('[dme:rotation] rotation claimed by another device, backup restore required', groupId);
      deps.onAborted(groupId, 'sibling-rotated');
      return;
    }
    if (verdict === 'stale') {
      // 宣言 v2：PDS 高水位高于本地且已过期 = 其他端早已 commit 而本端
      // 长期未同步（备份分叉，wrapper 可能已超 7 天 TTL 丢失）。
      // 绝不允许 commit，明确提示恢复备份（用户拍板设计）。
      console.warn('[dme:rotation] commit seq ahead of local (backup fork), restore required', groupId);
      deps.onAborted(groupId, 'stale');
      return;
    }
  } catch (err) {
    console.warn('[dme:rotation] rotation claim check failed, skip this cycle', groupId, err);
    return;
  }

  // 快照提交前状态（wrapper 用旧 epoch 加密，投进群 queueId 空间）
  const preCommitState = session.serialize();
  try {
    const { commitMessage } = await session.updateOwnLeaf();

    // 谱系账本：预留 per-group seq（立即落盘，投递失败留下空缺 seq 由收端
    // 容忍，绝不复用——同 seq 异 queueId 会被收端判成假分叉）
    const seqMeta = await deps.reserveGroupCommit(groupId);

    try {
      const { queueId } = await deliverCommitViaGroupSpace({
        preCommitStateSerialized: preCommitState,
        groupId,
        commitMessage,
        createEnvelope: deps.createEnvelope,
        groupSeq: seqMeta.seq,
        parentQueueId: seqMeta.parentQueueId,
      });
      await deps.appendGroupCommitQueueId(groupId, seqMeta.seq, queueId);
    } catch (err) {
      // 投递失败：回滚内存态、释放宣言（避免虚高水位）、不记 lastRotationAt
      // ——绝不允许本地已换代而 commit 未投出（否则全员脱钩）。下个周期重试。
      console.warn('[dme:rotation] commit delivery failed, rolling back', groupId, err);
      await deps.reloadSession(groupId, preCommitState);
      await releaseRotationClaim(claimParams, deps.claimStore);
      return;
    }
  } catch (err) {
    // updateOwnLeaf 本身失败（状态未推进）：释放宣言即可，下个周期重试
    console.warn('[dme:rotation] updateOwnLeaf failed', groupId, err);
    await releaseRotationClaim(claimParams, deps.claimStore);
    return;
  }

  await deps.putMlsSession(groupId, session.serialize());
  await deps.setLastRotationAt(groupId, Date.now());
  // 宣言 v2：commit 成功后本地高水位推进，宣言保留在 PDS 作为账号
  // commit 高水位（不删除）——任何落后端下次 commit 前都会发现分叉
  await deps.setCommitSeq(claimSeq);
  console.log('[dme:rotation] rotated session', groupId, 'commitSeq', claimSeq);

  await deps.onRotated(groupId);
}
