/**
 * poll/poller.ts - MLS message polling.
 *
 * Two polling modes:
 *   1. Welcome polling - poll for pending incoming MLS Welcome messages
 *      using queueIds stored in PendingWelcome entries (derived from
 *      KeyPackage initKeys via deriveWelcomeQueueId at creation time).
 *   2. Message polling - poll for application messages and commits in
 *      established MLS groups, deriving queueIds from the MLS exporter
 *      secret + sender leaf index + expected generation.
 *
 * Blind-lookup architecture preserved: the server sees only opaque queueIds.
 *
 * Dedup: QueueID LRU set in AsyncStorage prevents duplicate display after
 * crash recovery (primary dedup is MLS generation advancement).
 */

import type { DmeEnvelope } from '../protocol/types';
import type { DmePds } from '../atproto/pds';
import type { DmeStorage, PendingWelcome } from '../storage/db';
import type { MlsSession } from '../crypto/mls-session';
import { deriveMessageQueueId } from '../crypto/mls-queue-id';
import { getNobleMlsImpl } from '../crypto/mls-noble-kdf';
import { base64urlToBytes } from '../crypto/utils';

/** Minimum polling interval in ms (randomized to avoid traffic analysis). */
const POLL_MIN_INTERVAL_MS = 5_000;
/** Maximum polling interval in ms. */
const POLL_MAX_INTERVAL_MS = 15_000;

export type IncomingMessage = {
  groupId: string;
  senderDid: string;
  plaintext: string;
  envelope: DmeEnvelope;
};

export type IncomingWelcome = {
  queueId: string;
  /** Raw MLS Welcome wire bytes (decoded from envelope.payload base64url). */
  welcomeBytes: Uint8Array;
  /** ISO-8601 timestamp from the envelope (used to record welcomeDate). */
  createdAt: string;
};

export type OnMessageCallback = (msg: IncomingMessage) => Promise<void>;
export type OnWelcomeCallback = (welcome: IncomingWelcome) => Promise<void>;
/**
 * Rescue message callback.
 *
 * @returns true = 消息已被成功消费（poller 可标记为已处理）；
 *          false = 消费失败（poller **不会**标记，让下一轮重试）。
 */
export type OnRescueCallback = (
  groupId: string,
  payloadBase64url: string,
) => Promise<boolean>;

type QueueContext =
  | {
      type: 'message';
      groupId: string;
      senderLeafIndex: number;
      senderDid: string;
      generation: number;
    }
  | { type: 'welcome'; queueId: string }
  | { type: 'rescue'; groupId: string }
  | { type: 'rescue_callback'; groupId: string };

export class DmePoller {
  private readonly pds: DmePds;
  private readonly storage: DmeStorage;
  private readonly sessions: Map<string, MlsSession> = new Map();
  private readonly pendingWelcomes: Map<string, PendingWelcome> = new Map();
  private readonly rescueQueueIds = new Map<string, string>();
  private readonly rescueCallbackQueueIds = new Map<string, string>();
  private readonly inFlightQueueIds = new Set<string>();
  private polling = false;
  private onMessage: OnMessageCallback | null = null;
  private onWelcome: OnWelcomeCallback | null = null;
  private onRescue: OnRescueCallback | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private batchSize = 3;

  constructor(pds: DmePds, storage: DmeStorage, batchSize = 3) {
    this.pds = pds;
    this.storage = storage;
    this.batchSize = batchSize;
  }

  setBatchSize(size: number): void {
    this.batchSize = Math.max(1, Math.min(20, size));
  }

  addSession(groupId: string, session: MlsSession): void {
    this.sessions.set(groupId, session);
  }

  removeSession(groupId: string): void {
    this.sessions.delete(groupId);
  }

  getSession(groupId: string): MlsSession | null {
    return this.sessions.get(groupId) ?? null;
  }

  addPendingWelcome(entry: PendingWelcome): void {
    this.pendingWelcomes.set(entry.queueId, entry);
  }

