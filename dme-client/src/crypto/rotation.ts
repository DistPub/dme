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
 *  - 残余窗口：两设备在 poll 延迟内同时 commit 仍可能撞槽（同 queueId
 *    server last-write-wins），概率约 (秒级窗口/抖动区间)²，接受；撞槽的
 *    一端会话分叉，其后续消息对端解不开 → 对端 desync 标记，最终以恢复
 *    备份收敛。
 *
 * 原子性：updateOwnLeaf 推进本地状态后若投递失败，从提交前快照回滚内存态、
 * 不记 lastRotationAt，下个周期自然重试——绝不允许"本地已换代而 commit
 * 未投出"的状态落盘（那会让全员脱钩）。
 *
 * 备份联动（1.5）：轮换成功后由 deps.onRotated 回调处理——有缓存密码则
 * 静默刷新备份，否则置 backupRequired 强提示。
 */

import { deliverCommitViaGroupSpace } from '../state/commit-delivery';
import type { MlsSession } from './mls-session';
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

  // 快照提交前状态（wrapper 用旧 epoch 加密，投进群 queueId 空间）
  const preCommitState = session.serialize();
  const { commitMessage } = await session.updateOwnLeaf();

  try {
    await deliverCommitViaGroupSpace({
      preCommitStateSerialized: preCommitState,
      groupId,
      commitMessage,
      createEnvelope: deps.createEnvelope,
    });
  } catch (err) {
    // 投递失败：回滚内存态、不记 lastRotationAt——绝不允许本地已换代而
    // commit 未投出（否则全员脱钩）。下个周期自然重试。
    console.warn('[dme:rotation] commit delivery failed, rolling back', groupId, err);
    await deps.reloadSession(groupId, preCommitState);
    return;
  }

  await deps.putMlsSession(groupId, session.serialize());
  await deps.setLastRotationAt(groupId, Date.now());
  console.log('[dme:rotation] rotated session', groupId);

  await deps.onRotated(groupId);
}
