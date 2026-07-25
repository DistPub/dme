/**
 * poll/poller.ts - 定时轮询接收消息。
 *
 * 对每个对话伙伴，根据 ratchet 状态计算下一个 QueueID，批量查询 gateway。
 * Gateway 剥离客户端 IP 后转发到 dme-server。
 *
 * 决策 Q3 消息去重：
 *   主：ratchet 推进后旧 chain key 销毁，重复解密天然失败。
 *   兜底：QueueID LRU 集合（1000 条 / ~64KB）存 AsyncStorage，
 *         崩溃恢复时防止重复展示。
 *
 * 轮询间隔随机化（5-15 分钟），避免流量模式分析。
 */

import type { DmeEnvelope } from '../protocol/index';

import type { DoubleRatchet } from '../crypto/ratchet';
import { decryptMessage } from '../crypto/envelope';
import type { DmePds } from '../atproto/pds';
import type { DmeStorage } from '../storage/db';
import { POLL_MAX_INTERVAL_MS, POLL_MIN_INTERVAL_MS } from '../crypto/constants';

export type OnMessageCallback = (
  friendDid: string,
  plaintext: string,
  envelope: DmeEnvelope,
) => void | Promise<void>;

interface TrackedConversation {
  friendDid: string;
  ratchet: DoubleRatchet;
  initialQueueId?: string;
}

export class DmePoller {
  private conversations: Map<string, TrackedConversation> = new Map();
  private readonly pds: DmePds;
  private readonly storage: DmeStorage;
  private onMessage: OnMessageCallback | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(pds: DmePds, storage: DmeStorage) {
    this.pds = pds;
    this.storage = storage;
  }

  addConversation(friendDid: string, ratchet: DoubleRatchet, initialQueueId?: string): void {
    this.conversations.set(friendDid, { friendDid, ratchet, initialQueueId });
  }

  removeConversation(friendDid: string): void {
    this.conversations.delete(friendDid);
  }

  getRatchet(friendDid: string): DoubleRatchet | null {
    return this.conversations.get(friendDid)?.ratchet ?? null;
  }

  start(onMessage: OnMessageCallback): void {
    this.onMessage = onMessage;
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
  }

  async pollOnce(): Promise<void> {
    if (this.conversations.size === 0) {
      console.log('[POLLER] pollOnce: no conversations');
      return;
    }

    console.log(`[POLLER] pollOnce: ${this.conversations.size} conversations`);
    const queueIdToFriend = new Map<string, string>();
    const allQueueIds: string[] = [];

    for (const conv of this.conversations.values()) {
      try {
        let queueId: string;
        if (!conv.ratchet.isRecvReady && conv.initialQueueId) {
          queueId = conv.initialQueueId;
          console.log(`[POLLER] ${conv.friendDid}: using initialQueueId=${queueId.slice(0, 8)}...`);
        } else {
          queueId = conv.ratchet.nextRecvQueueId();
          console.log(`[POLLER] ${conv.friendDid}: nextRecvQueueId=${queueId.slice(0, 8)}..., isRecvReady=${conv.ratchet.isRecvReady}`);
        }
        queueIdToFriend.set(queueId, conv.friendDid);
        allQueueIds.push(queueId);
      } catch (err) {
        console.log(`[POLLER] ${conv.friendDid}: skip (ratchet not ready: ${err})`);
      }
    }

    if (allQueueIds.length === 0) {
      return;
    }

    console.log(`[POLLER] querying ${allQueueIds.length} queueIds: ${allQueueIds.map(q => q.slice(0, 8) + '...').join(', ')}`);

    let envelopes: DmeEnvelope[];
    try {
      envelopes = await this.pds.batchGetEnvelopes(allQueueIds);
      console.log(`[POLLER] got ${envelopes.length} envelopes from server`);
    } catch (err) {
      console.error('DmePoller: batch query failed:', err);
      return;
    }

    if (envelopes.length === 0) {
      console.log(`[POLLER] no envelopes found`);
    }

      // 处理返回的 envelopes
      for (const env of envelopes) {
        const friendDid = queueIdToFriend.get(env.queueId);
        if (!friendDid) {
          console.log(`[POLLER] envelope queueId=${env.queueId.slice(0, 8)}... not matched to any conversation`);
          continue;
        }

        const conv = this.conversations.get(friendDid);
        if (!conv) continue;

        // 去重检查
        const alreadyProcessed = await this.storage.isQueueIdProcessed(env.queueId);
        if (alreadyProcessed) {
          console.log(`[POLLER] ${friendDid}: queueId already processed, skip`);
          continue;
        }

        // 尝试解密
        try {
          console.log(`[POLLER] ${friendDid}: attempting decrypt, queueId=${env.queueId.slice(0, 8)}...`);
          const plaintextBytes = decryptMessage(conv.ratchet, env);
          const plaintext = new TextDecoder().decode(plaintextBytes);
          console.log(`[POLLER] ${friendDid}: decrypt SUCCESS, plaintext="${plaintext.slice(0, 20)}..."`);

          if (this.onMessage) {
            await this.onMessage(friendDid, plaintext, env);
          }

          await this.storage.markQueueIdProcessed(env.queueId);
          await this.storage.putRatchet(friendDid, conv.ratchet.serialize());
        } catch (err) {
          console.log(`[POLLER] ${friendDid}: decrypt FAILED: ${err}`);
          // 解密失败 - 可能是提前查询或垃圾数据，静默丢弃
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