  removePendingWelcome(queueId: string): void {
    this.pendingWelcomes.delete(queueId);
  }

  /**
   * Set the rescue queueId for a 1v1 conversation.
   * Pass null to stop polling the rescue channel for this group.
   */
  setRescueQueueId(groupId: string, queueId: string | null): void {
    if (queueId === null) {
      this.rescueQueueIds.delete(groupId);
    } else {
      this.rescueQueueIds.set(groupId, queueId);
    }
  }

  /**
   * Set the rescue callback queueId for a 1v1 conversation.
   * Pass null to stop polling the callback for this group.
   */
  setRescueCallbackQueueId(groupId: string, queueId: string | null): void {
    if (queueId === null) {
      this.rescueCallbackQueueIds.delete(groupId);
    } else {
      this.rescueCallbackQueueIds.set(groupId, queueId);
    }
  }

  start(onMessage: OnMessageCallback, onWelcome: OnWelcomeCallback, onRescue?: OnRescueCallback): void {
    this.onMessage = onMessage;
    this.onWelcome = onWelcome;
    this.onRescue = onRescue ?? null;
    this.running = true;
    this.scheduleNextPoll(0);
  }

  /**
   * 停止轮询（App Hide 时调用）。
   *
   * ⚠️ 刻意**不清空** onMessage / onWelcome 回调：stop 之后必须能靠
   * {@link resume} 无参恢复 —— 否则小程序热启动（后台切回前台）后
   * 间隔轮询就永远死了，只剩各页面 useDidShow 的单次 pollNow，
   * 表现为「等待握手一直卡住，重启小程序才收到消息」。
   */
  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** App Show 时恢复轮询（回调仍由 start 时注入；未 start 过则不动）。 */
  resume(): void {
    if (this.running) return;
    if (!this.onMessage || !this.onWelcome) return;
    this.running = true;
    this.scheduleNextPoll(0);
  }

  setOnRescue(onRescue: OnRescueCallback | null): void {
    this.onRescue = onRescue;
  }

  isRunning(): boolean {
    return this.running;
  }

