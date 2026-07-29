/**
 * storage/db.ts - AsyncStorage 持久化层。
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

import AsyncStorage from '@react-native-async-storage/async-storage';

import type { IdentityKeys } from '../crypto/identity';
import type { GroupInfo, PendingInvite } from '../protocol/group-message';
import { DEFAULT_APPVIEW_PROXY } from '../config';

export type MessageKind = 'text' | 'group_invite' | 'group_system';

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

const QUEUEID_LRU_MAX = 1000;

const KEY_PACKAGE_POOL_KEY = 'keyPackagePool';

/**
 * AsyncStorage 封装，所有 key 以 `dme:<did>:` 为前缀。
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
    await AsyncStorage.setItem(this.prefix + key, value);
  }

  async getRaw(key: string): Promise<string | null> {
    return AsyncStorage.getItem(this.prefix + key);
  }

  async deleteRaw(key: string): Promise<void> {
    await AsyncStorage.removeItem(this.prefix + key);
  }

  // -----------------------------------------------------------------------
  // 身份密钥
  // -----------------------------------------------------------------------

  async putIdentityKeys(keys: IdentityKeys): Promise<void> {
    await AsyncStorage.setItem(
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
    const raw = await AsyncStorage.getItem(this.prefix + 'identity');
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
    await AsyncStorage.setItem(this.prefix + `mlsSession:${groupId}`, serialized);
  }

  async getMlsSession(groupId: string): Promise<string | null> {
    return AsyncStorage.getItem(this.prefix + `mlsSession:${groupId}`);
  }

  async deleteMlsSession(groupId: string): Promise<void> {
    await AsyncStorage.removeItem(this.prefix + `mlsSession:${groupId}`);
  }

  // -----------------------------------------------------------------------
  // 消息历史
  // -----------------------------------------------------------------------

  async putMessage(msg: StoredMessage): Promise<void> {
    const storageKey = msg.conversationId ?? (msg.fromDid === this.userDid ? msg.toDid : msg.fromDid);
    const key = this.prefix + `messages:${storageKey}`;
    const raw = await AsyncStorage.getItem(key);
    const messages: StoredMessage[] = raw ? JSON.parse(raw) : [];
    messages.push(msg);
    await AsyncStorage.setItem(key, JSON.stringify(messages));
  }

  async getMessages(groupId: string): Promise<StoredMessage[]> {
    const raw = await AsyncStorage.getItem(this.prefix + `messages:${groupId}`);
    if (!raw) return [];
    const messages = JSON.parse(raw) as StoredMessage[];
    return messages;
  }

  async markMessagesAsRead(groupId: string): Promise<void> {
    const key = this.prefix + `messages:${groupId}`;
    const raw = await AsyncStorage.getItem(key);
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
      await AsyncStorage.setItem(key, JSON.stringify(updated));
    }
  }

  async deleteMessages(groupId: string): Promise<void> {
    await AsyncStorage.removeItem(this.prefix + `messages:${groupId}`);
  }

  async listGroups(): Promise<string[]> {
    const keys = await AsyncStorage.getAllKeys();
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
    const raw = await AsyncStorage.getItem(this.prefix + 'queueIdLru');
    if (!raw) return false;
    const entries = new Map<string, number>(JSON.parse(raw) as [string, number][]);
    return entries.has(queueId);
  }

  async markQueueIdProcessed(queueId: string): Promise<void> {
    const raw = await AsyncStorage.getItem(this.prefix + 'queueIdLru');
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

    await AsyncStorage.setItem(
      this.prefix + 'queueIdLru',
      JSON.stringify([...entries]),
    );
  }

  // -----------------------------------------------------------------------
  // KeyPackage 池
  // -----------------------------------------------------------------------

  async putKeyPackagePool(entries: KeyPackagePoolEntry[]): Promise<void> {
    await AsyncStorage.setItem(
      this.prefix + KEY_PACKAGE_POOL_KEY,
      JSON.stringify(entries),
    );
  }

  async getKeyPackagePool(): Promise<KeyPackagePoolEntry[]> {
    const raw = await AsyncStorage.getItem(this.prefix + KEY_PACKAGE_POOL_KEY);
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
    await AsyncStorage.setItem(key, JSON.stringify(entry));
  }

  async getPendingWelcomes(): Promise<PendingWelcome[]> {
    const keys = await AsyncStorage.getAllKeys();
    const prefix = this.prefix + 'pendingWelcome:';
    const welcomeKeys = keys.filter((k) => k.startsWith(prefix));
    const results: PendingWelcome[] = [];
    for (const k of welcomeKeys) {
      const raw = await AsyncStorage.getItem(k);
      if (raw) results.push(JSON.parse(raw) as PendingWelcome);
    }
    return results.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async deletePendingWelcome(queueId: string): Promise<void> {
    await AsyncStorage.removeItem(this.prefix + `pendingWelcome:${queueId}`);
  }

  // -----------------------------------------------------------------------
  // 群组元数据
  // -----------------------------------------------------------------------

  async putGroupInfo(info: GroupInfo): Promise<void> {
    const key = this.prefix + `groupInfo:${info.groupId}`;
    await AsyncStorage.setItem(key, JSON.stringify(info));
  }

  async getGroupInfo(groupId: string): Promise<GroupInfo | null> {
    const raw = await AsyncStorage.getItem(this.prefix + `groupInfo:${groupId}`);
    if (!raw) return null;
    return JSON.parse(raw) as GroupInfo;
  }

  async deleteGroupInfo(groupId: string): Promise<void> {
    await AsyncStorage.removeItem(this.prefix + `groupInfo:${groupId}`);
  }

  async listGroupInfos(): Promise<GroupInfo[]> {
    const keys = await AsyncStorage.getAllKeys();
    const prefix = this.prefix + 'groupInfo:';
    const groupKeys = keys.filter((k) => k.startsWith(prefix));
    const results: GroupInfo[] = [];
    for (const k of groupKeys) {
      const raw = await AsyncStorage.getItem(k);
      if (raw) results.push(JSON.parse(raw) as GroupInfo);
    }
    return results;
  }

  // -----------------------------------------------------------------------
  // 群聊邀请记录
  // -----------------------------------------------------------------------

  async putPendingInvite(invite: PendingInvite): Promise<void> {
    const key = this.prefix + `pendingInvite:${invite.inviteId}`;
    await AsyncStorage.setItem(key, JSON.stringify(invite));
  }

  async getPendingInvite(inviteId: string): Promise<PendingInvite | null> {
    const raw = await AsyncStorage.getItem(this.prefix + `pendingInvite:${inviteId}`);
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
    const keys = await AsyncStorage.getAllKeys();
    const prefix = this.prefix + 'pendingInvite:';
    const inviteKeys = keys.filter((k) => k.startsWith(prefix));
    const results: PendingInvite[] = [];
    for (const k of inviteKeys) {
      const raw = await AsyncStorage.getItem(k);
      if (raw) results.push(JSON.parse(raw) as PendingInvite);
    }
    return results.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async deletePendingInvite(inviteId: string): Promise<void> {
    await AsyncStorage.removeItem(this.prefix + `pendingInvite:${inviteId}`);
  }

  // -----------------------------------------------------------------------
  // 设置
  // -----------------------------------------------------------------------

  private readonly POLL_BATCH_SIZE_KEY = 'pollBatchSize';

  async getPollBatchSize(): Promise<number> {
    const raw = await AsyncStorage.getItem(this.prefix + this.POLL_BATCH_SIZE_KEY);
    if (!raw) return 3;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n >= 1 && n <= 20 ? n : 3;
  }

  async setPollBatchSize(size: number): Promise<void> {
    const clamped = Math.max(1, Math.min(20, size));
    await AsyncStorage.setItem(this.prefix + this.POLL_BATCH_SIZE_KEY, String(clamped));
  }

  private readonly APPVIEW_PROXY_KEY = 'appViewProxy';

  async getAppViewProxy(): Promise<string> {
    const raw = await AsyncStorage.getItem(this.prefix + this.APPVIEW_PROXY_KEY);
    return raw ?? DEFAULT_APPVIEW_PROXY;
  }

  async setAppViewProxy(value: string): Promise<void> {
    const trimmed = value.trim();
    await AsyncStorage.setItem(
      this.prefix + this.APPVIEW_PROXY_KEY,
      trimmed || DEFAULT_APPVIEW_PROXY,
    );
  }

  // -----------------------------------------------------------------------
  // 清除全部数据（切换账号 / 注销）
  // -----------------------------------------------------------------------

  async clear(): Promise<void> {
    const keys = await AsyncStorage.getAllKeys();
    const dmeKeys = keys.filter((k) => k.startsWith(this.prefix));
    if (dmeKeys.length > 0) {
      await Promise.all(dmeKeys.map((key) => AsyncStorage.removeItem(key)));
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
