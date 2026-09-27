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
};

export type OnMessageCallback = (msg: IncomingMessage) => Promise<void>;
export type OnWelcomeCallback = (welcome: IncomingWelcome) => Promise<void>;

type QueueContext =
  | {
      type: 'message';
      groupId: string;
      senderLeafIndex: number;
      senderDid: string;
      generation: number;
    }
  | { type: 'welcome'; queueId: string };

export class DmePoller {
  private readonly pds: DmePds;
  private readonly storage: DmeStorage;
  private readonly sessions: Map<string, MlsSession> = new Map();
  private readonly pendingWelcomes: Map<string, PendingWelcome> = new Map();
  private onMessage: OnMessageCallback | null = null;
  private onWelcome: OnWelcomeCallback | null = null;
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

  start(onMessage: OnMessageCallback, onWelcome: OnWelcomeCallback): void {
    this.onMessage = onMessage;
    this.onWelcome = onWelcome;
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
  }

  async pollOnce(): Promise<void> {
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

      if (await this.storage.isQueueIdProcessed(env.queueId)) {
        console.log('DmePoller: skipping already-processed queueId', env.queueId);
        continue;
      }

      try {
        if (ctx.type === 'welcome') {
          const welcomeBytes = base64urlToBytes(env.payload);
          if (this.onWelcome) {
            await this.onWelcome({ queueId: ctx.queueId, welcomeBytes });
          }
        } else {
          const session = this.sessions.get(ctx.groupId);
          if (!session) {
            console.log('DmePoller: no session for group', ctx.groupId);
            continue;
          }

          const ciphertext = base64urlToBytes(env.payload);
          const result = await session.decrypt(ciphertext);

          console.log('DmePoller: decrypt done, plaintext=' + !!result.plaintext + ' isCommit=' + result.isCommit);

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

        await this.storage.markQueueIdProcessed(env.queueId);
      } catch (err) {
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