  async pollOnce(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      await this.pollOnceInner();
    } finally {
      this.polling = false;
    }
  }

  private async pollOnceInner(): Promise<void> {
    const allQueueIds: string[] = [];
    const queueIdToContext = new Map<string, QueueContext>();

    const impl = await getNobleMlsImpl();

    // 1. Collect queueIds for active MLS conversations.
    //    memberDids[i] has LeafIndex i (NOT tree position i*2).
    //    senderLeafIndex from MlsSession is also a LeafIndex.
    //    secretTree and deriveMessageQueueId both use LeafIndex.
    for (const [groupId, session] of this.sessions) {
      try {
        const exporterSecret = session.getExporterSecret();
        const memberDids = session.getMemberDids();
        const ownLeafIndex = session.getSenderLeafIndex();

        const allGens = memberDids.map((_, i) => session.getExpectedGeneration(i));
        console.log('DmePoller: group', groupId, 'ownLeafIndex', ownLeafIndex, 'allGens', allGens);

        for (let i = 0; i < memberDids.length; i++) {
          if (i === ownLeafIndex) continue;
          const senderDid = memberDids[i];
          if (!senderDid) continue;

          const baseGen = session.getExpectedGeneration(i);
          for (let g = 0; g < this.batchSize; g++) {
            const generation = baseGen + g;
            const queueId = await deriveMessageQueueId(
              exporterSecret,
              i,
              generation,
            );
            console.log('DmePoller: batch queueId', queueId, 'for leafIndex', i, 'gen', generation);
            allQueueIds.push(queueId);
            queueIdToContext.set(queueId, {
              type: 'message',
              groupId,
              senderLeafIndex: i,
              senderDid,
              generation,
            });
          }
        }
      } catch (err) {
        console.error('DmePoller: failed to derive queueIds for group', groupId, err);
      }
    }

    // 2. Collect queueIds for pending Welcomes.
    for (const queueId of this.pendingWelcomes.keys()) {
      allQueueIds.push(queueId);
      queueIdToContext.set(queueId, { type: 'welcome', queueId });
    }

    // 3. Collect rescue channel queueIds (1v1 rescue handshake).
    for (const [groupId, queueId] of this.rescueQueueIds) {
      allQueueIds.push(queueId);
      queueIdToContext.set(queueId, { type: 'rescue', groupId });
    }

    // 4. Collect rescue callback queueIds.
    for (const [groupId, queueId] of this.rescueCallbackQueueIds) {
      allQueueIds.push(queueId);
      queueIdToContext.set(queueId, { type: 'rescue_callback', groupId });
    }

    if (allQueueIds.length === 0) return;

    console.log('DmePoller: polling', allQueueIds.length, 'queueIds');

    // 3. Batch query PDS (server sees only opaque queueIds).
    let envelopes: DmeEnvelope[];
    try {
      envelopes = await this.pds.batchGetEnvelopes(allQueueIds);
    } catch (err) {
      console.error('DmePoller: batch query failed:', err);
      return;
    }

    console.log('DmePoller: got', envelopes.length, 'envelopes');

    // 4. Sort message envelopes by (sender, generation) to ensure in-order
    //    processing within the same sender. Out-of-order decryption breaks
    //    the MLS secret tree key chain.
    envelopes.sort((a, b) => {
      const ctxA = queueIdToContext.get(a.queueId);
      const ctxB = queueIdToContext.get(b.queueId);
      if (ctxA?.type === 'message' && ctxB?.type === 'message') {
        const s = ctxA.senderLeafIndex - ctxB.senderLeafIndex;
        if (s !== 0) return s;
        return ctxA.generation - ctxB.generation;
      }
      if (ctxA?.type === 'message') return -1;
      if (ctxB?.type === 'message') return 1;
      return 0;
    });

    // 5. Process results.
    for (const env of envelopes) {
      const ctx = queueIdToContext.get(env.queueId);
      if (!ctx) continue;

      if (this.inFlightQueueIds.has(env.queueId)) {
        console.log('DmePoller: skipping in-flight queueId', env.queueId);
        continue;
      }

      let alreadyProcessed = await this.storage.isQueueIdProcessed(env.queueId);

      // ⚠️ 救援通道自愈（2026-10-28 真机修复）：
      //    **救援邀请不存在 ⇒ 这条救援消息从未被成功消费过**。
      //    因为成功消费的路径（handleRescueMessage）必然写入 rescueInvite
      //    记录。所以只要救援通道上没有对应的 invite，就说明上一次尝试
      //    失败了（多半是早期「先 mark 后处理」的顺序 bug 导致的），此时
      //    LRU 里的标记是**脏数据**，必须撤销并重试，否则用户永远看不到
      //    救援卡片，控制台一直刷 `skipping already-processed queueId`。
      if (ctx.type === 'rescue' && alreadyProcessed) {
        const hasInvite = await this.storage.hasAnyRescueInvite(ctx.groupId);
        if (!hasInvite) {
          console.warn(
            '[dme:rescue] 检测到上次处理失败留下的脏标记，撤销并重试救援消息',
            env.queueId,
          );
          await this.storage.unmarkQueueIdProcessed(env.queueId);
          alreadyProcessed = false;
        }
      }

      // ⚠️ 自愈 + 关键不变量（2026-09-28 真机修复）：
      //    **pendingWelcome 还在 ⇒ 这条 welcome 从未被成功消费过**。
      //    因为成功配对的路径（processReceivedWelcome）第一步就是
      //    `deletePendingWelcome(queueId)`。
      //
      //    所以只要 pending entry 还在，就说明上一次尝试失败了（多半是
      //    早期"先 mark 后处理"的顺序 bug 导致的），此时 LRU 里的标记是
      //    **脏数据**，必须撤销并重试，否则用户会永远卡在"等对方扫码"，
      //    控制台一直刷 `skipping already-processed queueId`。
      if (ctx.type === 'welcome') {
        const stillPending = (await this.storage.getPendingWelcomes()).some(
          (w) => w.queueId === env.queueId,
        );
        if (stillPending && alreadyProcessed) {
          console.warn(
            'DmePoller: 检测到上次处理失败留下的脏标记，撤销并重试 welcome',
            env.queueId,
          );
          await this.storage.unmarkQueueIdProcessed(env.queueId);
          alreadyProcessed = false;
        }
      }

      if (alreadyProcessed) {
        console.log('DmePoller: skipping already-processed queueId', env.queueId);
        continue;
      }
      this.inFlightQueueIds.add(env.queueId);

      try {
        if (ctx.type === 'welcome') {
          // ⚠️ 顺序至关重要：**必须先处理成功，再标记已处理**。
          //    早期实现先 markQueueIdProcessed 再调 onWelcome，一旦回调提前
          //    return（未初始化 / 找不到 pending entry）或抛错，这个 queueId 就
          //    被永久标记为已处理，之后**永远不会再取到**，welcome 直接丢失
          //    （2026-09-28 真机：控制台一直刷
          //     `DmePoller: skipping already-processed queueId Viz_KRkk...`）。
          //    下面的 message 分支就是正确顺序（先 decrypt 再 mark），保持一致。
          const welcomeBytes = base64urlToBytes(env.payload);
          if (this.onWelcome) {
            await this.onWelcome({ queueId: ctx.queueId, welcomeBytes, createdAt: env.createdAt });
          } else {
            // 没有回调就等于没人消费，不能标记，否则这条 welcome 会永久丢失
            console.warn('DmePoller: onWelcome 未注册，跳过 welcome', ctx.queueId);
            this.inFlightQueueIds.delete(env.queueId);
            continue;
          }
          await this.storage.markQueueIdProcessed(env.queueId);
        } else if (ctx.type === 'rescue') {
          // ⚠️ 顺序至关重要：**必须先处理成功，再标记已处理**。
          //    早期实现先 markQueueIdProcessed 再调 onRescue，一旦
          //    handleRescueMessage 提前 return（welcomeDate 缺失 / peer key
          //    解析失败 / 解密失败 / fromDid 不匹配），这个 queueId 就被永久
          //    标记为已处理，之后**永远不会再取到**，救援消息直接丢失
          //    （2026-10-28 真机：对方收到救援标记但本机没有救援卡片，
          //    控制台一直刷 `skipping already-processed queueId`）。
          if (!this.onRescue) {
            console.warn('DmePoller: onRescue 未注册，跳过救援消息', env.queueId);
            this.inFlightQueueIds.delete(env.queueId);
            continue;
          }
          const consumed = await this.onRescue(ctx.groupId, env.payload);
          if (consumed) {
            await this.storage.markQueueIdProcessed(env.queueId);
          } else {
            // 处理失败：**不要**标记，否则该 queueId 会被 LRU 永久跳过、
            // 救援消息再也取不到。下一轮轮询会重新拉取并重试。
            console.warn(
              '[dme:rescue] 救援消息处理失败，本轮不标记，下轮重试',
              env.queueId,
            );
          }
        } else if (ctx.type === 'rescue_callback') {
          // Rescue callback uses the same envelope format as a normal Welcome.
          const welcomeBytes = base64urlToBytes(env.payload);
          if (this.onWelcome) {
            await this.onWelcome({
              queueId: env.queueId,
              welcomeBytes,
              createdAt: env.createdAt,
            });
          } else {
            console.warn('DmePoller: onWelcome 未注册，跳过 rescue callback', env.queueId);
            this.inFlightQueueIds.delete(env.queueId);
            continue;
          }
          await this.storage.markQueueIdProcessed(env.queueId);
        } else {
          const session = this.sessions.get(ctx.groupId);
          if (!session) {
            console.log('DmePoller: no session for group', ctx.groupId);
            this.inFlightQueueIds.delete(env.queueId);
            continue;
          }

          // 群 commit 谱系观测（P1，group-fork-plan.md 3.1，与 dme-client 同步）：
          // groupSeq 在信封明文上，**必须放在解密之前**——分叉后对方谱系的信封
          // 解不开，只有这里的明文观测能给出分叉铁证（同 seq 异 queueId）。
          // 观测失败不阻断消息处理；命中分叉时仍继续尝试解密，forked 标记独立成立。
          //
          // 归属护栏（与 dme-client 同步）：仅当 ctx.groupId 是**群会话**（有
          // GroupInfo）时才观测。1v1 通道扇出的 commit 副本 ctx.groupId 是对端
          // DID，观测会记错账本并制造跨群 seq 假碰撞；这类副本由 AppContext
          // group_commit 分支按真实 groupId 补观测。
          if (
            ctx.type === 'message' &&
            typeof env.groupSeq === 'number' &&
            (await this.storage.getGroupInfo(ctx.groupId))
          ) {
            try {
              const verdict = await this.storage.observeGroupCommit(
                ctx.groupId,
                env.groupSeq,
                env.queueId,
              );
              if (verdict === 'fork') {
                console.error(
                  '[dme:fork] commit lineage fork detected:',
                  ctx.groupId,
                  'seq',
                  env.groupSeq,
                  'queueId',
                  env.queueId,
                );
                await this.storage.setSessionIssue(ctx.groupId, 'forked');
              }
            } catch (err) {
              console.warn('[dme:fork] ledger observe failed:', err);
            }
          }

          const ciphertext = base64urlToBytes(env.payload);
          const result = await session.decrypt(ciphertext);

          console.log('DmePoller: decrypt done, plaintext=' + !!result.plaintext + ' isCommit=' + result.isCommit);

          await this.storage.markQueueIdProcessed(env.queueId);

          if (result.plaintext && this.onMessage) {
            await this.onMessage({
              groupId: ctx.groupId,
              senderDid: ctx.senderDid,
              plaintext: new TextDecoder().decode(result.plaintext),
              envelope: env,
            });
          }

          const genBefore = session.getExpectedGeneration(ctx.senderLeafIndex);
          await this.storage.putMlsSession(ctx.groupId, session.serialize());
          const genAfter = session.getExpectedGeneration(ctx.senderLeafIndex);
          console.log('DmePoller: gen before save=' + genBefore + ' after save=' + genAfter);
        }
        this.inFlightQueueIds.delete(env.queueId);
      } catch (err) {
        this.inFlightQueueIds.delete(env.queueId);
        // ⚠️ 关键：处理失败必须**撤销**「已处理」标记，否则该 queueId 会被
        //    LRU 集合永久跳过 —— welcome 尤其致命（丢了就再也配不上对）。
        //    正常路径的 mark 只在处理成功之后才执行，这里是防御性回滚
        //    （例如 mark 本身写成功后 onMessage 回调抛错的极端情况）。
        try {
          await this.storage.unmarkQueueIdProcessed(env.queueId);
        } catch (rollbackErr) {
          console.error('DmePoller: 回滚 queueId 标记失败', env.queueId, rollbackErr);
        }
        console.error('DmePoller: process failed for', env.queueId, err);
      }
    }
  }

  private scheduleNextPoll(delayMs: number): void {
    if (!this.running) return;

    this.timer = setTimeout(async () => {
      try {
        await this.pollOnce();
      } catch (err) {
        console.error('DmePoller: poll cycle error:', err);
      }
      const nextDelay = randomInterval(POLL_MIN_INTERVAL_MS, POLL_MAX_INTERVAL_MS);
      this.scheduleNextPoll(nextDelay);
    }, delayMs);
  }
}

function randomInterval(minMs: number, maxMs: number): number {
  return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
}
