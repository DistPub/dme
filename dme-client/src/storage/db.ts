/**
 * storage/db.ts - AsyncStorage 持久化层。
 *
 * 存储所有客户端长期状态：
 *   1. 身份密钥对（X25519，每用户一份）
 *   2. Double Ratchet 状态（每个对话一份）
 *   3. 消息历史（解密后的明文 + 元数据）
 *   4. QueueID LRU 集合（去重，~1000 条 / ~64KB）
 *   5. 会话数据（accessJwt / refreshJwt）
 *
 * 所有数据以 DID 为前缀命名空间，切换账号互不干扰。
 *
 * QueueID LRU 实现 Q3 决策：ratchet 推进天然去重（旧 chain key 销毁），
 * 崩溃恢复时用 LRU 集合兜底。
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

import type { IdentityKey } from '../crypto/identity';

/** 存储的消息记录。 */
export interface StoredMessage {
  id: string;
  fromDid: string;
  toDid: string;
  plaintext: string;
  createdAt: string;
  sent: boolean;
}

/** 好友申请记录。 */
export interface PendingInvite {
  bobDid: string;
  bobHandle: string;
  queueId1: string;
  postUri: string;
  status: 'pending' | 'accepted' | 'failed';
  createdAt: string;
}

const QUEUEID_LRU_MAX = 1000;

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

  async putIdentityKey(key: IdentityKey): Promise<void> {
    await AsyncStorage.setItem(
      this.prefix + 'identity',
      JSON.stringify(key, (k, v) => {
        // Uint8Array -> base64
        if (v instanceof Uint8Array) {
          return { __type: 'Uint8Array', data: bytesToBase64(v) };
        }
        return v;
      }),
    );
  }

  async getIdentityKey(): Promise<IdentityKey | null> {
    const raw = await AsyncStorage.getItem(this.prefix + 'identity');
    if (!raw) return null;
    return JSON.parse(raw, (k, v) => {
      if (v && typeof v === 'object' && v.__type === 'Uint8Array') {
        return base64ToBytes(v.data);
      }
      return v;
    }) as IdentityKey;
  }

  // -----------------------------------------------------------------------
  // Ratchet 状态
  // -----------------------------------------------------------------------

  async putRatchet(friendDid: string, serialized: string): Promise<void> {
    await AsyncStorage.setItem(this.prefix + `ratchet:${friendDid}`, serialized);
  }

  async getRatchet(friendDid: string): Promise<string | null> {
    return AsyncStorage.getItem(this.prefix + `ratchet:${friendDid}`);
  }

  async deleteRatchet(friendDid: string): Promise<void> {
    await AsyncStorage.removeItem(this.prefix + `ratchet:${friendDid}`);
  }

  async putActivationQueueId(friendDid: string, queueId: string): Promise<void> {
    await AsyncStorage.setItem(this.prefix + `activationQueueId:${friendDid}`, queueId);
  }

  async getActivationQueueId(friendDid: string): Promise<string | null> {
    return AsyncStorage.getItem(this.prefix + `activationQueueId:${friendDid}`);
  }

  async deleteActivationQueueId(friendDid: string): Promise<void> {
    await AsyncStorage.removeItem(this.prefix + `activationQueueId:${friendDid}`);
  }

  // -----------------------------------------------------------------------
  // 消息历史
  // -----------------------------------------------------------------------

  async putMessage(msg: StoredMessage): Promise<void> {
    const friendDid = msg.fromDid === this.userDid ? msg.toDid : msg.fromDid;
    const key = this.prefix + `messages:${friendDid}`;
    const raw = await AsyncStorage.getItem(key);
    const messages: StoredMessage[] = raw ? JSON.parse(raw) : [];
    messages.push(msg);
    await AsyncStorage.setItem(key, JSON.stringify(messages));
  }

  async getMessages(friendDid: string): Promise<StoredMessage[]> {
    const raw = await AsyncStorage.getItem(this.prefix + `messages:${friendDid}`);
    if (!raw) return [];
    const messages = JSON.parse(raw) as StoredMessage[];
    return messages.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async deleteMessages(friendDid: string): Promise<void> {
    await AsyncStorage.removeItem(this.prefix + `messages:${friendDid}`);
  }

  async listFriends(): Promise<string[]> {
    const keys = await AsyncStorage.getAllKeys();
    const msgPrefix = this.prefix + 'messages:';
    const ratchetPrefix = this.prefix + 'ratchet:';
    const friends = new Set<string>();
    for (const k of keys) {
      if (k.startsWith(msgPrefix)) {
        friends.add(k.slice(msgPrefix.length));
      } else if (k.startsWith(ratchetPrefix)) {
        friends.add(k.slice(ratchetPrefix.length));
      }
    }
    const result = [...friends].filter((did) => did !== this.userDid);
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
  // 好友申请记录
  // -----------------------------------------------------------------------

  async putPendingInvite(invite: PendingInvite): Promise<void> {
    const key = this.prefix + `pendingInvite:${invite.bobDid}`;
    await AsyncStorage.setItem(key, JSON.stringify(invite));
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

  async deletePendingInvite(bobDid: string): Promise<void> {
    await AsyncStorage.removeItem(this.prefix + `pendingInvite:${bobDid}`);
  }

  // -----------------------------------------------------------------------
  // 清除全部数据（切换账号 / 注销）
  // -----------------------------------------------------------------------

  async clear(): Promise<void> {
    const keys = await AsyncStorage.getAllKeys();
    const dmeKeys = keys.filter((k) => k.startsWith(this.prefix));
    if (dmeKeys.length > 0) {
      await AsyncStorage.multiRemove(dmeKeys);
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
