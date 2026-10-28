/**
 * storage/db.ts - 持久化层（storage 后端抽象，embed 模式经 postMessage 委托 fatesky）。
 *
 * 存储所有客户端长期状态：
 *   1. 身份密钥对（Ed25519 + X25519，每用户一份）
 *   2. MLS group session 状态（每个对话一份）
 *   3. 消息历史（解密后的明文 + 元数据）
 *   4. QueueID LRU 集合（去重，~1000 条 / ~64KB）
 *   5. KeyPackage 池（本地未使用的 KeyPackage 列表）
 *   6. Pending Welcome 记录（等待接收 Welcome 的邀请）
 *
 * 所有数据以 DID 为前缀命名空间，切换账号互不干扰。
 */

import { storage } from './backend';

import type { IdentityKeys } from '../crypto/identity';
import type { GroupInfo, PendingInvite } from '../protocol/group-message';
import type { FileMeta } from '../protocol/types';
import type {
  PendingRescueCallback,
  PendingRescueInvite,
} from '../protocol/rescue';
import { DEFAULT_APPVIEW_PROXY, DME_SERVER_URL, DEFAULT_DME_GATEWAY_URL } from '../config';

export type MessageKind = 'text' | 'group_invite' | 'group_system' | 'file' | 'post';

/** 表情回应。 */
export interface Reaction {
  emoji: string;
  did: string;
  createdAt: string;
}

/** 存储的消息记录。 */
export interface StoredMessage {
  id: string;
  fromDid: string;
  toDid: string;
  plaintext: string;
  createdAt: string;
  sent: boolean;
  kind?: MessageKind;
  conversationId?: string;
  readAt?: string;
  reactions?: Reaction[];
  fileMeta?: FileMeta;
}

/** 等待接收 Welcome 的记录。 */
export interface PendingWelcome {
  queueId: string;
  groupId: string;
  keyPackageSerialized: string;
  createdAt: string;
}

/** 本地 KeyPackage 池条目。 */
export interface KeyPackagePoolEntry {
  id: string;
  publicPackageSerialized: string;
  privatePackageSerialized: string;
  createdAt: string;
  consumed: boolean;
}

/**
 * 群 commit 谱系账本条目（P1，group-fork-plan.md 3.1）：
 * 同一 seq 下已见的全部 commit 信封 queueId（1v1 扇出的同一逻辑 commit
 * 每份副本 queueId 不同，发送方记录全部、接收方只见自己那份）+ 谱系链
 * 上一条 commit 的 queueId（P1 仅记录不判定）。
 */
export interface GroupCommitLedgerEntry {
  queueIds: string[];
  parentQueueId: string | null;
}

const QUEUEID_LRU_MAX = 1000;

const KEY_PACKAGE_POOL_KEY = 'keyPackagePool';

/**
 * 存储封装，所有 key 以 `dme:<did>:` 为前缀。
 */
export class DmeStorage {
  private readonly prefix: string;
  private readonly userDid: string;

  constructor(userDid: string) {
    this.userDid = userDid;
    this.prefix = `dme:${userDid}:`;
  }

  // -----------------------------------------------------------------------
  // 通用 key-value（供 session.ts 用）
  // -----------------------------------------------------------------------

  async putRaw(key: string, value: string): Promise<void> {
    await storage.setItem(this.prefix + key, value);
  }

  async getRaw(key: string): Promise<string | null> {
    return storage.getItem(this.prefix + key);
  }

  async deleteRaw(key: string): Promise<void> {
    await storage.removeItem(this.prefix + key);
  }

  // -----------------------------------------------------------------------
  // 身份密钥
  // -----------------------------------------------------------------------

  async putIdentityKeys(keys: IdentityKeys): Promise<void> {
    await storage.setItem(
      this.prefix + 'identity',
      JSON.stringify(keys, (k, v) => {
        // Uint8Array -> base64
        if (v instanceof Uint8Array) {
          return { __type: 'Uint8Array', data: bytesToBase64(v) };
        }
        return v;
      }),
    );
  }

  async getIdentityKeys(): Promise<IdentityKeys | null> {
    const raw = await storage.getItem(this.prefix + 'identity');
    if (!raw) return null;
    return JSON.parse(raw, (k, v) => {
      if (v && typeof v === 'object' && v.__type === 'Uint8Array') {
        return base64ToBytes(v.data);
      }
      return v;
    }) as IdentityKeys;
  }

  // -----------------------------------------------------------------------
  // MLS Session 状态
  // -----------------------------------------------------------------------

