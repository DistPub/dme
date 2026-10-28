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
export type OnRescueCallback = (groupId: string, payloadBase64url: string) => Promise<void>;

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

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.onMessage = null;
    this.onWelcome = null;
    this.onRescue = null;
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
      if (await this.storage.isQueueIdProcessed(env.queueId)) {
        console.log('DmePoller: skipping already-processed queueId', env.queueId);
        continue;
      }
      this.inFlightQueueIds.add(env.queueId);

      try {
        if (ctx.type === 'welcome') {
          await this.storage.markQueueIdProcessed(env.queueId);
          const welcomeBytes = base64urlToBytes(env.payload);
          if (this.onWelcome) {
            await this.onWelcome({
              queueId: ctx.queueId,
              welcomeBytes,
              createdAt: env.createdAt,
            });
          }
        } else if (ctx.type === 'rescue') {
          await this.storage.markQueueIdProcessed(env.queueId);
          if (this.onRescue) {
            await this.onRescue(ctx.groupId, env.payload);
          }
        } else if (ctx.type === 'rescue_callback') {
          // Rescue callback uses the same envelope format as a normal Welcome.
          await this.storage.markQueueIdProcessed(env.queueId);
          const welcomeBytes = base64urlToBytes(env.payload);
          if (this.onWelcome) {
            await this.onWelcome({
              queueId: env.queueId,
              welcomeBytes,
              createdAt: env.createdAt,
            });
          }
        } else {
          const session = this.sessions.get(ctx.groupId);
          if (!session) {
            console.log('[DIAG] DmePoller: no session for group', ctx.groupId);
            this.inFlightQueueIds.delete(env.queueId);
            continue;
          }
          console.log('[DIAG] DmePoller: processing envelope', ctx.groupId, 'senderLeaf=' + ctx.senderLeafIndex, 'gen=' + ctx.generation, 'queueId=' + env.queueId);

          // 多端支持：扫描包含自己的叶子（去掉了 own-leaf skip 后，自己的设备也会拉到本机发出、已推进过 gen 的信封）。
          // 若本机对该叶子已消费到比信封 gen 更靠后，说明这条是本机自己发的、发送时已推进过 gen ——
          // 不要再解密（会触发 "gen in the past"），直接标记为已处理跳过。
        const ownLeaf = session.getSenderLeafIndex();
        if (
          ctx.senderLeafIndex === ownLeaf &&
          ctx.generation < session.getExpectedGeneration(ownLeaf)
        ) {
          await this.storage.markQueueIdProcessed(env.queueId);
          this.inFlightQueueIds.delete(env.queueId);
          continue;
        }

        // 群 commit 谱系观测（P1，group-fork-plan.md 3.1）：groupSeq 在信封
        // 明文上，**必须放在解密之前**——分叉后对方谱系的信封解不开，只有
        // 这里的明文观测能给出分叉铁证（同 seq 异 queueId）。观测失败不阻断
        // 消息处理（账本是旁路观测层）。命中分叉时仍继续尝试解密：MLS 应用
        // 走原有成功/失败路径，forked 标记独立成立。
        //
        // 归属护栏：仅当 ctx.groupId 是**群会话**（有 GroupInfo）时才观测。
        // 1v1 通道扇出的 commit 副本（建群/退群清理）ctx.groupId 是对端 DID，
        // 观测会记错账本，且不同群的 seq 在同一账本里碰撞会制造假分叉；这类
        // 副本改由 AppContext group_commit 分支按解析出的真实 groupId 补观测
        // （仅覆盖可解密副本；1v1 上解不开的副本无法归属，P1 接受此盲区，
        // 分叉会在任一端后续 group-space commit 的 seq 碰撞时暴露）。
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
            } else if (verdict === 'new' && env.groupSeq > 1) {
              console.log(
                '[dme:fork] observed commit seq',
                env.groupSeq,
                'for',
                ctx.groupId,
              );
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
        console.error('[DIAG] DmePoller: process failed for', env.queueId, 'ctxType=' + ctx?.type, 'groupId=' + (ctx?.type === 'message' ? ctx.groupId : '(n/a)'), 'err=' + (err instanceof Error ? err.message + ' / ' + err.name : String(err)));
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
