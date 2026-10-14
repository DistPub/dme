/**
 * rotation.ts - 定期密钥轮换执行器（key-rotation-plan.md 1.3 / 1.4 / 1.5）
 *
 * 职责：到期的会话执行 self-update commit（updateOwnLeaf），commit 包装信封
 * 经 commit-delivery.ts 投进群 queueId 空间（Phase 1.0 已解除成对 1v1 依赖，
 * 任何成员都可安全成为 committer）。
 *
 * 竞态防护（1.4）：
 *  - 单飞锁：同会话轮换进行中不重复触发（模块级 in-flight 集合）；
 *  - 随机抖动：commit 创建前随机延迟（计划原定"确定性错峰 + ±10% 周期"，
 *    实现取 0-JITTER_MAX_MS 均匀随机——触发时刻本就随设备回前台时间自然错开，
 *    只需压低同账号多端在同一轮询周期内同时 commit 的概率，过长的确定性
 *    偏移会把轮换拖到到期后数小时，UX 不可接受）；
 *  - commit 前 poll 一轮：若同账号兄弟设备已抢先 commit，其 wrapper 会经
 *    group_commit 路径触发 sibling 信号（本机无法应用兄弟的 commit）——
 *    轮换中止并上抛，走"恢复备份"路径（1.6）；
 *  - **宣言检查（PDS rotation-claim，commit 的硬性门槛）**：poll 是被动的、
 *    受 poll 间隔限制（实测同账号多端同时到期的首轮轮换曾撞槽：两端
 *    queueId 相同、server last-write-wins，一端 commit 被覆盖丢失）。
 *    宣言改为 commit 前主动读本账号 PDS 的仲裁记录——rkey 由本 epoch
 *    exporterSecret 派生（所有端一致），读到新鲜宣言就跳过本周期；
 *    详见 rotation-claim.ts。宣言不可用时 fail-closed：不 commit，
 *    宁可下个周期重试；
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

// ---------------------------------------------------------------------------
// 兄弟设备轮换信号（由 AppContext 的 group_commit catch 写入，见 1.6）
// ---------------------------------------------------------------------------

const siblingSignals = new Set<string>();

/** AppContext 在"自己发的 commit 本机应用失败"时调用（= 兄弟设备已轮换）。 */
export function reportSiblingRotation(groupId: string): void {
  siblingSignals.add(groupId);
}

function consumeSiblingSignal(groupId: string): boolean {
  return siblingSignals.delete(groupId);
}

// ---------------------------------------------------------------------------

export interface RotationDeps {
  /** 全部会话（群聊 + 1v1）的 groupId 列表。 */
  listGroupIds(): Promise<string[]>;
  getSession(groupId: string): MlsSession | null;
  /** 回滚内存态：从序列化快照重建会话并重新挂到 poller。 */
  reloadSession(groupId: string, serialized: string): Promise<void>;
  putMlsSession(groupId: string, serialized: string): Promise<void>;
  createEnvelope(envelope: DmeEnvelope): Promise<unknown>;
  /** commit 前拉一轮待处理信封（消费可能存在的兄弟设备 commit）。 */
  pollOnce(): Promise<void>;
  getIntervalMs(): Promise<number>;
  getLastRotationAt(groupId: string): Promise<number>;
  setLastRotationAt(groupId: string, ts: number): Promise<void>;
  /** 会话异常标记（desynced / sibling-rotated），无标记时 null。 */
  getSessionIssue(groupId: string): Promise<'sibling-rotated' | 'desynced' | null>;
  /** PDS 宣言存取（AppContext 用 DmePds 组装，见 rotation-claim.ts）。 */
  claimStore: RotationClaimStore;
  /** 轮换成功后的备份联动（1.5）。 */
  onRotated(groupId: string): Promise<void>;
  /** 轮换中止/失败的 UI 通知（如"检测到另一台设备已轮换，请恢复备份"）。 */
  onAborted(groupId: string, reason: 'sibling-rotated'): void;
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

const inFlight = new Set<string>();

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

  // commit 前 poll 一轮：消费兄弟设备可能已投出的 commit wrapper，
  // 其处理会经 group_commit catch 写入 sibling 信号（1.4）
  try {
    await deps.pollOnce();
  } catch (err) {
    console.warn('[dme:rotation] pre-commit poll failed:', err);
  }
  if (consumeSiblingSignal(groupId)) {
    deps.onAborted(groupId, 'sibling-rotated');
    return;
  }

  // 宣言检查（commit 的硬性门槛，及时判定不依赖 poll 时序）：
  // 另一端已认领 → 本周期跳过（其 wrapper 稍后经正常 poll 投递）；
  // PDS 不可用 → fail-closed 跳过，宁可下个周期重试也不无仲裁地 commit
  const claimParams = await deriveRotationClaimParams(session.getExporterSecret());
  try {
    const result = await acquireRotationClaim(
      claimParams,
      { groupId, epoch: session.getEpoch() },
      deps.claimStore,
    );
    if (result !== 'acquired') {
      console.log('[dme:rotation] rotation claimed by another device, skip this cycle', groupId);
      return;
    }
  } catch (err) {
    console.warn('[dme:rotation] rotation claim check failed, skip this cycle', groupId, err);
    return;
  }

  // 快照提交前状态（wrapper 用旧 epoch 加密，投进群 queueId 空间）。
  // 注意 claimParams 也派生自 pre-commit exporterSecret——commit 后
  // exporterSecret 变化，释放宣言必须用这里捕获的旧参数。
  const preCommitState = session.serialize();
  try {
    const { commitMessage } = await session.updateOwnLeaf();

    try {
      await deliverCommitViaGroupSpace({
        preCommitStateSerialized: preCommitState,
        groupId,
        commitMessage,
        createEnvelope: deps.createEnvelope,
      });
    } catch (err) {
      // 投递失败：回滚内存态、释放宣言、不记 lastRotationAt——绝不允许
      // 本地已换代而 commit 未投出（否则全员脱钩）。下个周期自然重试。
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
  // epoch 已换代，宣言槽位自然作废；删除仅为不让孤儿记录堆积
  await releaseRotationClaim(claimParams, deps.claimStore);
  console.log('[dme:rotation] rotated session', groupId);

  await deps.onRotated(groupId);
}