  async putMlsSession(groupId: string, serialized: string): Promise<void> {
    // 轮换基线护栏（rotation-baseline-plan.md 3.1）：本设备首次持久化该会话
    // 时同步写轮换基线 = now，否则 rotation.ts 判 lastRotationAt=0 会让新会话
    // 在第一次轮换检查即"到期"（新群建完过一会就轮换的根因）。
    // 判据是"会话记录不存在"而非"rotationAt 记录不存在"：
    //  - 轮换失败回滚、日常更新等路径会话记录已存在 → 不触发，保住
    //    "投递失败下个周期自然重试"语义；
    //  - 备份恢复路径随后会用备份值显式覆盖（AppContext restoreIdentity），
    //    旧备份无 rotationAt → 0 → 立即到期，向后兼容不变。
    const existed = (await this.getMlsSession(groupId)) !== null;
    if (!existed) await this.setLastRotationAt(groupId, Date.now());
    await storage.setItem(this.prefix + `mlsSession:${groupId}`, serialized);
  }

  async getMlsSession(groupId: string): Promise<string | null> {
    return storage.getItem(this.prefix + `mlsSession:${groupId}`);
  }

  async deleteMlsSession(groupId: string): Promise<void> {
    await storage.removeItem(this.prefix + `mlsSession:${groupId}`);
  }

  // -----------------------------------------------------------------------
  // 1v1 救援握手持久化
  // -----------------------------------------------------------------------

  /** 初次加好友 / 救援成功后的 welcome 日期（YYYY-MM-DD），用于派生救援 queueId。 */
  async getWelcomeDate(groupId: string): Promise<string | null> {
    return storage.getItem(this.prefix + `welcomeDate:${groupId}`);
  }

  async setWelcomeDate(groupId: string, date: string): Promise<void> {
    await storage.setItem(this.prefix + `welcomeDate:${groupId}`, date);
  }

  /** 发起救援后等待 Welcome 的回调记录。 */
  async getRescueCallback(
    groupId: string,
  ): Promise<PendingRescueCallback | null> {
    const raw = await storage.getItem(this.prefix + `rescueCallback:${groupId}`);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as Partial<PendingRescueCallback>;
      if (
        typeof parsed.date === 'string' &&
        typeof parsed.callbackQueueId === 'string'
      ) {
        return {
          date: parsed.date,
          callbackQueueId: parsed.callbackQueueId,
        };
      }
    } catch {
      // malformed, fall through to clear
    }
    await storage.removeItem(this.prefix + `rescueCallback:${groupId}`);
    return null;
  }

  async setRescueCallback(
    groupId: string,
    callback: PendingRescueCallback,
  ): Promise<void> {
    await storage.setItem(
      this.prefix + `rescueCallback:${groupId}`,
      JSON.stringify(callback),
    );
  }

  async clearRescueCallback(groupId: string): Promise<void> {
    await storage.removeItem(this.prefix + `rescueCallback:${groupId}`);
  }

  /** 施救方收到的救援邀请，仅当天展示。 */
  async getRescueInvite(
    groupId: string,
  ): Promise<PendingRescueInvite | null> {
    const raw = await storage.getItem(this.prefix + `rescueInvite:${groupId}`);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as Partial<PendingRescueInvite>;
      if (
        typeof parsed.date === 'string' &&
        typeof parsed.fromDid === 'string' &&
        typeof parsed.qrData === 'string' &&
        typeof parsed.callbackQueueId === 'string'
      ) {
        return {
          date: parsed.date,
          fromDid: parsed.fromDid,
          qrData: parsed.qrData,
          callbackQueueId: parsed.callbackQueueId,
        };
      }
    } catch {
      // malformed, fall through to clear
    }
    await storage.removeItem(this.prefix + `rescueInvite:${groupId}`);
    return null;
  }

  async setRescueInvite(
    groupId: string,
    invite: PendingRescueInvite,
  ): Promise<void> {
    await storage.setItem(
      this.prefix + `rescueInvite:${groupId}`,
      JSON.stringify(invite),
    );
  }

  async clearRescueInvite(groupId: string): Promise<void> {
    await storage.removeItem(this.prefix + `rescueInvite:${groupId}`);
  }

  /** 今天是否已经对该私聊拒绝过救援弹窗。 */
  async wasRescuePromptedToday(groupId: string, date: string): Promise<boolean> {
    const raw = await storage.getItem(this.prefix + `rescuePrompted:${groupId}`);
    return raw === date;
  }

  async setRescuePromptedToday(groupId: string, date: string): Promise<void> {
    await storage.setItem(this.prefix + `rescuePrompted:${groupId}`, date);
  }

  // -----------------------------------------------------------------------
  // 消息历史
  // -----------------------------------------------------------------------

  async putMessage(msg: StoredMessage): Promise<void> {
    const storageKey = msg.conversationId ?? (msg.fromDid === this.userDid ? msg.toDid : msg.fromDid);
    const key = this.prefix + `messages:${storageKey}`;
    const raw = await storage.getItem(key);
    const messages: StoredMessage[] = raw ? JSON.parse(raw) : [];
    messages.push(msg);
    await storage.setItem(key, JSON.stringify(messages));
  }

  async getMessages(groupId: string): Promise<StoredMessage[]> {
    const raw = await storage.getItem(this.prefix + `messages:${groupId}`);
    if (!raw) return [];
    const messages = JSON.parse(raw) as StoredMessage[];
    return messages;
  }

  async hasMessage(conversationId: string, messageId: string): Promise<boolean> {
    const raw = await storage.getItem(this.prefix + `messages:${conversationId}`);
    if (!raw) return false;
    const messages = JSON.parse(raw) as StoredMessage[];
    return messages.some((m) => m.id === messageId);
  }

  async getMessagesPaginated(
    groupId: string,
    beforeId?: string,
    limit = 50,
  ): Promise<{ messages: StoredMessage[]; hasMore: boolean }> {
    const all = await this.getMessages(groupId);
    if (beforeId === undefined) {
      const slice = all.slice(-limit);
      return { messages: slice.slice().reverse(), hasMore: all.length > limit };
    }
    const idx = all.findIndex((m) => m.id === beforeId);
    if (idx === -1) {
      return { messages: [], hasMore: false };
    }
    const slice = all.slice(Math.max(0, idx - limit), idx);
    return { messages: slice.slice().reverse(), hasMore: idx > limit };
  }

  async getMessagesAfter(groupId: string, afterId: string): Promise<StoredMessage[]> {
    const all = await this.getMessages(groupId);
    const idx = all.findIndex((m) => m.id === afterId);
    if (idx === -1) return [];
    return all.slice(idx + 1);
  }

  async markMessagesAsRead(groupId: string): Promise<void> {
    const key = this.prefix + `messages:${groupId}`;
    const raw = await storage.getItem(key);
    if (!raw) return;
    const messages = JSON.parse(raw) as StoredMessage[];
    let changed = false;
    const now = new Date().toISOString();
    const updated = messages.map((msg) => {
      if (msg.fromDid !== this.userDid && !msg.readAt) {
        changed = true;
        return { ...msg, readAt: now };
      }
      return msg;
    });
    if (changed) {
      await storage.setItem(key, JSON.stringify(updated));
    }
  }

  async updateFileMessageMeta(
    conversationId: string,
    msgId: string,
    partial: Partial<FileMeta>,
  ): Promise<void> {
    const key = this.prefix + `messages:${conversationId}`;
    const raw = await storage.getItem(key);
    if (!raw) return;
    const messages: StoredMessage[] = JSON.parse(raw);
    const idx = messages.findIndex(m => m.id === msgId);
    if (idx === -1) return;
    messages[idx] = {
      ...messages[idx],
      fileMeta: { ...(messages[idx].fileMeta ?? {}), ...partial } as FileMeta,
    };
    await storage.setItem(key, JSON.stringify(messages));
  }

  async deleteMessages(groupId: string): Promise<void> {
    await storage.removeItem(this.prefix + `messages:${groupId}`);
  }

  async deleteMessage(conversationId: string, messageId: string): Promise<void> {
    const key = this.prefix + `messages:${conversationId}`;
    const raw = await storage.getItem(key);
    if (!raw) return;
    const messages = JSON.parse(raw) as StoredMessage[];
    const filtered = messages.filter((msg) => msg.id !== messageId);
    if (filtered.length === messages.length) return;
    await storage.setItem(key, JSON.stringify(filtered));
  }

  async addReaction(conversationId: string, messageId: string, reaction: Reaction): Promise<void> {
    const key = this.prefix + `messages:${conversationId}`;
    const raw = await storage.getItem(key);
    if (!raw) return;
    const messages: StoredMessage[] = JSON.parse(raw);
    const index = messages.findIndex((msg) => msg.id === messageId);
    if (index === -1) return;
    const existing = messages[index].reactions?.some((r) => r.did === reaction.did && r.emoji === reaction.emoji);
    if (existing) return;
    messages[index] = {
      ...messages[index],
      reactions: [...(messages[index].reactions ?? []), reaction],
    };
    await storage.setItem(key, JSON.stringify(messages));
  }

  async removeReaction(conversationId: string, messageId: string, did: string, emoji: string): Promise<void> {
    const key = this.prefix + `messages:${conversationId}`;
    const raw = await storage.getItem(key);
    if (!raw) return;
    const messages: StoredMessage[] = JSON.parse(raw);
    const index = messages.findIndex((msg) => msg.id === messageId);
    if (index === -1) return;
    const current = messages[index].reactions ?? [];
    const filtered = current.filter((r) => !(r.did === did && r.emoji === emoji));
    if (filtered.length === current.length) return;
    messages[index] = {
      ...messages[index],
      reactions: filtered,
    };
    await storage.setItem(key, JSON.stringify(messages));
  }

  async listGroups(): Promise<string[]> {
    const keys = await storage.getAllKeys();
    const msgPrefix = this.prefix + 'messages:';
    const mlsSessionPrefix = this.prefix + 'mlsSession:';
    const groups = new Set<string>();
    for (const k of keys) {
      if (k.startsWith(msgPrefix)) {
        groups.add(k.slice(msgPrefix.length));
      } else if (k.startsWith(mlsSessionPrefix)) {
        groups.add(k.slice(mlsSessionPrefix.length));
      }
    }
    const result = [...groups].filter((did) => did !== this.userDid);
    return result;
  }

  // -----------------------------------------------------------------------
  // QueueID LRU 去重集合
  // -----------------------------------------------------------------------

  async isQueueIdProcessed(queueId: string): Promise<boolean> {
    const raw = await storage.getItem(this.prefix + 'queueIdLru');
    if (!raw) return false;
    const entries = new Map<string, number>(JSON.parse(raw) as [string, number][]);
    return entries.has(queueId);
  }

  async markQueueIdProcessed(queueId: string): Promise<void> {
    const raw = await storage.getItem(this.prefix + 'queueIdLru');
    const entries: Map<string, number> = raw
      ? new Map(JSON.parse(raw))
      : new Map();

    entries.set(queueId, Date.now());

    // 超过上限时淘汰最旧的
    if (entries.size > QUEUEID_LRU_MAX) {
      const sorted = [...entries.entries()].sort((a, b) => a[1] - b[1]);
      const toRemove = sorted.slice(0, entries.size - QUEUEID_LRU_MAX);
      for (const [key] of toRemove) {
        entries.delete(key);
      }
    }

    await storage.setItem(
      this.prefix + 'queueIdLru',
      JSON.stringify([...entries]),
    );
  }

  /**
   * 清空 queueId LRU 去重集合（恢复备份后必调）。
   *
   * 背景：b 端用云端备份覆盖本地 mlsSession 后，新 mlsSession 是「a 端建群
   * 那一刻」的快照；b 端本地 `queueIdLru` 里残留**之前**用旧 mlsSession
   * 处理过 envelope 的标记。如果不清：
   *   - b 端 poller 拉到 a 端后续发的 envelope（commit wrapper / 群消息）
   *   - `isQueueIdProcessed(.) === true`（之前走过）
   *   - 跳过不 decrypt → mlsSession 永远不推进
   *   - b 端 exporterSecret 永远停在备份那一刻 → 后续 envelope 永远拉不到
   *   - b 端发消息也用旧 mlsSession → a 端解不开
   *
   * 清空后 b 端会重新 decrypt 这些 envelope：commit wrapper 推进 mlsSession
   * （自愈），群消息正常进入 chat-view。
   */
  async clearQueueIdLru(): Promise<void> {
    await storage.removeItem(this.prefix + 'queueIdLru');
  }

  // -----------------------------------------------------------------------
  // KeyPackage 池
  // -----------------------------------------------------------------------

  async putKeyPackagePool(entries: KeyPackagePoolEntry[]): Promise<void> {
    await storage.setItem(
      this.prefix + KEY_PACKAGE_POOL_KEY,
      JSON.stringify(entries),
    );
  }

  async getKeyPackagePool(): Promise<KeyPackagePoolEntry[]> {
    const raw = await storage.getItem(this.prefix + KEY_PACKAGE_POOL_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as KeyPackagePoolEntry[];
  }

  async addKeyPackageToPool(entry: KeyPackagePoolEntry): Promise<void> {
    const pool = await this.getKeyPackagePool();
    pool.push(entry);
    await this.putKeyPackagePool(pool);
  }

  async markKeyPackageConsumed(id: string): Promise<void> {
    const pool = await this.getKeyPackagePool();
    const updated = pool.map((entry) =>
      entry.id === id ? { ...entry, consumed: true } : entry,
    );
    await this.putKeyPackagePool(updated);
  }

  async removeKeyPackageFromPool(id: string): Promise<void> {
    const pool = await this.getKeyPackagePool();
    const filtered = pool.filter((entry) => entry.id !== id);
    await this.putKeyPackagePool(filtered);
  }

  // -----------------------------------------------------------------------
  // Pending Welcome 记录
  // -----------------------------------------------------------------------

  async putPendingWelcome(entry: PendingWelcome): Promise<void> {
    const key = this.prefix + `pendingWelcome:${entry.queueId}`;
    await storage.setItem(key, JSON.stringify(entry));
  }

  async getPendingWelcomes(): Promise<PendingWelcome[]> {
    const keys = await storage.getAllKeys();
    const prefix = this.prefix + 'pendingWelcome:';
    const welcomeKeys = keys.filter((k) => k.startsWith(prefix));
    const results: PendingWelcome[] = [];
    for (const k of welcomeKeys) {
      const raw = await storage.getItem(k);
      if (raw) results.push(JSON.parse(raw) as PendingWelcome);
    }
    return results.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async deletePendingWelcome(queueId: string): Promise<void> {
    await storage.removeItem(this.prefix + `pendingWelcome:${queueId}`);
  }

  // -----------------------------------------------------------------------
  // 群组元数据
  // -----------------------------------------------------------------------

  async putGroupInfo(info: GroupInfo): Promise<void> {
    const key = this.prefix + `groupInfo:${info.groupId}`;
    await storage.setItem(key, JSON.stringify(info));
  }

  async getGroupInfo(groupId: string): Promise<GroupInfo | null> {
    const raw = await storage.getItem(this.prefix + `groupInfo:${groupId}`);
    if (!raw) return null;
    return JSON.parse(raw) as GroupInfo;
  }

  async deleteGroupInfo(groupId: string): Promise<void> {
    await storage.removeItem(this.prefix + `groupInfo:${groupId}`);
  }

  async listGroupInfos(): Promise<GroupInfo[]> {
    const keys = await storage.getAllKeys();
    const prefix = this.prefix + 'groupInfo:';
    const groupKeys = keys.filter((k) => k.startsWith(prefix));
    const results: GroupInfo[] = [];
    for (const k of groupKeys) {
      const raw = await storage.getItem(k);
      if (raw) results.push(JSON.parse(raw) as GroupInfo);
    }
    return results;
  }

  // -----------------------------------------------------------------------
  // 群聊邀请记录
  // -----------------------------------------------------------------------

  async putPendingInvite(invite: PendingInvite): Promise<void> {
    const key = this.prefix + `pendingInvite:${invite.inviteId}`;
    await storage.setItem(key, JSON.stringify(invite));
  }

  async getPendingInvite(inviteId: string): Promise<PendingInvite | null> {
    const raw = await storage.getItem(this.prefix + `pendingInvite:${inviteId}`);
    if (!raw) return null;
    return JSON.parse(raw) as PendingInvite;
  }

  async updatePendingInviteStatus(
    inviteId: string,
    status: PendingInvite['status'],
  ): Promise<void> {
    const invite = await this.getPendingInvite(inviteId);
    if (!invite) return;
    await this.putPendingInvite({ ...invite, status });
  }

  async getPendingInvites(): Promise<PendingInvite[]> {
    const keys = await storage.getAllKeys();
    const prefix = this.prefix + 'pendingInvite:';
    const inviteKeys = keys.filter((k) => k.startsWith(prefix));
    const results: PendingInvite[] = [];
    for (const k of inviteKeys) {
      const raw = await storage.getItem(k);
      if (raw) results.push(JSON.parse(raw) as PendingInvite);
    }
    return results.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async deletePendingInvite(inviteId: string): Promise<void> {
    await storage.removeItem(this.prefix + `pendingInvite:${inviteId}`);
  }

  // -----------------------------------------------------------------------
  // 屏蔽列表（按 DID 屏蔽某人）
  // -----------------------------------------------------------------------

  async getBlockList(): Promise<string[]> {
    const raw = await storage.getItem(this.prefix + 'blockList');
    if (!raw) return [];
    return JSON.parse(raw) as string[];
  }

  async addBlockedDid(blockedDid: string): Promise<void> {
    const list = await this.getBlockList();
    if (list.includes(blockedDid)) return;
    list.push(blockedDid);
    await storage.setItem(this.prefix + 'blockList', JSON.stringify(list));
  }

  async removeBlockedDid(blockedDid: string): Promise<void> {
    const list = await this.getBlockList();
    const filtered = list.filter((d) => d !== blockedDid);
    if (filtered.length === list.length) return;
    await storage.setItem(this.prefix + 'blockList', JSON.stringify(filtered));
  }

  async isBlocked(did: string): Promise<boolean> {
    const list = await this.getBlockList();
    return list.includes(did);
  }

  async setBlockList(blockList: string[]): Promise<void> {
    await storage.setItem(this.prefix + 'blockList', JSON.stringify(blockList));
  }

  // -----------------------------------------------------------------------
  // 设置
  // -----------------------------------------------------------------------

  private readonly POLL_BATCH_SIZE_KEY = 'pollBatchSize';

  async getPollBatchSize(): Promise<number> {
    const raw = await storage.getItem(this.prefix + this.POLL_BATCH_SIZE_KEY);
    if (!raw) return 3;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n >= 1 && n <= 20 ? n : 3;
  }

  async setPollBatchSize(size: number): Promise<void> {
    const clamped = Math.max(1, Math.min(20, size));
    await storage.setItem(this.prefix + this.POLL_BATCH_SIZE_KEY, String(clamped));
  }

  private readonly APPVIEW_PROXY_KEY = 'appViewProxy';

  async getAppViewProxy(): Promise<string> {
    const raw = await storage.getItem(this.prefix + this.APPVIEW_PROXY_KEY);
    return raw ?? DEFAULT_APPVIEW_PROXY;
  }

  async setAppViewProxy(value: string): Promise<void> {
    const trimmed = value.trim();
    await storage.setItem(
      this.prefix + this.APPVIEW_PROXY_KEY,
      trimmed || DEFAULT_APPVIEW_PROXY,
    );
  }

  private readonly DME_SERVER_URL_KEY = 'dmeServerUrl';

  async getDmeServerUrl(): Promise<string> {
    const raw = await storage.getItem(this.prefix + this.DME_SERVER_URL_KEY);
    return raw ?? DME_SERVER_URL;
  }

  async setDmeServerUrl(value: string): Promise<void> {
    const trimmed = value.trim();
    await storage.setItem(
      this.prefix + this.DME_SERVER_URL_KEY,
      trimmed || DME_SERVER_URL,
    );
  }

  private readonly DME_GATEWAY_URL_KEY = 'dmeGatewayUrl';

  async getDmeGatewayUrl(): Promise<string> {
    const raw = await storage.getItem(this.prefix + this.DME_GATEWAY_URL_KEY);
    return raw ?? DEFAULT_DME_GATEWAY_URL;
  }

  async setDmeGatewayUrl(value: string): Promise<void> {
    const trimmed = value.trim();
    await storage.setItem(
      this.prefix + this.DME_GATEWAY_URL_KEY,
      trimmed || DEFAULT_DME_GATEWAY_URL,
    );
  }

  private readonly SOUND_ENABLED_KEY = 'soundEnabled';

  async getSoundEnabled(): Promise<boolean> {
    const raw = await storage.getItem(this.prefix + this.SOUND_ENABLED_KEY);
    return raw !== 'false';
  }

  async setSoundEnabled(enabled: boolean): Promise<void> {
    await storage.setItem(this.prefix + this.SOUND_ENABLED_KEY, String(enabled));
  }

  // -----------------------------------------------------------------------
  // 密钥轮换（key-rotation-plan.md 1.1 / 1.3 / 1.4 / 1.6）
  // -----------------------------------------------------------------------

  private readonly KEY_ROTATION_INTERVAL_KEY = 'keyRotationIntervalMs';

  /** 轮换周期（毫秒），默认 7 天。无关闭项（安全不设退出）。 */
  async getKeyRotationIntervalMs(): Promise<number> {
    const raw = await storage.getItem(this.prefix + this.KEY_ROTATION_INTERVAL_KEY);
    const parsed = raw !== null ? Number(raw) : NaN;
    return Number.isFinite(parsed) && parsed > 0
      ? parsed
      : 7 * 24 * 60 * 60 * 1000;
  }

  async setKeyRotationIntervalMs(ms: number): Promise<void> {
    await storage.setItem(this.prefix + this.KEY_ROTATION_INTERVAL_KEY, String(ms));
  }

  /** 每会话最近一次轮换时间戳（0 = 从未轮换）。 */
  async getLastRotationAt(groupId: string): Promise<number> {
    const raw = await storage.getItem(this.prefix + `rotationAt:${groupId}`);
    const parsed = raw !== null ? Number(raw) : NaN;
    return Number.isFinite(parsed) ? parsed : 0;
  }

  async setLastRotationAt(groupId: string, ts: number): Promise<void> {
    await storage.setItem(this.prefix + `rotationAt:${groupId}`, String(ts));
  }

  /**
   * 账号级 commit 高水位（宣言 v2）：本端已完成的 commit 计数，随备份走。
   * 每次成功 commit 单调 +1；commit 前与 PDS 宣言比对检测备份分叉。
   */
  async getCommitSeq(): Promise<number> {
    const raw = await storage.getItem(this.prefix + 'commitSeq');
    const parsed = raw !== null ? Number(raw) : NaN;
    return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;
  }

  async setCommitSeq(seq: number): Promise<void> {
    await storage.setItem(this.prefix + 'commitSeq', String(Math.max(0, Math.floor(seq))));
  }

  /**
   * 会话异常标记（持久化）：
   * - 'sibling-rotated'：同账号另一台设备已轮换，本机无法应用其 commit，
   *   唯一恢复路径是恢复最新备份（1.6）；
   * - 'desynced'：普通成员的 commit 应用失败/解密脱钩，需重新握手（1.4）；
   * - 'forked'：群 commit 谱系分叉（谱系账本检出同 seq 异 queueId，
   *   group-fork-plan.md 3.1），恢复路径与 sibling-rotated 相同：恢复权威
   *   世界（群主拍板侧）的最新备份。
   */
  async getSessionIssue(
    groupId: string,
  ): Promise<'sibling-rotated' | 'desynced' | 'forked' | null> {
    const raw = await storage.getItem(this.prefix + `sessionIssue:${groupId}`);
    if (raw === 'sibling-rotated' || raw === 'desynced' || raw === 'forked') {
      return raw;
    }
    return null;
  }

  /**
   * desynced 标记的补充信息：触发该标记的 commit 发送者 DID。
   * 仅 desynced 有值（sibling-rotated 无需），供横幅「oo」展示，随标记清除。
   */
  async getSessionIssueSender(groupId: string): Promise<string | null> {
    const raw = await storage.getItem(this.prefix + `sessionIssueSender:${groupId}`);
    return raw ?? null;
  }

  async setSessionIssue(
    groupId: string,
    issue: 'sibling-rotated' | 'desynced' | 'forked' | null,
    senderDid?: string,
  ): Promise<void> {
    const key = this.prefix + `sessionIssue:${groupId}`;
    const senderKey = this.prefix + `sessionIssueSender:${groupId}`;
    if (issue === null) {
      await storage.removeItem(key);
      await storage.removeItem(senderKey);
    } else {
      await storage.setItem(key, issue);
      if (senderDid) {
        await storage.setItem(senderKey, senderDid);
      } else {
        await storage.removeItem(senderKey);
      }
    }
  }

  /** 清除全部会话异常标记（备份恢复后状态整体重建，旧标记作废）。 */
  async clearAllSessionIssues(): Promise<void> {
    const keys = await storage.getAllKeys();
    const issueKeys = keys.filter(
      (k) =>
        k.startsWith(this.prefix + 'sessionIssue:') ||
        k.startsWith(this.prefix + 'sessionIssueSender:'),
    );
    if (issueKeys.length > 0) {
      await Promise.all(issueKeys.map((key) => storage.removeItem(key)));
    }
  }

  // -----------------------------------------------------------------------
  // 群 commit 谱系账本（P1，group-fork-plan.md 3.1）
  //
  // per-group 单调 seq：commit 发起方按 last+1 预留；每条 seq 记录「已见
  // queueId 集合」（1v1 扇出的同一逻辑 commit 有多份不同 queueId 的副本，
  // 发送方记录全部、接收方只见到自己那份）。分叉铁证 = 同 seq 出现集合外
  // 的 queueId。seq 缺口（发送方预留后投递失败/崩溃）容忍不判定——账本是
  // 观测层，不是 MLS 应用的一部分。
  // -----------------------------------------------------------------------

  private groupCommitLastSeqKey(groupId: string): string {
    return this.prefix + `groupCommitLastSeq:${groupId}`;
  }

  private groupCommitEntryKey(groupId: string, seq: number): string {
    return this.prefix + `groupCommitLedger:${groupId}:${seq}`;
  }

  async getGroupCommitLastSeq(groupId: string): Promise<number> {
    const raw = await storage.getItem(this.groupCommitLastSeqKey(groupId));
    const parsed = raw !== null ? Number(raw) : NaN;
    return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;
  }

  async setGroupCommitLastSeq(groupId: string, seq: number): Promise<void> {
    await storage.setItem(
      this.groupCommitLastSeqKey(groupId),
      String(Math.max(0, Math.floor(seq))),
    );
  }

  async getGroupCommitEntry(
    groupId: string,
    seq: number,
  ): Promise<GroupCommitLedgerEntry | null> {
    const raw = await storage.getItem(this.groupCommitEntryKey(groupId, seq));
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as {
        queueIds?: unknown;
        parentQueueId?: unknown;
      };
      if (!Array.isArray(parsed.queueIds)) return null;
      return {
        queueIds: parsed.queueIds.filter(
          (q): q is string => typeof q === 'string',
        ),
        parentQueueId:
          typeof parsed.parentQueueId === 'string'
            ? parsed.parentQueueId
            : null,
      };
    } catch {
      return null;
    }
  }

  /**
   * 向 seq 条目追加一个已投递/已观测的 queueId（幂等）；条目不存在则创建
   * （parentQueueId 取首个非空值）。顺带把 lastSeq 推高到 max(last, seq)。
   */
  async appendGroupCommitQueueId(
    groupId: string,
    seq: number,
    queueId: string,
    parentQueueId?: string | null,
  ): Promise<void> {
    const entry = await this.getGroupCommitEntry(groupId, seq);
    const queueIds = entry ? [...entry.queueIds] : [];
    if (!queueIds.includes(queueId)) queueIds.push(queueId);
    const parent = entry?.parentQueueId ?? parentQueueId ?? null;
    await storage.setItem(
      this.groupCommitEntryKey(groupId, seq),
      JSON.stringify({ queueIds, parentQueueId: parent }),
    );
    const last = await this.getGroupCommitLastSeq(groupId);
    if (seq > last) await this.setGroupCommitLastSeq(groupId, seq);
  }

  /**
   * 收端观测：commit 信封到达（无论能否解密）时调用。
   * - 'duplicate'：queueId 已在账本（自己发的重放 / 重复投递），忽略；
   * - 'fork'：同 seq 出现集合外 queueId —— 分叉铁证（group-fork-plan.md 3.1）；
   * - 'new'：首见，记录入账。
   * 'fork' 时**不**写入账本：账本只保留本端实际所在的谱系。
   */
  async observeGroupCommit(
    groupId: string,
    seq: number,
    queueId: string,
  ): Promise<'new' | 'duplicate' | 'fork'> {
    if (!Number.isInteger(seq) || seq < 1) return 'new';
    const entry = await this.getGroupCommitEntry(groupId, seq);
    if (entry) {
      return entry.queueIds.includes(queueId) ? 'duplicate' : 'fork';
    }
    await this.appendGroupCommitQueueId(groupId, seq, queueId);
    return 'new';
  }

  /**
   * 发送方预留序号：last+1（立即落盘，先于投递——投递中途失败/崩溃时该
   * seq 留空缺，收端容忍缺口，绝不复用已预留的 seq 制造同 seq 异 queueId
   * 的假分叉）。parentQueueId 取最近一条有 queueId 的条目（最多回溯 5 档，
   * 跳过预留后未投出的空洞）。
   */
  async reserveGroupCommit(
    groupId: string,
  ): Promise<{ seq: number; parentQueueId: string | null }> {
    const seq = (await this.getGroupCommitLastSeq(groupId)) + 1;
    await this.setGroupCommitLastSeq(groupId, seq);
    let parentQueueId: string | null = null;
    for (let s = seq - 1; s >= 1 && s > seq - 6; s--) {
      const entry = await this.getGroupCommitEntry(groupId, s);
      if (entry && entry.queueIds.length > 0) {
        parentQueueId = entry.queueIds[0];
        break;
      }
    }
    return { seq, parentQueueId };
  }

  /** 导出全部谱系账本（随备份上云；恢复时经 importGroupCommitLedger 写回）。 */
  async exportGroupCommitLedger(): Promise<{
    lastSeq: Record<string, number>;
    entries: Record<string, GroupCommitLedgerEntry>;
  }> {
    const keys = await storage.getAllKeys();
    const lastSeq: Record<string, number> = {};
    const entries: Record<string, GroupCommitLedgerEntry> = {};
    const lastPrefix = this.prefix + 'groupCommitLastSeq:';
    const entryPrefix = this.prefix + 'groupCommitLedger:';
    for (const key of keys) {
      if (key.startsWith(lastPrefix)) {
        const groupId = key.slice(lastPrefix.length);
        const parsed = Number(await storage.getItem(key));
        if (groupId && Number.isFinite(parsed) && parsed >= 0) {
          lastSeq[groupId] = Math.floor(parsed);
        }
      } else if (key.startsWith(entryPrefix)) {
        const rest = key.slice(entryPrefix.length);
        const sep = rest.lastIndexOf(':');
        if (sep <= 0) continue;
        const groupId = rest.slice(0, sep);
        const seq = Number(rest.slice(sep + 1));
        const entry = await this.getGroupCommitEntry(
          groupId,
          Number.isFinite(seq) ? Math.floor(seq) : -1,
        );
        if (groupId && entry) {
          entries[`${groupId}:${Math.floor(seq)}`] = entry;
        }
      }
    }
    return { lastSeq, entries };
  }

  /** 恢复备份时整体写回谱系账本（覆盖式，以备份为权威快照）。 */
  async importGroupCommitLedger(data: {
    lastSeq?: Record<string, number>;
    entries?: Record<string, GroupCommitLedgerEntry>;
  }): Promise<void> {
    // 先清本机旧账本（恢复是全量收敛，不做合并）
    const keys = await storage.getAllKeys();
    const staleKeys = keys.filter(
      (k) =>
        k.startsWith(this.prefix + 'groupCommitLastSeq:') ||
        k.startsWith(this.prefix + 'groupCommitLedger:'),
    );
    if (staleKeys.length > 0) {
      await Promise.all(staleKeys.map((key) => storage.removeItem(key)));
    }
    for (const [groupId, seq] of Object.entries(data.lastSeq ?? {})) {
      if (Number.isFinite(seq) && seq >= 0) {
        await this.setGroupCommitLastSeq(groupId, Math.floor(seq));
      }
    }
    for (const [key, entry] of Object.entries(data.entries ?? {})) {
      const sep = key.lastIndexOf(':');
      if (sep <= 0 || !Array.isArray(entry?.queueIds)) continue;
      const groupId = key.slice(0, sep);
      const seq = Number(key.slice(sep + 1));
      if (!groupId || !Number.isInteger(seq) || seq < 1) continue;
      await storage.setItem(
        this.groupCommitEntryKey(groupId, seq),
        JSON.stringify({
          queueIds: entry.queueIds,
          parentQueueId: entry.parentQueueId ?? null,
        }),
      );
    }
  }

  // -----------------------------------------------------------------------
  // 备份联动（1.5）：轮换后未自动刷新备份时的强提示标记
  // -----------------------------------------------------------------------

  private readonly BACKUP_REQUIRED_KEY = 'backupRequired';

  async isBackupRequired(): Promise<boolean> {
    return (await storage.getItem(this.prefix + this.BACKUP_REQUIRED_KEY)) === '1';
  }

  async setBackupRequired(required: boolean): Promise<void> {
    const key = this.prefix + this.BACKUP_REQUIRED_KEY;
    if (required) {
      await storage.setItem(key, '1');
    } else {
      await storage.removeItem(key);
    }
  }

  // -----------------------------------------------------------------------
  // 清除全部数据（切换账号 / 注销）
  // -----------------------------------------------------------------------

  async clear(): Promise<void> {
    const keys = await storage.getAllKeys();
    const dmeKeys = keys.filter((k) => k.startsWith(this.prefix));
    if (dmeKeys.length > 0) {
      await Promise.all(dmeKeys.map((key) => storage.removeItem(key)));
    }
  }
}

// ---------------------------------------------------------------------------
// Base64 helpers（Uint8Array 序列化）
// ---------------------------------------------------------------------------

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
