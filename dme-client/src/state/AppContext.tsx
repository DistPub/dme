/**
 * state/AppContext.tsx - Global app state + actions for DME (MLS).
 *
 * Manages session, identity keys, MLS sessions, poller, and KeyPackage pool.
 * All async operations flow through here.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { AppState as RNAppState } from 'react-native';
import { storage as globalStorage } from '../storage/backend';
import { sha256 } from '@noble/hashes/sha256';
import type { KeyPackage, PrivateKeyPackage } from 'ts-mls';

import { DmeSession } from '../atproto/session';
import { DmePds } from '../atproto/pds';
import { declareKeys, getRemoteEncryptionKey, getRemoteSigningKey, resolvePdsUrl } from '../atproto/did';
import { resolveHandleCached } from '../atproto/profile-cache';
import { acceptInvite, processWelcome, prepareInviteQr } from '../handshake/handshake';
import { decodeAndDecryptQr } from '../handshake/qr-decode';
import { encodeQrPayload } from '../handshake/qr-encode';
import { DmePoller } from '../poll/poller';
import type { IncomingMessage, IncomingWelcome } from '../poll/poller';
import { DmeStorage } from '../storage/db';
import type { PendingWelcome, KeyPackagePoolEntry, StoredMessage } from '../storage/db';
import { generateIdentityKeys } from '../crypto/identity';
import type { IdentityKeys } from '../crypto/identity';
import { MlsSession } from '../crypto/mls-session';
import { deliverCommitViaGroupSpace } from './commit-delivery';
import { clearBackupPassword, getBackupPassword, saveBackupPassword } from '../crypto/password-cache';
import { maybeRotateGroups, type RotationDeps } from '../crypto/rotation';
import type { BackupLockHandle, RotationClaimStore } from '../crypto/rotation-claim';
import { acquireBackupLock, acquireRotationClaim, deriveRotationClaimParams, inspectClaimWatermark, peekCommitSeq, releaseBackupLock, releaseRotationClaim } from '../crypto/rotation-claim';
import { getNobleMlsImpl } from '../crypto/mls-noble-kdf';
import { KEYPACKAGE_POOL_SIZE } from '../crypto/mls-config';
import {
  generateKeyPackageForUser,
  encryptKeyPackage,
  serializeEncryptedKeyPackage,
} from '../crypto/keypackage';
import type { KeyPackagePair } from '../crypto/keypackage';
import type { BackupMeta } from '../protocol/types';
import type { PendingRescueInvite } from '../protocol/rescue';
import { deriveWelcomeQueueId } from '../crypto/mls-queue-id';
import {
  computeRescueSharedSecret,
  createRescueNonce,
  decryptRescueMessage,
  deriveRescueQueueId,
  encryptRescueMessage,
} from '../crypto/rescue-handshake';
import { encryptBackup, decryptBackup, computeSessionFingerprints, cloudHasUnknownSessions, type FullBackupData } from '../crypto/backup';
import { getOrCreateDeviceId, getPlatformLabel, formatDeviceLabel } from '../utils/device-id';
import { bytesToBase64url, base64urlToBytes, bytesToBase64, hexToBytes, bytesToHex, base64ToBytes } from '../crypto/utils';
import {
  generateFileId,
  generateFileKey,
  encryptChunk,
  decryptChunk,
  computeSha256,
} from '../crypto/file-crypto';
import { cacheFile, getCachedFileBytes, makeIndexedDbUri } from '../utils/file-cache';
import { generateVideoThumbnail } from '../utils/video-thumbnail';
import * as FileSystem from 'expo-file-system';
import { Platform } from 'react-native';
import { DME_SERVER_URL, PDS_URL, DEFAULT_APPVIEW_PROXY, DEFAULT_DME_GATEWAY_URL } from '../config';
import { type DmeBlobRef, type DmeEnvelope, type FileManifestMessage, FILE_MANIFEST_TYPE, type PostMessage, POST_MESSAGE_TYPE } from '../protocol/types';
import type { ReactionMessage } from '../protocol/reaction';
import type {
  GroupInfo,
  GroupMember,
  PendingInvite,
  GroupMessage,
  GroupInviteRequest,
  GroupInviteResponse,
  GroupWelcome,
  GroupMetadataUpdate,
  GroupDissolved,
  GroupMemberRemoved,
  GroupMemberLeft,
  GroupForkRuling,
} from '../protocol/group-message';
import {
  createInviteRequest,
  createAcceptResponse,
  createRejectResponse,
  createGroupWelcome,
  createMetadataUpdate,
  deserializeAcceptedKeyPackage,
} from '../handshake/group-invite';
import { playMessageSound } from '../utils/sound';
import { useI18n } from '../i18n/I18nContext';
import { t } from '../i18n/format';
import { isEmbedContext } from '../embed/protocol';
import type { EmbedTokenPayload } from '../embed/protocol';
import {
  start,
  notifySessionInvalid,
  sendUnread,
  onChatActiveChange,
  offChatActiveChange,
  onShare,
  onStartChat,
} from '../embed/bridge';
import type { EmbedSharePayload, EmbedStartChatPayload } from '../embed/protocol';
import { computeTotalUnread } from '../embed/unread';

// ---------------------------------------------------------------------------
// Serialization helpers (Uint8Array <-> base64 via JSON replacer)
// ---------------------------------------------------------------------------

function serializeWithUint8Array(obj: unknown): string {
  return JSON.stringify(obj, (_k, v) => {
    if (v instanceof Uint8Array) {
      return { __type: 'Uint8Array', data: bytesToBase64url(v) };
    }
    if (typeof v === 'bigint') {
      return { __type: 'BigInt', data: v.toString() };
    }
    return v;
  });
}

function deserializeWithUint8Array<T>(serialized: string): T {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return JSON.parse(serialized, (_k, v: any) => {
    if (v && typeof v === 'object' && v.__type === 'Uint8Array') {
      const b64 = v.data.replace(/-/g, '+').replace(/_/g, '/');
      const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
      const binary = atob(padded);
      const result = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) result[i] = binary.charCodeAt(i);
      return result;
    }
    if (v && typeof v === 'object' && v.__type === 'BigInt') {
      return BigInt(v.data);
    }
    return v;
  }) as T;
}

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

/** 从池条目反序列化 KP pair（与 generateInviteQr 既有逻辑一致）。 */
function deserializePoolPair(entry: KeyPackagePoolEntry): KeyPackagePair {
  return {
    publicPackage: deserializeWithUint8Array<KeyPackage>(entry.publicPackageSerialized),
    privatePackage: deserializeWithUint8Array<PrivateKeyPackage>(entry.privatePackageSerialized),
  };
}

/**
 * KP 池新鲜度（rotation-baseline-plan.md 3.3）：条目年龄 ≤ 当前设置的轮换
 * 周期。动态读设置值，不引入独立常量——叶子密钥总寿命上界 = KP 年龄 +
 * 基线推迟的一个周期 = 2× 用户选择的暴露窗口。
 */
function isFreshPoolEntry(entry: KeyPackagePoolEntry, intervalMs: number): boolean {
  const created = Date.parse(entry.createdAt);
  if (!Number.isFinite(created)) return false;
  return Date.now() - created <= intervalMs;
}

/**
 * 收敛「群已加入但本地 pending 邀请残留」的陈旧邀请，返回收敛后的全量列表。
 *
 * 多端场景下，群邀请请求信封经 1v1 会话槽位投递，会被每个克隆端各自
 * 接收并存为本地 pending 记录；而「接受」只发生在其中一端，邀请状态
 * 不经备份同步（FullBackupData 不含邀请）。克隆端从备份恢复拿到群会话
 * 后，本地残留的 pending 记录会让邀请卡片复活（实测），此时再点接受会
 * 向群主重复发送 accept。凡 groupId 已存在会话的 pending 邀请一律就地
 * 收敛为 accepted（含持久化），卡片不再渲染。
 */
async function reconcileStaleGroupInvites(store: DmeStorage): Promise<PendingInvite[]> {
  const all = await store.getPendingInvites();
  const reconciled: PendingInvite[] = [];
  for (const invite of all) {
    if (invite.status === 'pending' && (await store.getMlsSession(invite.groupId))) {
      await store.updatePendingInviteStatus(invite.inviteId, 'accepted');
      reconciled.push({ ...invite, status: 'accepted' });
    } else {
      reconciled.push(invite);
    }
  }
  return reconciled;
}

function uploadBlobWithProgress(
  pdsUrl: string,
  accessToken: string,
  proxyHeader: string | null,
  data: Uint8Array,
  onProgress?: (loaded: number, total: number) => void,
): Promise<DmeBlobRef> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const url = pdsUrl.replace(/\/$/, '') + '/xrpc/com.atproto.repo.uploadBlob';
    xhr.open('POST', url, true);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('Authorization', `Bearer ${accessToken}`);
    if (proxyHeader) {
      xhr.setRequestHeader('atproto-proxy', proxyHeader);
    }

    xhr.upload.onprogress = (e: ProgressEvent): void => {
      if (e.lengthComputable && onProgress) {
        onProgress(e.loaded, e.total);
      }
    };

    xhr.onload = (): void => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const resp = JSON.parse(xhr.responseText);
          const blob = resp.blob;
          resolve({
            $type: 'blob',
            ref: { $link: blob.ref.$link },
            mimeType: blob.mimeType,
            size: blob.size,
          });
        } catch (err) {
          reject(new Error('uploadBlobWithProgress: failed to parse response'));
        }
      } else {
        if (xhr.status === 400 || xhr.status === 401) notifySessionInvalid(accessToken);
        reject(new Error(`uploadBlobWithProgress: HTTP ${xhr.status}`));
      }
    };

    xhr.onerror = (): void => {
      reject(new Error('uploadBlobWithProgress: network error'));
    };

    xhr.ontimeout = (): void => {
      reject(new Error('uploadBlobWithProgress: timeout'));
    };

    xhr.timeout = 60_000;
    xhr.send(data);
  });
}

async function uploadFileChunks(
  fileSize: number,
  fileKey: Uint8Array,
  fileId: Uint8Array,
  pdsUrl: string,
  accessToken: string,
  proxyHeader: string | null,
  readChunk: (offset: number, readSize: number) => Promise<Uint8Array>,
  onProgress?: (progress: number) => void,
): Promise<{ blobRefs: DmeBlobRef[]; sha256: string; chunkCount: number }> {
  const chunkSize = 5 * 1024 * 1024;
  const hasher = sha256.create();
  const blobRefs: DmeBlobRef[] = [];
  let offset = 0;
  let chunkIndex = 0;
  let uploadedBytes = 0;
  const totalEncryptedBytes = fileSize + Math.ceil(fileSize / chunkSize) * 16;

  while (offset < fileSize) {
    const readSize = Math.min(chunkSize, fileSize - offset);
    const block = await readChunk(offset, readSize);
    hasher.update(block);
    const encrypted = await encryptChunk(block, fileKey, fileId, chunkIndex);
    const chunkSizeEncrypted = encrypted.byteLength;

    const blobRef = await uploadBlobWithProgress(
      pdsUrl,
      accessToken,
      proxyHeader,
      encrypted,
      (loaded) => {
        const current = uploadedBytes + loaded;
        const progress = Math.min(99, Math.round((current / totalEncryptedBytes) * 100));
        onProgress?.(progress);
      },
    );

    blobRefs.push(blobRef);
    uploadedBytes += chunkSizeEncrypted;
    const progress = Math.min(99, Math.round((uploadedBytes / totalEncryptedBytes) * 100));
    onProgress?.(progress);
    offset += readSize;
    chunkIndex++;
  }

  return { blobRefs, sha256: bytesToHex(hasher.digest()), chunkCount: chunkIndex };
}

// ---------------------------------------------------------------------------
// Context types
// ---------------------------------------------------------------------------

interface AppState {
  session: DmeSession | null;
  storage: DmeStorage | null;
  identityKeys: IdentityKeys | null;
  poller: DmePoller | null;
  pds: DmePds | null;
  loading: boolean;
  error: string | null;
  groups: string[];
  pendingWelcomes: PendingWelcome[];
  keyPackagePool: KeyPackagePoolEntry[];
  chatListVersion: number;
  pollBatchSize: number;
  keyRotationIntervalMs: number;
  backupRequired: boolean;
  appViewProxy: string;
  serverUrl: string;
  gatewayUrl: string;
  pendingInvites: PendingInvite[];
  groupInfos: GroupInfo[];
  receivedGroupInvites: PendingInvite[];
  pendingRescueInvites: PendingRescueInvite[];
  blockList: string[];
  soundEnabled: boolean;
  embedMismatch: { localDid: string | null; tokenDid: string } | null;
  embedTokenApplied: boolean;
  loginStep: 'idle' | 'loggingIn' | 'awaiting2FA';
  loginFormSnapshot: { identifier: string; password: string; pdsUrl: string } | null;
}

export interface LoginParams {
  identifier: string;
  password: string;
  pdsUrl?: string;
  authFactorToken?: string;
}

interface AppActions {
  login: (params: LoginParams) => Promise<void>;
  cancel2FA: () => void;
  logout: () => Promise<void>;
  restoreSession: () => Promise<boolean>;
  setupIdentity: () => Promise<void>;
  declareKeys: (plcToken: string) => Promise<void>;
  backupIdentity: (password: string) => Promise<void>;
  /**
   * 覆盖提示（方案C，只提示不阻断）：读取云端备份外层元数据，判断
   * 「云端有本机没有的会话」差异。返回 null = 云端无备份/元数据缺失/
   * 读取失败（提示是尽力而为，绝不因此阻断备份）；conflict=true 时
   * UI 弹确认，用户确认后仍正常备份。
   */
  peekBackupConflict: () => Promise<{ conflict: boolean; deviceLabel: string; writtenAt: string } | null>;
  backupIdentityGuarded: (password: string) => Promise<void>;
  backupIdentityForced: (password: string) => Promise<void>;
  restoreIdentityFromBackup: (password: string, forceRestore?: boolean) => Promise<boolean>;
  hasIdentityBackup: () => Promise<boolean>;
  sendMessage: (groupId: string, text: string) => Promise<void>;
  sendPostMessage: (groupId: string, post: { uri: string; url: string; html?: string }) => Promise<void>;
  shareIntent: EmbedSharePayload | null;
  consumeShareIntent: () => void;
  startChatIntent: EmbedStartChatPayload | null;
  consumeStartChatIntent: () => void;
  sendFileMessage: (conversationId: string, fileUri: string, fileName: string, mimeType: string, fileSize: number) => Promise<void>;
  retryUploadFileMessage: (conversationId: string, msgId: string) => Promise<void>;
  downloadFile: (conversationId: string, msgId: string) => Promise<void>;
  sendReaction: (conversationId: string, messageId: string, emoji: string) => Promise<void>;
  deleteMessage: (conversationId: string, messageId: string) => Promise<void>;
  deleteFriend: (groupId: string) => Promise<void>;
  markConversationAsRead: (groupId: string) => Promise<void>;
  generateInviteQr: (bobDid: string) => Promise<{ qrString: string; keyPackageInitKey: Uint8Array; keyPackageSerialized: string; welcomeQueueId: string }>;
  trackInvitePendingWelcome: (bobDid: string, keyPackageSerialized: string, welcomeQueueId: string) => Promise<void>;
  deletePendingWelcome: (queueId: string) => Promise<void>;
  acceptInviteQr: (qrString: string) => Promise<void>;
  refreshKeyPackagePool: () => Promise<void>;
  setPollBatchSize: (size: number) => Promise<void>;
  setKeyRotationIntervalMs: (ms: number) => Promise<void>;
  setAppViewProxy: (proxy: string) => Promise<void>;
  setServerUrl: (url: string) => Promise<void>;
  setGatewayUrl: (url: string) => Promise<void>;
  acceptRescueInvite: (groupId: string) => Promise<void>;
  declineRescueInvite: (groupId: string) => Promise<void>;
  sendRescueHandshake: (groupId: string) => Promise<void>;
  sendGroupInvites: (groupName: string, friendDids: readonly string[]) => Promise<string>;
  respondToGroupInvite: (inviteId: string, accepted: boolean) => Promise<void>;
  createGroupFromPendingInvites: (groupId: string) => Promise<void>;
  cancelGroupInvite: (inviteId: string) => Promise<void>;
  addMemberToGroup: (groupId: string, friendDid: string) => Promise<void>;
  addAcceptedMembersToGroup: (groupId: string) => Promise<void>;
  dissolveGroup: (groupId: string) => Promise<void>;
  removeMemberFromGroup: (groupId: string, memberDid: string) => Promise<void>;
  leaveGroup: (groupId: string) => Promise<void>;
  /**
   * 群主拍板（P2，group-fork-plan.md 3.2/3.3）：仅群主可调用。确认「以本机
   * 为准」后经群 MLS 会话广播 group_fork_ruling（仅权威世界可解密），本机
   * 清除 forked 标记并触发备份联动。返回是否成功拍板。
   */
  issueForkRuling: (groupId: string) => Promise<boolean>;
  refreshBlockList: () => Promise<void>;
  blockMember: (did: string) => Promise<void>;
  unblockMember: (did: string) => Promise<void>;
  setActiveConversation: (conversationId: string | null) => void;
  setSoundEnabled: (enabled: boolean) => Promise<void>;
  applyEmbedToken: (payload: EmbedTokenPayload) => Promise<void>;
}

interface AppContextValue extends AppState, AppActions {}

const AppContext = createContext<AppContextValue | null>(null);

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function AppProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const { language } = useI18n();

  const [session, setSession] = useState<DmeSession | null>(null);
  const [storage, setStorage] = useState<DmeStorage | null>(null);
  const [identityKeys, setIdentityKeys] = useState<IdentityKeys | null>(null);
  const [poller, setPoller] = useState<DmePoller | null>(null);
  const [pds, setPds] = useState<DmePds | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [groups, setGroups] = useState<string[]>([]);
  const [pendingWelcomes, setPendingWelcomes] = useState<PendingWelcome[]>([]);
  const [keyPackagePool, setKeyPackagePool] = useState<KeyPackagePoolEntry[]>([]);
  const [chatListVersion, setChatListVersion] = useState(0);
  const [pollBatchSize, setPollBatchSizeState] = useState(3);
  const [keyRotationIntervalMs, setKeyRotationIntervalMsState] = useState(7 * 24 * 60 * 60 * 1000);
  const [backupRequired, setBackupRequiredState] = useState(false);
  const [appViewProxy, setAppViewProxyState] = useState<string>(DEFAULT_APPVIEW_PROXY);
  const [serverUrl, setServerUrlState] = useState<string>(DME_SERVER_URL);
  const [gatewayUrl, setGatewayUrlState] = useState<string>(DEFAULT_DME_GATEWAY_URL);
  const [pendingInvites, setPendingInvites] = useState<PendingInvite[]>([]);
  const [groupInfos, setGroupInfos] = useState<GroupInfo[]>([]);
  const [receivedGroupInvites, setReceivedGroupInvites] = useState<PendingInvite[]>([]);
  const [pendingRescueInvites, setPendingRescueInvites] = useState<PendingRescueInvite[]>([]);
  const [blockList, setBlockList] = useState<string[]>([]);
  const [soundEnabled, setSoundEnabledState] = useState(true);
  const [embedMismatch, setEmbedMismatch] = useState<{ localDid: string | null; tokenDid: string } | null>(null);
  const [embedTokenApplied, setEmbedTokenApplied] = useState(false);
  const [loginStep, setLoginStep] = useState<'idle' | 'loggingIn' | 'awaiting2FA'>('idle');
  const [loginFormSnapshot, setLoginFormSnapshot] = useState<{ identifier: string; password: string; pdsUrl: string } | null>(null);
  const [shareIntent, setShareIntent] = useState<EmbedSharePayload | null>(null);
  const [startChatIntent, setStartChatIntent] = useState<EmbedStartChatPayload | null>(null);

  const processWelcomeRef = useRef<(welcome: IncomingWelcome) => Promise<void>>(async () => {});
  // 通道刷新 ref：processReceivedWelcome（定义在前）需要在救援握手成功后
  // 立即切换救援通道纪元，不等 60s 定时刷新（见 refreshRescueQueueIds）。
  const handleIncomingMessageRef = useRef<(msg: IncomingMessage, userDid: string, storage: DmeStorage) => Promise<void>>(async () => {});
  const handleRescueMessageRef = useRef<(groupId: string, payloadBase64url: string, queueId: string) => Promise<boolean>>(async () => false);

  const activeConversationRef = useRef<string | null>(null);
  const chatActiveRef = useRef<boolean>(false);
  const sessionRef = useRef(session);
  sessionRef.current = session;

  const setActiveConversation = useCallback((conversationId: string | null): void => {
    activeConversationRef.current = conversationId;
  }, []);

  const setSoundEnabled = useCallback(async (enabled: boolean): Promise<void> => {
    if (!storage) return;
    await storage.setSoundEnabled(enabled);
    setSoundEnabledState(enabled);
  }, [storage]);

  // -------------------------------------------------------------------------
  // Hydration (extracted from restoreSession / used by embed token branch A)
  // -------------------------------------------------------------------------

  const hydrateRestoredApp = useCallback(async (
    newSession: DmeSession,
    newStorage: DmeStorage,
    did: string,
  ): Promise<void> => {
    const appViewProxyValue = await newStorage.getAppViewProxy();
    const serverUrlValue = await newStorage.getDmeServerUrl();
    const gatewayUrlValue = await newStorage.getDmeGatewayUrl();
    const newPds = new DmePds(newSession.agent, serverUrlValue, gatewayUrlValue, appViewProxyValue);
    const storedKeys = await newStorage.getIdentityKeys();
    const idKeys = storedKeys ?? generateIdentityKeys();
    if (!storedKeys) {
      await newStorage.putIdentityKeys(idKeys);
    }

    const batchSize = await newStorage.getPollBatchSize();
    const rotationIntervalValue = await newStorage.getKeyRotationIntervalMs();
    const backupRequiredValue = await newStorage.isBackupRequired();
    const newPoller = new DmePoller(newPds, newStorage, batchSize);

    newPoller.start(
      async (msg: IncomingMessage) => {
        await handleIncomingMessageRef.current(msg, did, newStorage);
      },
      async (welcome: IncomingWelcome) => {
        await processWelcomeRef.current(welcome);
      },
      async (groupId: string, payloadBase64url: string, queueId: string) => {
        return await handleRescueMessageRef.current(groupId, payloadBase64url, queueId);
      },
    );

    // Restore MLS sessions
    const groupIds = await newStorage.listGroups();
    const impl = await getNobleMlsImpl();
    // 僵尸群清理：listGroups 是 messages ∪ mlsSession 键的并集——历史上
    // group_welcome 重放在本机无会话时也会插入 group.joined 消息（已修），
    // 产生「有消息、无会话」的僵尸群条目（预览谎报已加入，进群打不开
    // 任何消息）。会话列表只显示真正持有 MLS 会话（= 在群中）的条目。
    const sessionGroupIds: string[] = [];
    for (const gid of groupIds) {
      const serialized = await newStorage.getMlsSession(gid);
      if (serialized) {
        sessionGroupIds.push(gid);
        try {
          const mlsSession = await MlsSession.deserialize(serialized, impl);
          newPoller.addSession(gid, mlsSession);
        } catch (err) {
          console.error('AppContext: failed to restore MLS session for', gid, err);
        }
      }
    }

    const welcomes = await newStorage.getPendingWelcomes();
    for (const w of welcomes) {
      newPoller.addPendingWelcome(w);
    }

    const pool = await newStorage.getKeyPackagePool();

    const allInvites = await reconcileStaleGroupInvites(newStorage);
    const sentInvites = allInvites.filter((i) => i.inviterDid === did);
    const recvInvites = allInvites.filter((i) => i.inviteeDid === did);
    const storedGroupInfos = await newStorage.listGroupInfos();

    setSession(newSession);
    setStorage(newStorage);
    setIdentityKeys(idKeys);
    setPds(newPds);
    setPoller(newPoller);
    setGroups(sessionGroupIds);
    setPendingWelcomes(welcomes);
    setKeyPackagePool(pool);
    setPollBatchSizeState(batchSize);
    setKeyRotationIntervalMsState(rotationIntervalValue);
    setBackupRequiredState(backupRequiredValue);
    setAppViewProxyState(appViewProxyValue);
    setServerUrlState(serverUrlValue);
    setGatewayUrlState(gatewayUrlValue);
    setPendingInvites(sentInvites);
    setReceivedGroupInvites(recvInvites);
    setGroupInfos(storedGroupInfos.filter((g) => sessionGroupIds.includes(g.groupId)));

    // Load pending rescue invites (only today's are shown).
    const today = new Date().toISOString().slice(0, 10);
    const rescueInvites: PendingRescueInvite[] = [];
    for (const groupId of sessionGroupIds) {
      const invite = await newStorage.getRescueInvite(groupId);
      if (invite && invite.date === today) {
        rescueInvites.push(invite);
      }
    }
    setPendingRescueInvites(rescueInvites);

    setBlockList(await newStorage.getBlockList());
    setSoundEnabledState(await newStorage.getSoundEnabled());

    try {
      const transferGroupIds = await newStorage.listGroups();
      for (const groupId of transferGroupIds) {
        const msgs = await newStorage.getMessages(groupId);
        for (const msg of msgs) {
          if (msg.kind !== 'file' || !msg.fileMeta) continue;
          if (msg.fileMeta.downloadStatus === 'downloading') {
            await newStorage.updateFileMessageMeta(groupId, msg.id, { downloadStatus: 'pending', downloadProgress: undefined });
          }
          if (msg.fileMeta.uploadStatus === 'uploading') {
            await newStorage.updateFileMessageMeta(groupId, msg.id, { uploadStatus: 'failed' });
          }
        }
      }
    } catch (err) {
      console.error('AppContext: failed to reset interrupted file transfers', err);
    }
  }, []);

  // -------------------------------------------------------------------------
  // KeyPackage pool
  // -------------------------------------------------------------------------

  const refreshKeyPackagePool = useCallback(async (): Promise<void> => {
    if (!storage || !identityKeys || !session) return;

    // KP 池新鲜度退役（rotation-baseline-plan.md 3.3）：超龄（年龄 > 当前
    // 设置的轮换周期）未消费且未被 pending invite 预留的条目移除。
    // 被引用的条目绝不退役——welcome 解密依赖其私钥，删了复现
    // 「welcome 未到达」死局（2026-10-14 实测踩坑）。
    const interval = await storage.getKeyRotationIntervalMs();
    const reservedIds = new Set(
      (await storage.getPendingInvites())
        .map((i) => i.ownKeyPackagePoolId)
        .filter((id): id is string => Boolean(id)),
    );
    const stale = (await storage.getKeyPackagePool()).filter(
      (e) =>
        !e.consumed &&
        !reservedIds.has(e.id) &&
        !isFreshPoolEntry(e, interval),
    );
    for (const entry of stale) {
      await storage.removeKeyPackageFromPool(entry.id);
    }

    const pool = await storage.getKeyPackagePool();
    const available = pool.filter((e) => !e.consumed);
    const needed = KEYPACKAGE_POOL_SIZE - available.length;

    for (let i = 0; i < Math.max(0, needed); i++) {
      const pair = await generateKeyPackageForUser(
        session.did,
        identityKeys.signing.privateKey,
        identityKeys.signing.publicKey,
      );
      const entry: KeyPackagePoolEntry = {
        id: generateId(),
        publicPackageSerialized: serializeWithUint8Array(pair.publicPackage),
        privatePackageSerialized: serializeWithUint8Array(pair.privatePackage),
        createdAt: new Date().toISOString(),
        consumed: false,
      };
      await storage.addKeyPackageToPool(entry);
    }

    if (needed > 0 || stale.length > 0) {
      setKeyPackagePool(await storage.getKeyPackagePool());
    }
  }, [storage, identityKeys, session]);

  /**
   * 取一个新鲜（年龄 ≤ 当前设置的轮换周期）的未消费池条目并反序列化成
   * pair；无则 refresh（退役 + 补货，纯本地）后重取（rotation-baseline-plan.md
   * 3.3）。consume=true 时立即标 consumed（pair 私钥随即进入本机会话，
   * 无外部解密依赖）；consume=false 用于「预留待 join」路径（如群邀请接受，
   * join 成功才标 consumed，保证 welcome 未到达时 pair 随备份可恢复）。
   */
  const takeFreshPoolPair = useCallback(async (
    label: string,
    consume: boolean,
  ): Promise<{ entry: KeyPackagePoolEntry; pair: KeyPackagePair }> => {
    if (!storage) throw new Error(`${label}: storage not initialized`);

    const findFresh = async (): Promise<KeyPackagePoolEntry | undefined> => {
      const interval = await storage.getKeyRotationIntervalMs();
      return (await storage.getKeyPackagePool()).find(
        (e) => !e.consumed && isFreshPoolEntry(e, interval),
      );
    };

    let entry = await findFresh();
    if (!entry) {
      await refreshKeyPackagePool();
      entry = await findFresh();
    }
    if (!entry) throw new Error(`${label}: no fresh KeyPackage available in pool`);

    if (consume) {
      await storage.markKeyPackageConsumed(entry.id);
      setKeyPackagePool(await storage.getKeyPackagePool());
    }
    return { entry, pair: deserializePoolPair(entry) };
  }, [storage, refreshKeyPackagePool]);

  const setPollBatchSize = useCallback(async (size: number): Promise<void> => {
    if (!storage || !poller) return;
    await storage.setPollBatchSize(size);
    poller.setBatchSize(size);
    setPollBatchSizeState(size);
  }, [storage, poller]);

  const setKeyRotationIntervalMs = useCallback(async (ms: number): Promise<void> => {
    if (!storage) return;
    await storage.setKeyRotationIntervalMs(ms);
    setKeyRotationIntervalMsState(ms);
    // 周期变更后立即重查一次（缩短周期可提前触发）
    runRotationCheckRef.current?.();
  }, [storage]);

  const setAppViewProxy = useCallback(async (proxy: string): Promise<void> => {
    if (!storage || !pds) return;
    await storage.setAppViewProxy(proxy);
    pds.setAppViewProxy(proxy);
    setAppViewProxyState(proxy);
  }, [storage, pds]);

  const setServerUrl = useCallback(async (url: string): Promise<void> => {
    if (!storage || !pds) return;
    await storage.setDmeServerUrl(url);
    pds.setServerUrl(url);
    setServerUrlState(url);
  }, [storage, pds]);

  const setGatewayUrl = useCallback(async (url: string): Promise<void> => {
    if (!storage || !pds) return;
    await storage.setDmeGatewayUrl(url);
    pds.setGatewayUrl(url);
    setGatewayUrlState(url);
  }, [storage, pds]);

  // -------------------------------------------------------------------------
  // Login / Logout / Restore
  // -------------------------------------------------------------------------

  const login = useCallback(async (params: LoginParams): Promise<void> => {
    const { identifier, password, pdsUrl, authFactorToken } = params;
    setLoading(true);
    setError(null);

    try {
      const resolvedPds = pdsUrl?.trim() || PDS_URL;
      const userDidPlaceholder = 'did:plc:unknown';
      const newSession = new DmeSession();
      const tempStorage = new DmeStorage(userDidPlaceholder);
      newSession.setStorage(tempStorage);
      await newSession.login(identifier, password, tempStorage, resolvedPds, authFactorToken);

      const userDid = newSession.did;
      const correctStorage = new DmeStorage(userDid);
      newSession.setStorage(correctStorage);

      // Migrate placeholder data
      const allKeys = await globalStorage.getAllKeys();
      const placeholderPrefix = `dme:${userDidPlaceholder}:`;
      const placeholderKeys = allKeys.filter((k) => k.startsWith(placeholderPrefix));
      for (const key of placeholderKeys) {
        const value = await globalStorage.getItem(key);
        if (value !== null) {
          const newKey = `dme:${userDid}:${key.slice(placeholderPrefix.length)}`;
          await globalStorage.setItem(newKey, value);
        }
      }
      if (placeholderKeys.length > 0) {
        await Promise.all(placeholderKeys.map((key) => globalStorage.removeItem(key)));
      }

      const appViewProxyValue = await correctStorage.getAppViewProxy();
      const serverUrlValue = await correctStorage.getDmeServerUrl();
      const gatewayUrlValue = await correctStorage.getDmeGatewayUrl();
      const newPds = new DmePds(newSession.agent, serverUrlValue, gatewayUrlValue, appViewProxyValue);

      // Load or generate identity keys
      const storedKeys = await correctStorage.getIdentityKeys();
      const keys = storedKeys ?? generateIdentityKeys();
      if (!storedKeys) {
        await correctStorage.putIdentityKeys(keys);
      }

      const batchSize = await correctStorage.getPollBatchSize();
      const rotationIntervalValue = await correctStorage.getKeyRotationIntervalMs();
      const backupRequiredValue = await correctStorage.isBackupRequired();
      const newPoller = new DmePoller(newPds, correctStorage, batchSize);

      newPoller.start(
        async (msg: IncomingMessage) => {
          await handleIncomingMessageRef.current(msg, userDid, correctStorage);
        },
        async (welcome: IncomingWelcome) => {
          await processWelcomeRef.current(welcome);
        },
        async (groupId: string, payloadBase64url: string, queueId: string) => {
          return await handleRescueMessageRef.current(groupId, payloadBase64url, queueId);
        },
      );

      // Restore MLS sessions
      const groupIds = await correctStorage.listGroups();
      const impl = await getNobleMlsImpl();
      // 僵尸群清理（同启动加载）：只显示真正持有 MLS 会话的条目
      const sessionGroupIds: string[] = [];
      for (const gid of groupIds) {
        const serialized = await correctStorage.getMlsSession(gid);
        if (serialized) {
          sessionGroupIds.push(gid);
          try {
            const mlsSession = await MlsSession.deserialize(serialized, impl);
            newPoller.addSession(gid, mlsSession);
          } catch (err) {
            console.error('AppContext: failed to restore MLS session for', gid, err);
          }
        }
      }

      // Restore pending welcomes
      const welcomes = await correctStorage.getPendingWelcomes();
      for (const w of welcomes) {
        newPoller.addPendingWelcome(w);
      }

      // Restore KeyPackage pool
      const pool = await correctStorage.getKeyPackagePool();

      // Restore group invites and group infos
      const allInvites = await reconcileStaleGroupInvites(correctStorage);
      const sentInvites = allInvites.filter((i) => i.inviterDid === userDid);
      const recvInvites = allInvites.filter((i) => i.inviteeDid === userDid);
      const storedGroupInfos = await correctStorage.listGroupInfos();

      setSession(newSession);
      setStorage(correctStorage);
      setIdentityKeys(keys);
      setPds(newPds);
      setPoller(newPoller);
      setGroups(sessionGroupIds);
      setPendingWelcomes(welcomes);
      setKeyPackagePool(pool);
      setPollBatchSizeState(batchSize);
      setKeyRotationIntervalMsState(rotationIntervalValue);
      setBackupRequiredState(backupRequiredValue);
      setAppViewProxyState(appViewProxyValue);
      setServerUrlState(serverUrlValue);
      setGatewayUrlState(gatewayUrlValue);
      setPendingInvites(sentInvites);
      setReceivedGroupInvites(recvInvites);
      setGroupInfos(storedGroupInfos.filter((g) => sessionGroupIds.includes(g.groupId)));

      // Load pending rescue invites (only today's are shown).
      const today = new Date().toISOString().slice(0, 10);
      const rescueInvites: PendingRescueInvite[] = [];
      for (const groupId of sessionGroupIds) {
        const invite = await correctStorage.getRescueInvite(groupId);
        if (invite && invite.date === today) {
          rescueInvites.push(invite);
        }
      }
      setPendingRescueInvites(rescueInvites);

      setBlockList(await correctStorage.getBlockList());
      setSoundEnabledState(await correctStorage.getSoundEnabled());
      setLoginStep('idle');
      setLoginFormSnapshot(null);
    } catch (err) {
      const newSession = new DmeSession();
      if (newSession.isAuthFactorTokenRequired(err) && !authFactorToken) {
        setLoginStep('awaiting2FA');
        setLoginFormSnapshot({ identifier, password, pdsUrl: pdsUrl?.trim() || PDS_URL });
        setError(t(language, 'login.2faHint'));
      } else {
        setLoginStep('idle');
        setLoginFormSnapshot(null);
        setError(err instanceof Error ? err.message : t(language, 'login.failed'));
      }
      throw err;
    } finally {
      setLoading(false);
    }
  }, [language]);

  const cancel2FA = useCallback((): void => {
    setLoginStep('idle');
    setLoginFormSnapshot(null);
    setError(null);
  }, []);

  const logout = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      poller?.stop();
      if (session) {
        await session.logout(storage ?? undefined);
      }
      if (storage) {
        await storage.clear();
      }
      // 1.2：登出清除密码缓存（Keychain 条目 + 内存），换账号不残留
      await clearBackupPassword();
    } catch (err) {
      console.error('Logout error:', err);
    } finally {
      setSession(null);
      setStorage(null);
      setIdentityKeys(null);
      setPds(null);
      setPoller(null);
      setError(null);
      setGroups([]);
      setPendingWelcomes([]);
      setKeyPackagePool([]);
      setPendingInvites([]);
      setReceivedGroupInvites([]);
      setPendingRescueInvites([]);
      setGroupInfos([]);
      setPollBatchSizeState(3);
      setKeyRotationIntervalMsState(7 * 24 * 60 * 60 * 1000);
      setBackupRequiredState(false);
      setAppViewProxyState(DEFAULT_APPVIEW_PROXY);
      setServerUrlState(DME_SERVER_URL);
      setGatewayUrlState(DEFAULT_DME_GATEWAY_URL);
      setLoginStep('idle');
      setLoginFormSnapshot(null);
      setLoading(false);
    }
  }, [session, storage, poller]);

  const restoreSession = useCallback(async (): Promise<boolean> => {
    // embed 模式会话由 fatesky 注入（applyEmbedToken），不走本地 restore。
    if (isEmbedContext()) return false;
    setLoading(true);
    setError(null);

    // Request persistent storage on iOS Safari to prevent IndexedDB eviction
    if (Platform.OS === 'web' && 'storage' in navigator && 'persist' in navigator.storage) {
      try {
        await navigator.storage.persist();
      } catch {
        // Ignore - not supported or user denied
      }
    }

    try {
      const keys = await globalStorage.getAllKeys();
      const sessionKeys = keys.filter(
        (k) => k.startsWith('dme:') && k.endsWith(':session'),
      );
      if (sessionKeys.length === 0) return false;

      const nonPlaceholderKeys = sessionKeys.filter((k) => !k.includes('did:plc:unknown'));
      const keysToProcess = nonPlaceholderKeys.length > 0 ? nonPlaceholderKeys : sessionKeys;

      for (const key of keysToProcess) {
        const did = key.slice(4, -8);
        const tempStorage = new DmeStorage(did);
        const tempSession = new DmeSession();
        const restored = await tempSession.restore(tempStorage);
        if (!restored) continue;

        tempSession.setStorage(tempStorage);

        await hydrateRestoredApp(tempSession, tempStorage, did);

        return true;
      }

      return false;
    } catch (err) {
      setError(err instanceof Error ? err.message : t(language, 'login.restoreFailed'));
      return false;
    } finally {
      setLoading(false);
    }
  }, [language]);

  // -------------------------------------------------------------------------
  // Identity
  // -------------------------------------------------------------------------

  const setupIdentity = useCallback(async (): Promise<void> => {
    if (identityKeys) return;
    if (!storage) throw new Error('setupIdentity: storage not initialized');

    const stored = await storage.getIdentityKeys();
    if (stored) {
      setIdentityKeys(stored);
      return;
    }

    const keys = generateIdentityKeys();
    await storage.putIdentityKeys(keys);
    setIdentityKeys(keys);
  }, [identityKeys, storage]);

  const declareKeysAction = useCallback(async (plcToken: string): Promise<void> => {
    if (!identityKeys) throw new Error('declareKeys: identity keys not available');
    if (!session) throw new Error('declareKeys: session not initialized');

    await declareKeys(session.did, identityKeys, session.agent, plcToken);
  }, [identityKeys, session]);

  // -------------------------------------------------------------------------
  // Identity backup
  // -------------------------------------------------------------------------

  const backupIdentity = useCallback(async (password: string): Promise<void> => {
    if (!identityKeys) throw new Error('backupIdentity: identity keys not available');
    if (!pds) throw new Error('backupIdentity: pds not initialized');
    if (!storage) throw new Error('backupIdentity: storage not initialized');

    // 缺口③配套：本机存在 sibling-rotated / forked 会话时，本机状态落后于
    // 兄弟端/权威谱系，此时备份会用旧状态覆盖云端备份（云端可能已由兄弟端
    // 刷新为包含其推进的新状态）。正确顺序是先「从备份恢复」，恢复完成
    // （标记清除）后再备份。
    for (const gid of await storage.listGroups()) {
      const issue = await storage.getSessionIssue(gid);
      if (issue === 'sibling-rotated' || issue === 'forked') {
        throw new Error('BACKUP_BLOCKED_STALE');
      }
    }

    const groupIds = await storage.listGroups();
    const mlsSessions: Record<string, string> = {};
    const rotationAt: Record<string, number> = {};
    for (const gid of groupIds) {
      const serialized = await storage.getMlsSession(gid);
      if (serialized) {
        mlsSessions[gid] = serialized;
      }
      rotationAt[gid] = await storage.getLastRotationAt(gid);
    }
    const keyPackagePool = await storage.getKeyPackagePool();
    const groupInfos = await storage.listGroupInfos();
    const blockList = await storage.getBlockList();

    const data: FullBackupData = {
      identity: identityKeys,
      mlsSessions,
      keyPackagePool,
      groupInfos,
      blockList,
      rotationAt,
      commitSeq: await storage.getCommitSeq(),
      // 谱系账本随备份走（group-fork-plan.md 3.1）：恢复端 lastSeq 归零会让
      // 其下次 commit 从 1 重新编号，对端账本 seq 1 已有他值 → 全员假分叉
      groupCommitLedger: await storage.exportGroupCommitLedger(),
    };

    const encryptedData = encryptBackup(data, password);
    // 方案C外层元数据：设备短码 + 平台 + 会话指纹。只供覆盖提示与展示，
    // 恢复流程不读它；写失败不应阻断备份本体（元数据尽力而为）。
    // v3 修正（2026-10-27）：meta 追加 commitSeq——这是「云端备份是否覆盖
    // 某次高水位推进」的判据（rotation-claim 的 stale vs adopt 分流）。
    // 缺了它，恢复路径无法判断「恢复备份能不能修好」，只会一律要用户恢复。
    let meta: BackupMeta | undefined;
    try {
      meta = {
        deviceId: await getOrCreateDeviceId(),
        platform: getPlatformLabel(),
        sessionFps: computeSessionFingerprints(groupIds, identityKeys.signing.privateKey),
        commitSeq: data.commitSeq,
      };
    } catch (err) {
      console.warn('[dme:backup] build meta failed, writing without meta:', err);
    }
    await pds.putIdentityBackup(encryptedData, meta);

    // 1.2：备份成功即记住密码（native Keychain / web 会话内存），供轮换后
    // 静默刷新备份（1.5）；并清除「必须备份」强提示标记
    await saveBackupPassword(password);
    await storage.setBackupRequired(false);
    setBackupRequiredState(false);
  }, [identityKeys, pds, storage]);

  // 缺口①：所有推进会话状态的动作（轮换 / 握手接会话）之后统一走这里的
  // 备份联动——云端备份必须始终包含最新推进，否则兄弟端按 sibling-rotated
  // 提示恢复时会倒灌旧状态（把新握手 / 新轮换抹掉，实测踩过：重新握手后
  // 兄弟端恢复旧备份把新会话覆盖掉，Bob 立刻联系不上 Alice）。
  //
  // 方案C：写入前比对外层元数据指纹——云端有本机没有的会话时跳过自动
  // 写入（无人值守场景不能覆盖掉兄弟端刚写的新备份），置 backupRequired
  // 引导手动备份；手动备份入口有确认弹窗把关。无差异 / 云端是自己写的 /
  // 元数据缺失（旧记录或读取失败）→ 正常写入，绝不阻断。
  const triggerBackupAfterAdvance = useCallback(async (tag: string): Promise<void> => {
    if (!storage || !pds || !identityKeys) return;
    try {
      const cachedPassword = await getBackupPassword();
      if (cachedPassword) {
        try {
          const record = await pds.getIdentityBackupRecord();
          const meta = record?.meta;
          if (
            meta &&
            meta.deviceId !== (await getOrCreateDeviceId()) &&
            cloudHasUnknownSessions(meta, await storage.listGroups(), identityKeys.signing.privateKey)
          ) {
            console.warn(
              `[dme:backup] cloud backup (written by ${formatDeviceLabel(meta)}) has sessions unknown locally; auto refresh skipped after ${tag}`,
            );
            await storage.setBackupRequired(true);
            setBackupRequiredState(true);
            return;
          }
        } catch (peekErr) {
          // 比对失败不阻断自动备份（尽力而为）
          console.warn('[dme:backup] conflict peek failed, proceeding:', peekErr);
        }
        await backupIdentity(cachedPassword);
        console.log(`[dme:backup] backup refreshed after ${tag}`);
      } else {
        await storage.setBackupRequired(true);
        setBackupRequiredState(true);
      }
    } catch (err) {
      // 刷新失败仅 log（不影响推进结果）。若是因存在待恢复会话被拒
      // （BACKUP_BLOCKED_STALE），sibling-rotated 横幅本就在引导恢复，
      // 不叠加 backupRequired 提示。
      console.warn(`[dme:backup] backup refresh after ${tag} failed:`, err);
    }
  }, [storage, pds, identityKeys, backupIdentity]);

  /** 覆盖提示（方案C）：见 AppActions.peekBackupConflict 注释。 */
  const peekBackupConflict = useCallback(async (): Promise<{ conflict: boolean; deviceLabel: string; writtenAt: string } | null> => {
    if (!pds || !identityKeys || !storage) return null;
    try {
      const record = await pds.getIdentityBackupRecord();
      const meta = record?.meta;
      if (!meta) return null; // 旧记录 / 无元数据：无从判断，降级放行
      const conflict =
        meta.deviceId !== (await getOrCreateDeviceId()) &&
        cloudHasUnknownSessions(meta, await storage.listGroups(), identityKeys.signing.privateKey);
      return {
        conflict,
        deviceLabel: formatDeviceLabel(meta),
        writtenAt: record?.createdAt ?? '',
      };
    } catch {
      return null; // 读取失败：提示尽力而为，绝不阻断
    }
  }, [pds, identityKeys, storage]);

  /**
   * 宣言存储（rotation-claim.ts v2，CAS 仲裁）：槽位由身份签名公钥稳定
   * 派生，账号级恒定，全端共享这一份读写入口。put/del 走 atproto 原生
   * CAS（swapRecord / createRecord-if-absent），并发双写服务端只让先到者
   * 成功，落败方 fail-closed。
   */
  const claimStore = useMemo<RotationClaimStore | null>(() => {
    if (!pds) return null;
    return {
      get: (rkey) => pds.getRotationClaim(rkey),
      put: (rkey, payload, expectedCid) => pds.putRotationClaim(rkey, payload, expectedCid),
      del: (rkey, expectedCid) => pds.deleteRotationClaim(rkey, expectedCid),
    };
  }, [pds]);

  /**
   * 宣言门禁（约定7/8/9）：本账号任何 commit 型备份点动作（轮换/建群/
   * 踢人/拉人/退群清理）的前置检查。账号级单调 commit 高水位仲裁：
   * 返回应写入的高水位 seq，调用方在 commit 投递成功后 setCommitSeq；
   * 返回 null = 拒绝执行——taken/stale（其他端已推进/备份分叉）已置
   * sibling-rotated 提示恢复最新备份；PDS 不可用 fail-closed（不置标记、
   * 不动作，下个时机重试，绝不无仲裁 commit）。
   *
   * v3 修正（2026-10-27）：新增 adopt 判定——云端备份**不含**本次高水位
   * 推进时（全新设备 / 兄弟端 commit 后备份联动失败），恢复备份只会倒灌
   * 旧状态、修不好。此时不再置 sibling-rotated 阻断账号，而是让调用方
   * 接管高水位（setCommitSeq）后照常执行。
   */
  const acquireClaimForCommit = useCallback(async (groupId: string, epoch: number): Promise<number | null> => {
    if (!storage || !pds || !identityKeys || !claimStore) return null;
    const params = await deriveRotationClaimParams(identityKeys.signing.publicKey);
    try {
      // 云端备份外层元数据（判定 stale vs adopt 的依据）。读取失败不阻断
      // 判定：拿不到就按「无法证明覆盖」→ adopt（fail-open towards 继续）。
      let cloudBackupMeta: BackupMeta | null = null;
      try {
        cloudBackupMeta = (await pds.getIdentityBackupRecord())?.meta ?? null;
      } catch (peekErr) {
        console.warn('[dme:claim] cloud backup meta peek failed:', peekErr);
      }
      const { verdict, seq } = await acquireRotationClaim(
        params,
        { groupId, epoch, localSeq: await storage.getCommitSeq(), cloudBackupMeta },
        claimStore,
      );
      if (verdict === 'acquired') return seq;
      if (verdict === 'adopt') {
        // 接管高水位：云端备份不含这次推进，本机并不比云端旧。恢复备份
        // 只会倒灌旧状态、修不好（实测死路），所以不阻断账号——先把本地
        // 高水位追平到云端值，后续 commit 正常进行。
        console.warn(
          '[dme:claim] adopt: taking over cloud watermark', seq,
          '- cloud backup lacks this advance, restoring would roll back',
        );
        await storage.setCommitSeq(seq);
        return seq;
      }
      console.warn(`[dme:claim] claim ${verdict}: commit blocked, backup restore required`, groupId);
      await storage.setSessionIssue(groupId, 'sibling-rotated');
      return null;
    } catch (err) {
      console.warn('[dme:claim] claim check failed, fail-closed (no commit)', groupId, err);
      return null;
    }
  }, [storage, pds, identityKeys, claimStore]);

  /** 释放宣言：commit/投递失败回滚时调用，避免虚高水位（尽力而为）。 */
  const releaseClaim = useCallback(async (): Promise<void> => {
    if (!pds || !identityKeys || !claimStore) return;
    const params = await deriveRotationClaimParams(identityKeys.signing.publicKey);
    await releaseRotationClaim(params, claimStore);
  }, [pds, identityKeys, claimStore]);

  /**
   * 手动备份（用户点「备份」/退出登录前备份）：约定「任何备份点都必须先
   * 遵守宣言」——手动备份没有前置 commit 动作，但它把本机当前状态写进
   * 云端，本机落后时会用旧状态覆盖新备份（备份分叉的另一入口）。
   * 先经宣言仲裁：busy（另一端正在操作）/ stale（本机长期落后且云端备份
   * 含该推进）一律拒绝并提示；adopt（云端备份不含该推进——本机并不比
   * 云端旧）则接管高水位后放行；通过则持锁备份（挡窗）+ 完成后恢复占用
   * 前的记录（备份不推进账号状态，兄弟端 commit 的高水位必须原样保留）。
   * PDS 不可用 fail-closed：无法仲裁时宁可不备份。
   */
  const backupIdentityGuarded = useCallback(async (password: string): Promise<void> => {
    if (!storage) throw new Error('backupIdentityGuarded: storage not initialized');
    if (!pds) throw new Error('backupIdentityGuarded: pds not initialized');
    if (!identityKeys) throw new Error('backupIdentityGuarded: identity keys not available');
    if (!claimStore) throw new Error('backupIdentityGuarded: claim store not available');
    const params = await deriveRotationClaimParams(identityKeys.signing.publicKey);
    // 云端备份外层元数据（stale vs adopt 判据）。读失败不阻断：拿不到就
    // 按「无法证明覆盖」→ adopt。
    let cloudBackupMeta: BackupMeta | null = null;
    try {
      cloudBackupMeta = (await pds.getIdentityBackupRecord())?.meta ?? null;
    } catch (peekErr) {
      console.warn('[dme:backup] cloud backup meta peek failed:', peekErr);
    }
    const outcome = await acquireBackupLock(
      params,
      await storage.getCommitSeq(),
      claimStore,
      cloudBackupMeta,
    );
    if (outcome.verdict === 'stale') {
      throw new Error('BACKUP_CLAIM_STALE');
    }
    if (outcome.verdict === 'busy') {
      throw new Error('BACKUP_CLAIM_BUSY');
    }
    if (outcome.verdict === 'adopt') {
      // 接管高水位：云端备份不含这次推进，本机状态并不比云端旧——拒绝备份
      // 会让用户永远推不上云端状态。追平本地高水位后照常备份（备份会把
      // 新的 commitSeq 一并写上云端，下次两端就一致了）。
      console.warn(
        '[dme:backup] adopt: taking over cloud watermark', outcome.seq,
        '- cloud backup lacks this advance',
      );
      await storage.setCommitSeq(outcome.seq);
    }
    const { handle } = outcome as { verdict: 'acquired'; handle: BackupLockHandle };
    try {
      await backupIdentity(password);
    } finally {
      await releaseBackupLock(handle, claimStore);
    }
  }, [storage, pds, identityKeys, claimStore, backupIdentity]);

  /**
   * 强制备份（接管高水位）：最新密钥材料因忘记备份而丢失时的唯一自救
   * 路径——宣言 stale 永久阻断正常备份，本机再也无法追平高水位。
   *
   * 不删除宣言（删除会丢失单调性、留下无仲裁窗口、且僵尸端归来后
   * seq 撞车会造成分叉）：改为读取 PDS 高水位并**接管为本地 commitSeq**，
   * 然后走正常的持锁备份（判定立刻通过，备份窗口内仍挡住兄弟端
   * commit）。云端备份会被本机较旧的状态覆盖且不可逆——调用方必须
   * 已获得用户对「丢弃其他设备新状态」的明确确认。
   * PDS 不可用/读取失败 fail-closed（peekCommitSeq 抛出即中止）。
   */
  const backupIdentityForced = useCallback(async (password: string): Promise<void> => {
    if (!storage) throw new Error('backupIdentityForced: storage not initialized');
    if (!identityKeys) throw new Error('backupIdentityForced: identity keys not available');
    if (!claimStore) throw new Error('backupIdentityForced: claim store not available');
    const params = await deriveRotationClaimParams(identityKeys.signing.publicKey);
    const cloudSeq = await peekCommitSeq(params, claimStore);
    if (cloudSeq !== null && cloudSeq > (await storage.getCommitSeq())) {
      await storage.setCommitSeq(cloudSeq);
      console.warn('[dme:claim] forced backup: adopted PDS high watermark', cloudSeq);
    }
    await backupIdentityGuarded(password);
  }, [storage, identityKeys, claimStore, backupIdentityGuarded]);

  const restoreIdentityFromBackup = useCallback(async (
    password: string,
    forceRestore = false,
  ): Promise<boolean> => {
    if (!pds) throw new Error('restoreIdentityFromBackup: pds not initialized');
    if (!storage) throw new Error('restoreIdentityFromBackup: storage not initialized');
    if (!poller) throw new Error('restoreIdentityFromBackup: poller not initialized');

    const encryptedData = await pds.getIdentityBackup();
    if (!encryptedData) return false;

    const data = decryptBackup(encryptedData, password);

    // 缺口③护栏：对每个 sibling-rotated 会话，云端备份必须确实包含兄弟端
    // 推进后的新状态——若备份里该会话与本机状态完全相同（备份停留在推进
    // 之前）或根本没有该会话，恢复只会倒灌旧状态（实测踩过：把重新握手的
    // 新会话覆盖回脱钩状态，Bob 立刻联系不上 Alice）。此时应先在已更新的
    // 设备上重新备份。设备间无法直接比对状态，这里以「备份内容 ≠ 本机
    // （落后的）内容」作为"备份包含推进"的充分条件。
    const staleGroupIds: string[] = [];
    for (const gid of await storage.listGroups()) {
      const restoreIssue = await storage.getSessionIssue(gid);
      // forked（谱系分叉）与 sibling-rotated 同理：备份必须确实包含与本机
      // 不同的状态（权威谱系）才允许恢复，否则恢复只是倒灌旧状态
      if (restoreIssue !== 'sibling-rotated' && restoreIssue !== 'forked') continue;
      const localSerialized = await storage.getMlsSession(gid);
      if (!localSerialized) continue; // 本机无此会话状态，无从比对
      const backupSerialized = data.mlsSessions[gid];
      if (!backupSerialized || backupSerialized === localSerialized) {
        staleGroupIds.push(gid);
      }
    }
    // 强制恢复（2026-10-21，场景二：已推进的设备丢失）：跳过 stale 护栏，
    // 其余逻辑与正常恢复完全一致。用户在确认框里已被告知后果——这些会话
    // 的新熵只存在于丢失的设备上，恢复后仍无法收发，需重新握手/重建。
    if (!forceRestore && staleGroupIds.length > 0) {
      throw new Error('RESTORE_BACKUP_STALE');
    }

    // 恢复身份密钥
    await storage.putIdentityKeys(data.identity);
    setIdentityKeys(data.identity);

    // 全量收敛：以云端备份为权威快照，删除本机多出来的会话。备份不含
    // 信令的账号级事实（如单方面删除好友）只能靠备份携带——恢复若只做
    // 合并，本机残留的会话会让已删好友复活（实测：a 删好友并备份，b 恢复
    // 后好友仍在列表且仍可解密收发）。连带清理消息、轮换时间戳、poller
    // 会话与孤儿群元数据；sessionIssue / queueId LRU 下面已有全局清理。
    const backupGroupIds = new Set(Object.keys(data.mlsSessions));
    for (const gid of await storage.listGroups()) {
      if (backupGroupIds.has(gid)) continue;
      poller.removeSession(gid);
      await storage.deleteMlsSession(gid);
      await storage.deleteMessages(gid);
      await storage.deleteRaw(`rotationAt:${gid}`);
      console.info('restoreIdentityFromBackup: removed local group not in backup', gid);
    }
    for (const info of await storage.listGroupInfos()) {
      if (!backupGroupIds.has(info.groupId)) {
        await storage.deleteGroupInfo(info.groupId);
      }
    }

    // 恢复 MLS sessions 并加载到 poller；同时写回轮换时间戳——否则多端
    // 同时恢复后 lastRotationAt 全部归零，又同时到期、同时轮换、再撞槽
    for (const [groupId, serialized] of Object.entries(data.mlsSessions)) {
      await storage.putMlsSession(groupId, serialized);
      await storage.setLastRotationAt(groupId, data.rotationAt?.[groupId] ?? 0);
      try {
        const impl = await getNobleMlsImpl();
        const mlsSession = await MlsSession.deserialize(serialized, impl);
        poller.addSession(groupId, mlsSession);
      } catch (err) {
        console.error('restoreIdentityFromBackup: failed to load MLS session', groupId, err);
      }
    }

    // 恢复 KeyPackage 池
    await storage.putKeyPackagePool(data.keyPackagePool);
    setKeyPackagePool(data.keyPackagePool);

    // 恢复群 commit 谱系账本（覆盖式；group-fork-plan.md 3.1）
    await storage.importGroupCommitLedger(data.groupCommitLedger ?? { lastSeq: {}, entries: {} });

    // 恢复群聊元数据
    for (const info of data.groupInfos) {
      await storage.putGroupInfo(info);
    }
    setGroupInfos(data.groupInfos);

    await storage.setBlockList(data.blockList);
    setBlockList(data.blockList);

    // 恢复账号级 commit 高水位（宣言 v2 比对基准；旧备份无此字段 → 0）
    await storage.setCommitSeq(data.commitSeq ?? 0);
    // v3 修正（2026-10-27）：恢复后必须把本地高水位追平到 PDS 宣言的实际
    // seq。备份是兄弟端 commit 后异步写云的，云端备份往往落后于宣言高水位
    //（实测：备份 seq≤29，宣言已到 30）。若只按备份 seq 设置，恢复后第一次
    // commit 就会撞 stale → 又被提示「恢复备份」→ 死循环。宣言本身没删，
    // 其 seq 就是本账号真实的水位，直接接管（adopt）即可继续 commit。
    // PDS 不可用时 fail-closed：保持备份里的 seq，宁保守不冒进。
    try {
      const params = await deriveRotationClaimParams(data.identity.signing.publicKey);
      if (!claimStore) throw new Error('claim store not initialized');
      const cloudSeq = await peekCommitSeq(params, claimStore);
      if (cloudSeq !== null && cloudSeq > (data.commitSeq ?? 0)) {
        await storage.setCommitSeq(cloudSeq);
        console.warn(
          '[dme:restore] adopted PDS high watermark', cloudSeq,
          '> backup commitSeq', data.commitSeq ?? 0,
          '- avoids stale loop on next commit',
        );
      }
    } catch (err) {
      console.error('[dme:restore] failed to peek claim watermark, keeping backup seq', err);
    }
    // 缺口⑨修复：恢复后状态整体重建（会话来自备份），旧的脱钩/兄弟轮换
    // 标记作废——必须在 setChatListVersion 之前清，否则 ChatListScreen
    // effect 监听 chatListVersion 首次跑会读到 storage 旧标记写进 React
    // state，之后没人再触发 setChatListVersion 重跑（收发正常路径不触发）
    // → 横幅永久卡住直到下次输密码恢复
    await storage.clearAllSessionIssues();
    // 缺口⑨修复：清空 queueId LRU 去重集合。b 端 web 之前用过 DME 时本机
    // 已用旧 mlsSession decrypt 过 a 端的 envelope，processed 集合残留
    // 在 localStorage；输密码恢复后 mlsSession 来自备份（a 端建群那一刻），
    // 旧 envelope 被 isQueueIdProcessed 命中直接跳过 → mlsSession 永远不
    // 推进 → exporterSecret 永远停在备份那一刻 → 后续 envelope 永远拉不到
    // → b 端自己发消息也用旧 mlsSession，a 端解不开。清空后 b 端重新 decrypt
    // 这些 envelope：commit wrapper 推进 mlsSession（自愈），群消息正常入屏。
    await storage.clearQueueIdLru();

    // 更新会话列表
    setGroups(Object.keys(data.mlsSessions));
    setChatListVersion((v) => v + 1);

    // 备份不含邀请状态：恢复后立即收敛本地残留的 pending 邀请（群会话
    // 已随备份恢复，残留记录会让邀请卡片复活），并同步界面状态
    const reconciledInvites = await reconcileStaleGroupInvites(storage);
    setReceivedGroupInvites(reconciledInvites.filter((i) => i.inviteeDid === session?.did));

    // 1.2：恢复时也输过密码，同样记住（用户拍板）
    await saveBackupPassword(password);
    await storage.setBackupRequired(false);
    setBackupRequiredState(false);

    return true;
  }, [pds, storage, poller, session]);

  const hasIdentityBackup = useCallback(async (): Promise<boolean> => {
    if (!pds) return false;
    const data = await pds.getIdentityBackup();
    return data !== null;
  }, [pds]);

  // -----------------------------------------------------------------------
  // 定期密钥轮换（key-rotation-plan.md 1.3 / 1.5）
  // -----------------------------------------------------------------------

  const runRotationCheck = useCallback((): void => {
    if (!session || !storage || !pds || !poller || !identityKeys) return;
    const deps: RotationDeps = {
      listGroupIds: () => storage.listGroups(),
      getSession: (groupId) => poller.getSession(groupId),
      reloadSession: async (groupId, serialized) => {
        const impl = await getNobleMlsImpl();
        const restored = await MlsSession.deserialize(serialized, impl);
        poller.addSession(groupId, restored);
      },
      putMlsSession: (groupId, serialized) => storage.putMlsSession(groupId, serialized),
      createEnvelope: (envelope) => pds.createEnvelope(envelope),
      getIntervalMs: () => storage.getKeyRotationIntervalMs(),
      getLastRotationAt: (groupId) => storage.getLastRotationAt(groupId),
      setLastRotationAt: (groupId, ts) => storage.setLastRotationAt(groupId, ts),
      // 缺口②：带异常标记的会话（desynced / sibling-rotated / forked）不参与轮换——
      // 状态已废，轮换无收益，且会在克隆端之间制造 sibling-rotated 横幅风暴
      getSessionIssue: (groupId) => storage.getSessionIssue(groupId),
      claimStore: claimStore as RotationClaimStore,
      getCommitSeq: () => storage.getCommitSeq(),
      setCommitSeq: (seq) => storage.setCommitSeq(seq),
      // v3 修正：云端备份外层元数据（stale vs adopt 判据）。读失败返回 null
      // ——不阻断轮换，按「无法证明覆盖」处理。
      getCloudBackupMeta: async () => {
        try {
          return (await pds.getIdentityBackupRecord())?.meta ?? null;
        } catch (err) {
          console.warn('[dme:rotation] cloud backup meta peek failed:', err);
          return null;
        }
      },
      // 群 commit 谱系账本（group-fork-plan.md 3.1）：轮换 commit 携带
      // per-group seq 并写回 queueId，供全员分叉检测
      reserveGroupCommit: (groupId) => storage.reserveGroupCommit(groupId),
      appendGroupCommitQueueId: (groupId, seq, queueId) =>
        storage.appendGroupCommitQueueId(groupId, seq, queueId),
      getIdentitySigningPublicKey: async () => identityKeys.signing.publicKey,
      onRotated: async (groupId) => {
        // 1.5 备份联动（统一走 triggerBackupAfterAdvance）：有缓存密码 →
        // 静默刷新备份；无 → 置强提示标记。
        await triggerBackupAfterAdvance(`rotation of ${groupId}`);
      },
      onAborted: (groupId, reason) => {
        console.warn('[dme:rotation] rotation aborted', groupId, reason);
        // sibling-rotated 与 stale（宣言 v2 检测到的备份分叉/对端已认领）
        // 恢复路径一致：本机落后，宣言失败即提示恢复最新备份（约定9），
        // 复用同一标记与会话列表横幅。
        void storage.setSessionIssue(groupId, 'sibling-rotated');
      },
    };
    maybeRotateGroups(deps);
  }, [session, storage, pds, poller, identityKeys, triggerBackupAfterAdvance]);

  // runRotationCheck 依赖在它之后定义的 backupIdentity 之前就绪即可；
  // setKeyRotationIntervalMs 经 ref 调用，避免声明顺序循环
  const runRotationCheckRef = useRef<(() => void) | null>(null);
  runRotationCheckRef.current = runRotationCheck;

  useEffect(() => {
    if (!poller) return;
    // 启动后延迟首检（让首轮 poll 先跑），此后定时 + 回前台触发
    const initial = setTimeout(() => runRotationCheck(), 60_000);
    const periodic = setInterval(() => runRotationCheck(), 30 * 60 * 1000);
    const appStateSub = RNAppState.addEventListener('change', (state) => {
      if (state === 'active') runRotationCheck();
    });
    return () => {
      clearTimeout(initial);
      clearInterval(periodic);
      appStateSub.remove();
    };
  }, [runRotationCheck, poller]);

  /**
   * 存量 sibling-rotated 标记自愈（v3 修正，2026-10-27）。
   *
   * 问题：v2 把「PDS 高水位 > 本地 seq」一律判 stale 并永久贴上
   * sibling-rotated 标记，横幅不可关闭、也无自愈路径。实测用户反馈
   * 「我没备份过，为什么叫我恢复备份」——而那份备份压根不含所需状态，
   * 恢复是死路。
   *
   * 自愈逻辑：启动时复检每个带 sibling-rotated 标记的会话——若当前判定
   * 已不是「云端备份能覆盖该推进」（即 adoptable / consistent），说明当初
   * 那个 stale 判定的前提已消失（云端备份后来才刷新，或本机已追平），
   * 标记应清掉，横幅随之消失。若判定仍是 ahead（云端备份确实含该推进），
   * 保留标记——那种情况恢复备份**确实**有效。
   *
   * 顺带：adoptable 时把本地 commitSeq 追平到云端高水位，避免下次
   * commit 又撞同一高水位。
   */
  useEffect(() => {
    if (!storage || !pds || !identityKeys || !claimStore) return;
    let cancelled = false;
    void (async () => {
      try {
        const params = await deriveRotationClaimParams(identityKeys.signing.publicKey);
        let cloudBackupMeta: BackupMeta | null = null;
        try {
          cloudBackupMeta = (await pds.getIdentityBackupRecord())?.meta ?? null;
        } catch (peekErr) {
          console.warn('[dme:claim] cloud backup meta peek failed:', peekErr);
        }
        const localSeq = await storage.getCommitSeq();
        const inspection = await inspectClaimWatermark(params, localSeq, claimStore, cloudBackupMeta);

        if (inspection === 'consistent') {
          // 本机与云端一致：任何残留的 sibling-rotated 都是过期判定
          // （云端备份后来才刷新 / 本机已追平）→ 清除。
          const groupIds = await storage.listGroups();
          let cleared = 0;
          for (const gid of groupIds) {
            if (await storage.getSessionIssue(gid) === 'sibling-rotated') {
              await storage.setSessionIssue(gid, null);
              cleared++;
            }
          }
          if (cleared > 0) {
            console.warn('[dme:claim] self-heal: cleared stale sibling-rotated marks', cleared);
            setChatListVersion((v) => v + 1);
          }
          return;
        }

        if (inspection === 'adoptable') {
          // 云端高水位高于本机，但云端备份不含该推进 → 恢复备份修不好，
          // 不该继续用「恢复备份」横幅挡着用户。接管高水位 + 清除标记。
          const cloudSeq = await peekCommitSeq(params, claimStore);
          if (cloudSeq !== null && cloudSeq > localSeq) {
            await storage.setCommitSeq(cloudSeq);
            console.warn('[dme:claim] self-heal: adopted cloud watermark', cloudSeq);
          }
          const groupIds = await storage.listGroups();
          let cleared = 0;
          for (const gid of groupIds) {
            if (await storage.getSessionIssue(gid) === 'sibling-rotated') {
              await storage.setSessionIssue(gid, null);
              cleared++;
            }
          }
          if (cleared > 0) {
            console.warn('[dme:claim] self-heal: cleared sibling-rotated marks (adoptable)', cleared);
            setChatListVersion((v) => v + 1);
          }
        }
        // inspection === 'ahead'：云端备份确实含该推进 → 保留标记，
        // 横幅引导恢复备份（那种情况恢复**确实**有效）。
      } catch (err) {
        console.warn('[dme:claim] self-heal check failed:', err);
      } finally {
        if (!cancelled) void cancelled;
      }
    })();
    return () => { cancelled = true; };
  }, [storage, pds, identityKeys, claimStore]);

  // -------------------------------------------------------------------------
  // Invite / Accept
  // -------------------------------------------------------------------------

  const generateInviteQr = useCallback(async (
    bobDid: string,
  ): Promise<{ qrString: string; keyPackageInitKey: Uint8Array; keyPackageSerialized: string; welcomeQueueId: string }> => {
    if (!storage || !identityKeys || !session || !poller) {
      throw new Error('generateInviteQr: not fully initialized');
    }

    // KP 池统一消费（rotation-baseline-plan.md 3.2/3.3）：取新鲜条目并立即
    // 标 consumed（QR 生成即外发公钥包，同既有语义）
    const { pair } = await takeFreshPoolPair('generateInviteQr', true);

    // Get Bob's X25519 public key
    const bobEncKey = await getRemoteEncryptionKey(bobDid);
    if (!bobEncKey) throw new Error('generateInviteQr: Bob has no DME encryption key');

    // Encrypt KeyPackage and create QR
    const encrypted = await encryptKeyPackage(pair.publicPackage, bobEncKey);
    const encryptedKeyPackage = serializeEncryptedKeyPackage(
      encrypted.ephemeralPublicKey,
      encrypted.ciphertext,
    );
    const qrString = encodeQrPayload({ encryptedKeyPackage, aliceDid: session.did });
    const keyPackageInitKey = pair.publicPackage.initKey;
    const keyPackageSerialized = serializeWithUint8Array(pair);
    const welcomeQueueId = deriveWelcomeQueueId(keyPackageInitKey);

    // Pending welcome is NOT tracked here; caller should track it only after
    // the invite post is actually published (see trackInvitePendingWelcome).
    return { qrString, keyPackageInitKey, keyPackageSerialized, welcomeQueueId };
  }, [storage, identityKeys, session, poller, takeFreshPoolPair]);

  const trackInvitePendingWelcome = useCallback(async (
    bobDid: string,
    keyPackageSerialized: string,
    welcomeQueueId: string,
  ): Promise<void> => {
    if (!storage || !poller) {
      throw new Error('trackInvitePendingWelcome: not fully initialized');
    }

    const entry: PendingWelcome = {
      queueId: welcomeQueueId,
      groupId: bobDid,
      keyPackageSerialized,
      createdAt: new Date().toISOString(),
    };
    await storage.putPendingWelcome(entry);
    poller.addPendingWelcome(entry);
    setPendingWelcomes((prev) => [...prev, entry]);
  }, [storage, poller]);

  const deletePendingWelcome = useCallback(async (queueId: string): Promise<void> => {
    if (!storage || !poller) {
      throw new Error('deletePendingWelcome: not fully initialized');
    }

    await storage.deletePendingWelcome(queueId);
    poller.removePendingWelcome(queueId);
    setPendingWelcomes((prev) => prev.filter((w) => w.queueId !== queueId));
  }, [storage, poller]);

  /**
   * 握手成功建立 1v1 会话后自动发送打招呼文案（设置页可配，必填）。
   * 定义在 sendMessage 之后（3166 行附近），这里用 ref 转发——同
   * processWelcomeRef 的理由：acceptInviteQr / processReceivedWelcome /
   * acceptRescueInvite 都定义在 sendMessage 之前，闭包直接引用会 TDZ。
   */
  const sendGreetingRef = useRef<(groupId: string) => Promise<void>>(
    async () => {
      throw new Error('sendGreetingAfterHandshake 尚未就绪');
    },
  );

  const acceptInviteQr = useCallback(async (qrString: string): Promise<void> => {
    if (!storage || !identityKeys || !session || !pds || !poller) {
      throw new Error('acceptInviteQr: not fully initialized');
    }

    // 宣言门禁（约定7）：建立 1v1 会话（备份点）前必须先宣言——同账号
    // 多端同时扫同一码会各自生成不同叶密钥、同 groupId 状态分叉；
    // taken/stale 已置 sibling-rotated 提示恢复备份，fail-closed 放弃本次添加
    const { aliceDid } = await decodeAndDecryptQr(qrString, identityKeys.encryption.privateKey);
    const claimSeq = await acquireClaimForCommit(aliceDid, 0);
    if (claimSeq === null) {
      throw new Error('acceptInviteQr: claim denied (backup restore required or PDS unavailable)');
    }

    // KP 池统一消费（rotation-baseline-plan.md 3.2）：Bob 叶子密钥改吃池，
    // 宣言通过后才取（失败不浪费池位），立即标 consumed（私钥随即进本机会话）
    let poolPair: KeyPackagePair;
    try {
      poolPair = (await takeFreshPoolPair('acceptInviteQr', true)).pair;
    } catch (err) {
      await releaseClaim();
      throw err;
    }

    let result: Awaited<ReturnType<typeof acceptInvite>>;
    try {
      result = await acceptInvite(session.did, identityKeys, qrString, poolPair);
    } catch (err) {
      await releaseClaim();
      throw err;
    }

    // Store MLS session
    await storage.putMlsSession(result.groupId, result.mlsSession.serialize());
    poller.addSession(result.groupId, result.mlsSession);
    await storage.setCommitSeq(claimSeq);

    // 记录 welcome 日期，供救援 queueId 派生使用
    const createdAt = new Date().toISOString();
    await storage.setWelcomeDate(result.groupId, createdAt.slice(0, 10));

    // 缺口①：握手推进了会话状态，立即联动备份——保证兄弟端之后恢复
    // 备份时拿到的是新会话，而不是被倒灌回旧状态
    await triggerBackupAfterAdvance(`acceptInvite ${result.groupId}`);

    // Store Welcome as PDS envelope so Alice can poll for it
    const envelope: DmeEnvelope = {
      $type: 'dme.queue.envelope',
      queueId: result.welcomeQueueId,
      payload: result.welcomePayload,
      createdAt,
      messageType: 'welcome',
    };
    await pds.createEnvelope(envelope);

    setGroups((prev) => [...prev, result.groupId]);
    setChatListVersion((v) => v + 1);

    // 私聊会话建立成功 → 自动发送打招呼文案（尽力而为，失败不影响握手）
    void sendGreetingRef.current(result.groupId).catch((err) => {
      console.error('sendGreetingAfterHandshake (acceptInviteQr) failed:', err);
    });
  }, [storage, identityKeys, session, pds, poller, triggerBackupAfterAdvance, acquireClaimForCommit, releaseClaim, takeFreshPoolPair]);

  // -------------------------------------------------------------------------
  // Process received Welcome (called from poller callback)
  // -------------------------------------------------------------------------

  const processReceivedWelcome = useCallback(async (welcome: IncomingWelcome): Promise<void> => {
    if (!storage || !identityKeys || !session || !poller) {
      console.error('processReceivedWelcome: not fully initialized');
      return;
    }

    const welcomes = await storage.getPendingWelcomes();
    const entry = welcomes.find((w) => w.queueId === welcome.queueId);
    if (!entry) {
      // ⚠️ 必须 throw 而不是静默 return：poller 的 rescue_callback 分支
      //    靠异常感知「未消费」——静默 return 会让 poller 把该 queueId
      //    标记为已处理，Welcome 永久丢失（2026-10-28 真机：发起端永远
      //    等不到回调、callback 通道死轮询的直接原因之一）。
      throw new Error('processReceivedWelcome: no pending welcome for ' + welcome.queueId);
    }

    const pair = deserializeWithUint8Array<KeyPackagePair>(entry.keyPackageSerialized);

    const result = await processWelcome(
      welcome.welcomeBytes,
      session.did,
      identityKeys,
      pair.publicPackage,
      pair.privatePackage,
    );

    await storage.putMlsSession(result.groupId, result.mlsSession.serialize());
    poller.addSession(result.groupId, result.mlsSession);

    // 记录 welcome 日期（救援握手成功后也走这里，更新日期以隔离旧救援消息）
    await storage.setWelcomeDate(result.groupId, welcome.createdAt.slice(0, 10));

    // 如果是救援 callback，清除 pending 标记。
    // 同时推进救援纪元：本次 Welcome 的 queueId 就是双方约定的下一个纪元
    // 本机（发起端）在这里写 welcome.queueId；接受端在 acceptRescueInvite 时
    // 写 invite.callbackQueueId。双端独立持久化同一个值，天然一致。
    const rescueCallbackRecord = await storage.getRescueCallback(result.groupId);
    if (rescueCallbackRecord && rescueCallbackRecord.callbackQueueId === welcome.queueId) {
      await storage.setRescueEpoch(result.groupId, welcome.queueId);
    }
    await storage.clearRescueCallback(result.groupId);
    // 立即停扫 callback 通道（不等 60s 刷新），避免死轮询观感
    poller.setRescueCallbackQueueId(result.groupId, null);
    // 立即切换救援通道纪元（welcomeDate 已更新 → queueId 重派生）
    refreshRescueQueueIdsRef.current();

    // 缺口①：接会话推进了状态，立即联动备份（同 acceptInviteQr）
    await triggerBackupAfterAdvance(`processWelcome ${result.groupId}`);

    await storage.deletePendingWelcome(welcome.queueId);
    poller.removePendingWelcome(welcome.queueId);

    setGroups((prev) => [...prev, result.groupId]);
    setPendingWelcomes((prev) => prev.filter((w) => w.queueId !== welcome.queueId));
    setChatListVersion((v) => v + 1);

    // 私聊会话建立成功（含救援 callback）→ 自动发送打招呼文案（尽力而为）
    void sendGreetingRef.current(result.groupId).catch((err) => {
      console.error('sendGreetingAfterHandshake (processReceivedWelcome) failed:', err);
    });
  }, [storage, identityKeys, session, poller, triggerBackupAfterAdvance]);

  processWelcomeRef.current = processReceivedWelcome;

  // -------------------------------------------------------------------------
  // 1v1 rescue handshake
  // -------------------------------------------------------------------------

  /**
   * Compute and inject rescue/callback queueIds for all 1v1 sessions.
   * Called whenever groups, identity, or date may have changed.
   */
  /**
   * 解析 1v1 会话的 welcomeDate（救援通道派生的关键输入）。
   *
   * 三处必须用**完全相同**的规则，否则双方派生的 rescue queueId 不一致 →
   * 一方写、另一方扫不到（表现为「对方收到救援标记，但本机没有卡片」）：
   *   - refreshRescueQueueIds：扫对方通道
   *   - sendRescueHandshake：写自己通道
   *   - handleRescueMessage：解密对方消息
   *
   * 优先取持久化的 welcomeDate（握手成功时写入）；老用户（该特性上线前
   * 握手）没有 → 退回「第一条历史消息的日期」；再没有 → 当天。
   */
  const resolveWelcomeDate = useCallback(async (groupId: string): Promise<string> => {
    const today = new Date().toISOString().slice(0, 10);
    const stored = await storage!.getWelcomeDate(groupId);
    if (stored) return stored;
    const messages = await storage!.getMessages(groupId);
    if (messages.length > 0) {
      const earliest = messages.reduce((min, m) =>
        m.createdAt < min.createdAt ? m : min,
      );
      return earliest.createdAt.slice(0, 10);
    }
    return today;
  }, [storage]);

  /**
   * 解析 1v1 会话的救援通道纪元。
   *
   * 优先用 rescueEpoch（每次握手成功后双端各自写入「本次握手的
   * callbackQueueId」，双端可独立算出同一个值）；未设置（从未经新版
   * 完成过握手）时退回 welcomeDate，与旧版行为完全兼容。
   *
   * ⚠️ 扫通道（refreshRescueQueueIds）、写通道（sendRescueHandshake）、
   * 解密（handleRescueMessage）三处必须同源，否则 queueId/message key
   * 不一致。
   */
  const resolveRescueEpoch = useCallback(async (groupId: string): Promise<string> => {
    const epoch = await storage!.getRescueEpoch(groupId);
    if (epoch) return epoch;
    return resolveWelcomeDate(groupId);
  }, [storage, resolveWelcomeDate]);

  const refreshRescueQueueIds = useCallback(async (): Promise<void> => {
    if (!poller || !storage || !identityKeys || !session) return;

    const today = new Date().toISOString().slice(0, 10);
    const groupIds = await storage.listGroups();

    for (const groupId of groupIds) {
      // Only 1v1 conversations have groupId === friendDid and no GroupInfo.
      const groupInfo = await storage.getGroupInfo(groupId);
      if (groupInfo) continue;

      const welcomeDate = await resolveWelcomeDate(groupId);
      // 救援通道纪元：优先 rescueEpoch（每次握手成功后轮换），退回 welcomeDate
      const rescueEpoch = await resolveRescueEpoch(groupId);

      // callback 通道（我方已发起、等对方 Welcome）与救援通道（等对方发起）
      // **并行扫描**。
      //
      // ⚠️ 早前实现是「二选一」：一旦本机发起救援就停扫救援通道，只扫
      // callback。若双方同一天都发起救援 → 双方都停扫对方救援通道 →
      // 互等死锁（谁都收不到对方的救援请求，谁都不施救）。
      // 由于救援 queueId 本就按 writerDid 分离（我方只扫对方写的那个），
      // 并行扫描不会扫到自己发的消息，无需互斥。
      const pendingCallback = await storage.getRescueCallback(groupId);
      if (pendingCallback && pendingCallback.date === today) {
        poller.setRescueCallbackQueueId(groupId, pendingCallback.callbackQueueId);
      } else {
        poller.setRescueCallbackQueueId(groupId, null);
      }

      try {
        const theirEncPub = await getRemoteEncryptionKey(groupId);
        if (!theirEncPub) {
          throw new Error('peer encryption key not found');
        }
        const sharedSecret = computeRescueSharedSecret(
          identityKeys.encryption.privateKey,
          theirEncPub,
        );
        // We poll the peer's rescue queueId (written by the peer).
        const rescueQueueId = deriveRescueQueueId(
          sharedSecret,
          groupId, // peer DID == writerDid for the queueId we scan
          rescueEpoch,
          today,
        );
        poller.setRescueQueueId(groupId, rescueQueueId);
      } catch (err) {
        console.warn('[dme:rescue] failed to derive rescue queueId for', groupId, err);
        poller.setRescueQueueId(groupId, null);
      }
    }
  }, [poller, storage, identityKeys, session, resolveWelcomeDate, resolveRescueEpoch]);

  // 通道刷新 ref（processReceivedWelcome 定义在本函数之前，需要跨引用）
  const refreshRescueQueueIdsRef = useRef<() => void>(() => {});
  refreshRescueQueueIdsRef.current = () => { void refreshRescueQueueIds(); };

  /**
   * Handle a rescue message received from the peer.
   *
   * @returns true = 消息已被成功消费（poller 可标记为已处理）；
   *          false = 消费失败（poller 必须**不要**标记，否则该 queueId 会被
   *          LRU 永久跳过、救援消息再也取不到）。
   */
  const handleRescueMessage = useCallback(async (
    groupId: string,
    payloadBase64url: string,
    queueId: string,
  ): Promise<boolean> => {
    if (!storage || !identityKeys || !session) {
      console.error('handleRescueMessage: not fully initialized');
      return false;
    }

    const today = new Date().toISOString().slice(0, 10);
    // ⚠️ 必须与发送方用**完全相同**的纪元（rescueEpoch ?? welcomeDate），
    //    否则派生出的 message key 不同 → 解密失败。
    const rescueEpoch = await resolveRescueEpoch(groupId);

    let theirSigningPub: Uint8Array;
    let theirEncPub: Uint8Array;
    try {
      const signingPub = await getRemoteSigningKey(groupId);
      const encPub = await getRemoteEncryptionKey(groupId);
      if (!signingPub || !encPub) {
        throw new Error('peer keys not found');
      }
      theirSigningPub = signingPub;
      theirEncPub = encPub;
    } catch (err) {
      console.warn('[dme:rescue] failed to resolve peer keys for', groupId, err);
      return false;
    }

    const sharedSecret = computeRescueSharedSecret(
      identityKeys.encryption.privateKey,
      theirEncPub,
    );

    let decrypted: { message: { fromDid: string; qrData: string; callbackQueueId: string } };
    try {
      decrypted = decryptRescueMessage(
        payloadBase64url,
        sharedSecret,
        groupId, // peer is the writer
        rescueEpoch,
        today,
        theirSigningPub,
      );
    } catch (err) {
      console.warn('[dme:rescue] failed to decrypt rescue message for', groupId, err);
      return false;
    }

    const { message } = decrypted;
    if (message.fromDid !== groupId) {
      console.warn('[dme:rescue] rescue fromDid mismatch', message.fromDid, '!=', groupId);
      return false;
    }

    const invite: import('../protocol/rescue').PendingRescueInvite = {
      date: today,
      fromDid: message.fromDid,
      qrData: message.qrData,
      callbackQueueId: message.callbackQueueId,
    };

    await storage.setRescueInvite(groupId, invite);
    // 记录本条信封已成功消费 —— poller 自愈判据用（见 storage.setRescueConsumed
    // 的说明：不能用 rescueInvite 做判据，用户接受救援后它会被清掉）。
    await storage.setRescueConsumed(groupId, queueId);
    setPendingRescueInvites((prev) => {
      const filtered = prev.filter((i) => i.fromDid !== groupId);
      return [...filtered, invite];
    });
    setChatListVersion((v) => v + 1);
    return true;
  }, [storage, identityKeys, session, resolveWelcomeDate, resolveRescueEpoch]);

  handleRescueMessageRef.current = handleRescueMessage;

  /**
   * User declines a rescue invite (only hides it for today).
   */
  const declineRescueInvite = useCallback(async (groupId: string): Promise<void> => {
    if (!storage) return;
    await storage.clearRescueInvite(groupId);
    setPendingRescueInvites((prev) => prev.filter((i) => i.fromDid !== groupId));
    setChatListVersion((v) => v + 1);
  }, [storage]);

  /**
   * User accepts a rescue invite: perform acceptInvite and deliver Welcome.
   */
  const acceptRescueInvite = useCallback(async (groupId: string): Promise<void> => {
    if (!storage || !identityKeys || !session || !pds || !poller) {
      throw new Error('acceptRescueInvite: not fully initialized');
    }

    const invite = await storage.getRescueInvite(groupId);
    if (!invite) {
      throw new Error('acceptRescueInvite: no pending invite for ' + groupId);
    }

    // KP 池统一消费：先取 pair，失败则刷新后重试一次
    let poolPair: KeyPackagePair;
    try {
      poolPair = (await takeFreshPoolPair('acceptRescueInvite', false)).pair;
    } catch {
      await refreshKeyPackagePool();
      poolPair = (await takeFreshPoolPair('acceptRescueInvite', false)).pair;
    }

    // acceptInvite 推进状态，必须过宣言门禁
    const { aliceDid } = await decodeAndDecryptQr(invite.qrData, identityKeys.encryption.privateKey);
    const claimSeq = await acquireClaimForCommit(aliceDid, 0);
    if (claimSeq === null) {
      throw new Error('acceptRescueInvite: claim denied');
    }

    let result: Awaited<ReturnType<typeof acceptInvite>>;
    try {
      result = await acceptInvite(session.did, identityKeys, invite.qrData, poolPair);
    } catch (err) {
      await releaseClaim();
      throw err;
    }

    await storage.putMlsSession(result.groupId, result.mlsSession.serialize());
    poller.addSession(result.groupId, result.mlsSession);
    await storage.setCommitSeq(claimSeq);

    const createdAt = new Date().toISOString();
    await storage.setWelcomeDate(result.groupId, createdAt.slice(0, 10));
    // 救援纪元轮换：以本次握手的 callbackQueueId 作为新纪元。双端各自持久化，
    // 值天然一致（对端在消费 Welcome 时写同一个 queueId）。同一天内重复
    // 救援时 welcomeDate 不变，必须靠 epoch 让通道真正轮换。
    await storage.setRescueEpoch(result.groupId, invite.callbackQueueId);
    // 立即切换救援通道纪元（welcomeDate 已更新），不等 60s 定时刷新
    void refreshRescueQueueIds();

    await triggerBackupAfterAdvance(`acceptRescueInvite ${result.groupId}`);

    const envelope: import('../protocol/types').DmeEnvelope = {
      $type: 'dme.queue.envelope',
      queueId: invite.callbackQueueId,
      payload: result.welcomePayload,
      createdAt,
      messageType: 'welcome',
    };
    await pds.createEnvelope(envelope);

    await storage.clearRescueInvite(result.groupId);
    setPendingRescueInvites((prev) => prev.filter((i) => i.fromDid !== result.groupId));
    setChatListVersion((v) => v + 1);

    // 救援握手成功、新 1v1 会话建立 → 自动发送打招呼文案（尽力而为）
    void sendGreetingRef.current(result.groupId).catch((err) => {
      console.error('sendGreetingAfterHandshake (acceptRescueInvite) failed:', err);
    });
  }, [storage, identityKeys, session, pds, poller, takeFreshPoolPair, refreshKeyPackagePool, acquireClaimForCommit, triggerBackupAfterAdvance, refreshRescueQueueIds]);

  /**
   * Prompt the user to leave a rescue marker when entering a 1v1 chat.
   */
  const checkRescuePrompt = useCallback(async (groupId: string): Promise<boolean> => {
    if (!storage || !identityKeys || !session || !pds) return false;

    const today = new Date().toISOString().slice(0, 10);

    const pendingCallback = await storage.getRescueCallback(groupId);
    if (pendingCallback && pendingCallback.date === today) return false;

    if (await storage.wasRescuePromptedToday(groupId, today)) return false;

    // Conditions: no message from peer for 7 days AND no envelope received in last 3 polls.
    const messages = await storage.getMessages(groupId);
    const lastPeerMessage = messages
      .filter((m) => m.fromDid === groupId)
      .pop();
    if (lastPeerMessage) {
      const ageMs = Date.now() - Date.parse(lastPeerMessage.createdAt);
      if (ageMs < 7 * 24 * 60 * 60 * 1000) return false;
    }

    // TODO: track last 3 poll results per 1v1 session; for now require 7-day silence.

    return true;
  }, [storage, identityKeys, session, pds]);

  /**
   * Send a rescue handshake request for a 1v1 conversation.
   */
  const sendRescueHandshake = useCallback(async (groupId: string): Promise<void> => {
    if (!storage || !identityKeys || !session || !pds) {
      throw new Error('sendRescueHandshake: not fully initialized');
    }

    const today = new Date().toISOString().slice(0, 10);
    // ⚠️ 与接收方必须用**完全相同**的纪元规则（见 resolveRescueEpoch）
    const rescueEpoch = await resolveRescueEpoch(groupId);

    // KP 池统一消费：先取 pair，失败则刷新后重试一次
    let poolPair: KeyPackagePair;
    try {
      poolPair = (await takeFreshPoolPair('sendRescueHandshake', false)).pair;
    } catch {
      await refreshKeyPackagePool();
      poolPair = (await takeFreshPoolPair('sendRescueHandshake', false)).pair;
    }

    const theirEncPub = await getRemoteEncryptionKey(groupId);
    if (!theirEncPub) {
      throw new Error('peer encryption key not found');
    }
    const qrResult = await prepareInviteQr(session.did, poolPair, theirEncPub);
    const callbackQueueId = deriveWelcomeQueueId(qrResult.keyPackageInitKey);

    const sharedSecret = computeRescueSharedSecret(
      identityKeys.encryption.privateKey,
      theirEncPub,
    );

    const rescueQueueId = deriveRescueQueueId(
      sharedSecret,
      session.did, // we write to our own rescue queueId
      rescueEpoch,
      today,
    );

    const rescueMessage = {
      type: 'need_rescue' as const,
      fromDid: session.did,
      qrData: qrResult.qrString,
      callbackQueueId,
      sentAt: new Date().toISOString(),
      nonce: createRescueNonce(),
    };

    const ciphertext = encryptRescueMessage(
      rescueMessage,
      sharedSecret,
      session.did,
      rescueEpoch,
      today,
      identityKeys.signing.privateKey,
    );

    const envelope: import('../protocol/types').DmeEnvelope = {
      $type: 'dme.queue.envelope',
      queueId: rescueQueueId,
      payload: ciphertext,
      createdAt: new Date().toISOString(),
      messageType: 'application',
    };
    await pds.createEnvelope(envelope);

    // 旧的 PendingWelcome（同会话更早发起、queueId 不同）一并清理，
    // 避免孤儿通道永远留在轮询集合里。⚠️ 必须在 setRescueCallback 覆盖前读。
    const previousCallback = await storage.getRescueCallback(groupId);
    if (previousCallback && previousCallback.callbackQueueId !== callbackQueueId) {
      await storage.deletePendingWelcome(previousCallback.callbackQueueId).catch(() => {});
      poller?.removePendingWelcome(previousCallback.callbackQueueId);
    }

    await storage.setRescueCallback(groupId, { date: today, callbackQueueId });

    // ⚠️ 关键修复（2026-10-28 真机）：必须登记 PendingWelcome！否则对方
    //    接受救援后把 Welcome 发到 callbackQueueId 时，processReceivedWelcome
    //    找不到 KP pair（「no pending welcome」）直接返回，而 poller 照样把
    //    该 queueId 标记为已处理 → Welcome 永久丢失、本机永远进不了新会话、
    //    clearRescueCallback 永远走不到 → callback/救援通道死轮询。
    const pendingWelcomeEntry: PendingWelcome = {
      queueId: callbackQueueId,
      groupId,
      keyPackageSerialized: serializeWithUint8Array(poolPair),
      createdAt: new Date().toISOString(),
    };
    await storage.putPendingWelcome(pendingWelcomeEntry);
    // 本机转为等待对方的 Welcome：扫 callback 通道。
    // ⚠️ **不停止扫救援通道** —— 救援 queueId 按 writerDid 分离（本机只扫
    // 对方写的那个），并行扫描不会扫到自己发的消息；而若停扫，双方同一天
    // 都发起救援时会互等死锁（谁都收不到对方的救援请求）。
    // 救援通道 queueId 由 refreshRescueQueueIds 每 60s 统一刷新。
    if (poller) {
      poller.addPendingWelcome(pendingWelcomeEntry);
      poller.setRescueCallbackQueueId(groupId, callbackQueueId);
    }
  }, [storage, identityKeys, session, pds, poller, takeFreshPoolPair, refreshKeyPackagePool, resolveWelcomeDate, resolveRescueEpoch]);

  // -------------------------------------------------------------------------
  // Rescue queueId refresh side effects
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (!poller || !storage || !identityKeys || !session) return;
    void refreshRescueQueueIds();
    const id = setInterval(() => void refreshRescueQueueIds(), 60_000);
    return () => clearInterval(id);
  }, [poller, storage, identityKeys, session, refreshRescueQueueIds]);

  const downloadFile = useCallback(async (
    conversationId: string,
    msgId: string,
  ): Promise<void> => {
    if (!storage || !pds) {
      throw new Error('downloadFile: not initialized');
    }

    const msgs = await storage.getMessages(conversationId);
    const msg = msgs.find((m) => m.id === msgId);
    if (!msg || !msg.fileMeta) {
      throw new Error('downloadFile: message or fileMeta not found');
    }

    const { fileMeta } = msg;
    const fileKey = base64urlToBytes(fileMeta.fileKey);
    const fileId = hexToBytes(fileMeta.fileId);
    const blobCids = fileMeta.blobCids;
    if (!blobCids || blobCids.length === 0) {
      throw new Error('downloadFile: blobCids missing from fileMeta');
    }

    await storage.updateFileMessageMeta(conversationId, msgId, {
      downloadStatus: 'downloading',
    });
    setChatListVersion((v) => v + 1);

    const retryDelays = [2000, 4000, 8000];
    const maxAttempts = 3;
    let attempts = 0;
    let lastError: unknown = null;

    while (attempts < maxAttempts) {
      try {
        const senderPdsUrl = await resolvePdsUrl(msg.fromDid);

        const totalBlobBytes = blobCids.reduce((sum, b) => sum + b.size, 0) || 1;
        let downloadedBytes = 0;
        let lastProgress = -1;

        const decryptedChunks: Uint8Array[] = [];
        for (let i = 0; i < blobCids.length; i++) {
          const blobRef = blobCids[i]!;
          const cid = blobRef.ref.$link;
          const blobUrl = pds.getBlobUrl(senderPdsUrl, msg.fromDid, cid);
          const response = await fetch(blobUrl);
          if (!response.ok) {
            throw new Error(`downloadFile: blob fetch failed ${response.status}`);
          }

          const reader = response.body?.getReader();
          let encryptedBlob: Uint8Array;
          if (reader) {
            const pieces: Uint8Array[] = [];
            let received = 0;
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              if (!value) continue;
              pieces.push(value);
              received += value.byteLength;
              const progress = Math.min(99, Math.round(((downloadedBytes + received) / totalBlobBytes) * 100));
              if (progress !== lastProgress) {
                lastProgress = progress;
                await storage.updateFileMessageMeta(conversationId, msgId, { downloadProgress: progress });
                setChatListVersion((v) => v + 1);
              }
            }
            const totalLen = pieces.reduce((s, c) => s + c.byteLength, 0);
            encryptedBlob = new Uint8Array(totalLen);
            let off = 0;
            for (const p of pieces) { encryptedBlob.set(p, off); off += p.byteLength; }
            downloadedBytes += totalLen;
          } else {
            encryptedBlob = new Uint8Array(await response.arrayBuffer());
            downloadedBytes += encryptedBlob.byteLength;
            const progress = Math.min(99, Math.round((downloadedBytes / totalBlobBytes) * 100));
            if (progress !== lastProgress) {
              lastProgress = progress;
              await storage.updateFileMessageMeta(conversationId, msgId, { downloadProgress: progress });
              setChatListVersion((v) => v + 1);
            }
          }

          const decrypted = await decryptChunk(encryptedBlob, fileKey, fileId, i);
          decryptedChunks.push(decrypted);
        }

        const totalLength = decryptedChunks.reduce((sum, chunk) => sum + chunk.length, 0);
        const fullData = new Uint8Array(totalLength);
        let offset = 0;
        for (const chunk of decryptedChunks) {
          fullData.set(chunk, offset);
          offset += chunk.length;
        }

        const computedHash = computeSha256(fullData);
        if (computedHash !== fileMeta.sha256) {
          throw new Error('downloadFile: SHA-256 mismatch');
        }

        const fileName = fileMeta.fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
        let localPath: string;
        if (Platform.OS === 'web') {
          await cacheFile(fileMeta.fileId, fullData, fileMeta.mimeType);
          localPath = makeIndexedDbUri(fileMeta.fileId);
        } else {
          localPath = `${FileSystem.documentDirectory}${msgId}_${fileName}`;
          const base64Data = bytesToBase64(fullData);
          await FileSystem.writeAsStringAsync(localPath, base64Data, {
            encoding: FileSystem.EncodingType.Base64,
          });
        }

        let thumbnailPath: string | undefined;
        if (fileMeta.mimeType.startsWith('video/')) {
          const thumb = await generateVideoThumbnail({
            sourceUri: localPath,
            mimeType: fileMeta.mimeType,
            thumbKey: fileMeta.fileId,
          });
          thumbnailPath = thumb ?? undefined;
        }

        await storage.updateFileMessageMeta(conversationId, msgId, {
          localPath,
          downloadStatus: 'ready',
          downloadProgress: undefined,
          thumbnailPath,
        });
        setChatListVersion((v) => v + 1);
        return;

      } catch (err) {
        lastError = err;
        if (attempts >= maxAttempts) {
          await storage.updateFileMessageMeta(conversationId, msgId, {
            downloadStatus: 'failed',
            downloadProgress: undefined,
          });
          setChatListVersion((v) => v + 1);
          if (lastError instanceof Error) {
            throw lastError;
          }
          throw new Error('downloadFile: unknown error');
        }
        console.error('downloadFile attempt failed:', err);
        await new Promise((resolve) => setTimeout(resolve, retryDelays[attempts - 1]));
      }
    }
  }, [storage, pds]);

  // -------------------------------------------------------------------------
  // Incoming message handler (group message parsing)
  // -------------------------------------------------------------------------

  const handleIncomingMessage = useCallback(async (
    msg: IncomingMessage,
    userDid: string,
    msgStorage: DmeStorage,
  ): Promise<void> => {
    const isBlocked = (await msgStorage.getBlockList()).includes(msg.senderDid);
    if (isBlocked) {
      console.log('handleIncomingMessage: skipping message from blocked sender', msg.senderDid);
      return;
    }

    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = JSON.parse(msg.plaintext) as Record<string, unknown>;
    } catch {
    }

    const msgType = parsed?.['type'] as string | undefined;

    if (msgType && msgType.startsWith('group_')) {
      switch (msgType) {
        case 'group_invite_request': {
          const req = parsed as unknown as GroupInviteRequest;
          // 2026-10-15 真根因：poller 244 行的 own-leaf skip 是 `gen < expected`，
          // 仅能挡"自己叶子下 gen 已过期"（多端轮换 commit 重投递场景），**挡不住
          // `gen > expected`**——典型 = 备份恢复后本机 mls session 的 expectedGen
          // 落后于 PDS 上同叶子更高 gen 的 envelope（这是正常的「自己刚发出去
          // 还没消费」语义）。多端 / 跨设备登录 / 恢复备份 场景下 fatesky 通过
          // 1v1 fatesky-东兴 session 发出的 group_invite_request 落进 fatesky
          // 自己的 leaf，PDS 保留 7 天；备份恢复到 expectedGen 更老的 session 时
          // `gen (N+1) < expected (N)` = false，**不 skip，照常解密 + onMessage**
          // → handleIncomingMessage → 旧实现 `inviterDid: msg.senderDid ===
          // userDid` + `inviteeDid: userDid` 写入「自邀请自」PendingInvite。
          // 群聊邀请走 1v1 1 个发送方 + 1 个接收方，1v1 ownLeaf 下的 envelope
          // 语义上永远是**自己发出去的 application message**（commit 走群 session，
          // 不走 1v1）——「收到的群邀请」是别人发给自己的，**不可能出自自己叶子**。
          // 注：group_commit 走群 session 自己的 leaf（轮换 commit wrapper），不在
          // 1v1 路径——本分支仅限 1v1 application 消息，不影响 commit 应用。
          // 陈旧重放防线：恢复旧备份会把会话代际游标拨回，7 天 TTL 内的
          // 信封会被重新拉取。若该群会话已存在（已在群中），忽略重放的
          // 邀请请求，避免邀请卡片复活、被再次接受时向群主重复 accept
          if (await msgStorage.getMlsSession(req.groupId)) {
            console.log('handleIncomingMessage: ignoring stale group_invite_request (already in group)', req.groupId);
            break;
          }
          if (msg.senderDid === userDid) {
            // 2026-10-16 own-leaf 镜像收敛：同账号多端下，兄弟端轮询到本账号
            // 发出的 invite_request（1v1 对端 = 受邀人），此前一刀切拒收导致
            // 兄弟端既无 pending 记录也无「你邀请了…」系统消息——多端邀请状态
            // 永不同步（实测：iOS web 发邀请，Android web 卡片/消息全缺失）。
            // 重建镜像记录：inviterDid=本机、inviteeDid=1v1 对端（msg.groupId），
            // 以 inviteId 幂等去重；后续 accept_response 经对端叶子广播，
            // 兄弟端凭此记录即可对上号并接力建群（宣言门禁防双 commit）。
            if (await msgStorage.getPendingInvite(req.inviteId)) {
              console.log(
                'handleIncomingMessage: duplicate own-leaf group_invite_request mirror, skipping',
                req.inviteId, req.groupId,
              );
              break;
            }
            const mirrorStatus: PendingInvite['status'] =
              (await msgStorage.getGroupInfo(req.groupId)) ? 'cancelled' : 'pending';
            const mirrorInvite: PendingInvite = {
              inviteId: req.inviteId,
              groupId: req.groupId,
              groupName: req.groupName,
              inviterDid: userDid,
              inviteeDid: msg.groupId,
              status: mirrorStatus,
              createdAt: msg.envelope.createdAt,
            };
            await msgStorage.putPendingInvite(mirrorInvite);
            setPendingInvites((prev) => [...prev, mirrorInvite]);

            const inviteeHandle = await resolveHandleCached(msg.groupId);
            await msgStorage.putMessage({
              id: `sys_invite_${req.inviteId}`,
              fromDid: userDid,
              toDid: msg.groupId,
              plaintext: t(language, 'group.youInvited', { handle: inviteeHandle, group: req.groupName }),
              createdAt: msg.envelope.createdAt,
              sent: true,
              kind: 'group_system',
            });
            setChatListVersion((v) => v + 1);
            console.log(
              'handleIncomingMessage: own-leaf group_invite_request mirror reconstructed',
              req.inviteId, req.groupId,
            );
            break;
          }
          // 幂等 + 保状态：response 先到时已落最终状态记录（见 response 分支），
          // 此处不得覆盖为 pending
          const priorInvite = await msgStorage.getPendingInvite(req.inviteId);
          if (priorInvite && priorInvite.status !== 'pending') {
            console.log('handleIncomingMessage: group_invite_request after response, keeping final state', req.inviteId, priorInvite.status);
            break;
          }
          // 2026-10-16 权威收敛：重放重建 pending 前，若该群 GroupInfo 已存在
          // （群已建成，随备份/ metadata 重放而来），邀请必然已终结——群主自己
          // 建的群（sender=本机，走上方镜像分支）在此收敛为 cancelled；受邀人
          // 侧收敛为 accepted（曾响应过，别再亮接受按钮）。
          const existingGroup = await msgStorage.getGroupInfo(req.groupId);
          const finalStatus: PendingInvite['status'] | null = existingGroup
            ? (msg.senderDid === userDid ? 'cancelled' : 'accepted')
            : null;
          const invite: PendingInvite = {
            inviteId: req.inviteId,
            groupId: req.groupId,
            groupName: req.groupName,
            inviterDid: msg.senderDid,
            inviteeDid: userDid,
            status: finalStatus ?? 'pending',
            createdAt: msg.envelope.createdAt,
          };
          await msgStorage.putPendingInvite(invite);
          setReceivedGroupInvites((prev) => [...prev, invite]);

          await msgStorage.putMessage({
            id: msg.envelope.queueId,
            fromDid: msg.senderDid,
            toDid: userDid,
            plaintext: msg.plaintext,
            createdAt: msg.envelope.createdAt,
            sent: false,
            kind: 'group_invite',
          });
          const shouldPlay = soundEnabled && (activeConversationRef.current === null || activeConversationRef.current === msg.groupId);
          if (shouldPlay) {
            void playMessageSound();
          }
          break;
        }
        case 'group_invite_response': {
          const resp = parsed as unknown as GroupInviteResponse;
          // 重放去重：同一条响应重复投递只处理一次（存储桶与 putMessage
          // 的默认归属一致：发送者 1v1 会话，保持系统消息原显示位置）
          const respBucket = msg.senderDid === userDid ? userDid : msg.senderDid;
          if (await msgStorage.hasMessage(respBucket, msg.envelope.queueId)) {
            console.log('handleIncomingMessage: duplicate group_invite_response, skipping', msg.envelope.queueId);
            break;
          }
          const existing = await msgStorage.getPendingInvite(resp.inviteId);
          if (!existing) {
            // 2026-10-16 恢复备份重放顺序修复：response 可能先于 request 被
            // 处理（清缓存后 PDS 重拉不保证顺序）。此前此处只写系统消息，
            // 随后 request 到达会把已拒绝/已接受的邀请按 pending 重建——
            // 卡片复活（实测：双端恢复备份后被拒邀请重新出现待处理卡片）。
            // 先落一条带最终状态的记录，request 后到时被 inviteId 幂等挡住，
            // 不会重置为 pending。inviter/invitee 从 1v1 槽位推断：响应发自
            // 受邀人叶子——本机发出 = 本机是受邀人；收到 = 对端是受邀人。
            const reconstructed: PendingInvite = {
              inviteId: resp.inviteId,
              groupId: resp.groupId,
              groupName: '',
              inviterDid: msg.senderDid === userDid ? msg.groupId : msg.senderDid,
              inviteeDid: msg.senderDid === userDid ? userDid : msg.groupId,
              status: resp.accepted ? 'accepted' : 'rejected',
              createdAt: msg.envelope.createdAt,
            };
            await msgStorage.putPendingInvite(reconstructed);
            // 只落库，不进 pendingInvites UI state——建群卡片按 inviterDid===本机
            // 渲染「我发出的邀请」，受邀方向记录混进去会伪造建群卡片
            console.log('handleIncomingMessage: group_invite_response before request, recorded final state', resp.inviteId, resp.accepted);
          }
          if (existing) {
            // 「恢复备份后重放自己过去的接受确认」的精确判定：响应发送者是
            // 本机用户 + 邀请记录里受邀人就是本机用户 + 本机无 KP pair。
            // 2026-10-15 实测踩坑：旧条件只看本机有无 pair，误伤了群主——
            // 群主发出去的邀请记录本来就没有 pair（pair 只在受邀方的记录里），
            // 群主收到受邀人的接受响应被误判为重放、邀请永远 pending，
            // 会话列表「0 接受」且 keyPackageSerialized 落不了库、无法建群。
            const ownReplayWithoutPair =
              msg.senderDid === userDid &&
              existing.inviteeDid === userDid &&
              !(existing.ownKeyPackagePoolId || existing.ownKeyPackagePairSerialized);
            // 2026-10-20 状态机护栏：响应只允许把 pending 推向终态。cancelled
            // 是终态——群主兄弟端已凭 group_metadata_update 收敛（兄弟端建群
            // 成功，见 metadata 分支 2026-10-16 收敛），迟到的 accept_response
            // 不得把建群卡片复活成 accepted（实测：a 端点创建后，b 端因 1v1
            // 对端叶子代际落后、accept_response 晚于 metadata 解密处理，复活
            // 卡片显示「添加/取消」；c 端响应先于 metadata 处理则一切正常）。
            // rejected/accepted 同为终态，重复响应幂等跳过。ownReplayWithoutPair
            // 例外保留：其记录恒为受邀方向（inviteeDid===本机），与 inviter
            // 方向的 cancelled 天然不相交，不受此护栏影响。
            if (existing.status !== 'pending' && !ownReplayWithoutPair) {
              console.log(
                'handleIncomingMessage: group_invite_response on final-state record, keeping',
                resp.inviteId, existing.status,
              );
            } else {
              let updated: PendingInvite;
              if (!resp.accepted) {
                updated = { ...existing, status: 'rejected' };
              } else if (ownReplayWithoutPair) {
                // 本机是受邀方但无 pair（恢复备份后重放「过去某个自己」的确认，
                // 或多端另一台设备接受的）：welcome 对本机数学上解不开（KP 私钥
                // 不在本机）。把状态收敛为 accepted，避免会话列表/私聊卡片永远
                // pending；同时标记 issue，引导用户从其他设备的最新备份恢复。
                updated = { ...existing, status: 'accepted' };
                await msgStorage.setSessionIssue(existing.groupId, 'sibling-rotated');
                setChatListVersion((v) => v + 1);
              } else {
                // 接受响应如实记账：① 群主收到受邀人的接受（inviteeDid ≠ 本机，
                // 建群前置状态；keyPackageSerialized 是 createGroupFromPendingInvites
                // 的必要输入）；② 受邀方自己的确认镜像（有 pair），与
                // respondToGroupInvite 的本地收敛一致
                updated = { ...existing, status: 'accepted', keyPackageSerialized: resp.keyPackageSerialized };
              }
              await msgStorage.putPendingInvite(updated);
              setPendingInvites((prev) =>
                prev.map((i) => i.inviteId === resp.inviteId ? updated : i),
              );
              setReceivedGroupInvites((prev) =>
                prev.map((i) => (i.inviteId === resp.inviteId ? updated : i)),
              );
            }
          }
          const senderHandle = await resolveHandleCached(msg.senderDid);
          await msgStorage.putMessage({
            id: msg.envelope.queueId,
            fromDid: msg.senderDid,
            toDid: userDid,
            plaintext: resp.accepted
              ? t(language, 'group.invite.accepted', { handle: senderHandle })
              : t(language, 'group.invite.rejected', { handle: senderHandle }),
            createdAt: msg.envelope.createdAt,
            sent: false,
            kind: 'group_system',
          });
          break;
        }
        case 'group_welcome': {
          const welcome = parsed as unknown as GroupWelcome;

          // 陈旧重放防线：同一条 welcome 已处理过（消息已入库）则整体跳过。
          // joinViaWelcome 消耗 KP pair 具有一次性，重复执行只会抛错，
          // 且恢复旧备份后游标拨回会导致 welcome 被重新拉取
          if (await msgStorage.hasMessage(welcome.groupId, msg.envelope.queueId)) {
            console.log('handleIncomingMessage: duplicate group_welcome, skipping', msg.envelope.queueId);
            break;
          }

          // join 是否真正成功——只有成功才允许插「已入群」消息与群元数据。
          // 2026-10-14 实测踩坑：joinViaWelcome 抛错（KP 已被消耗 / welcome
          // 与 pair 不匹配）后 catch 只打日志，代码继续往下插「你已加入
          // 群聊」并 putGroupInfo 覆盖群元数据——本机有残留旧会话时旧防线
          // 只挡僵尸条目，挡不住假入群消息误导用户（点接受后无法聊天的直接原因）
          let joined = false;

          if (identityKeys && poller) {
            try {
              const allInvites = await msgStorage.getPendingInvites();
              const matchingInvites = allInvites.filter(
                (i) =>
                  i.groupId === welcome.groupId &&
                  i.inviteeDid === userDid &&
                  (i.ownKeyPackagePoolId || i.ownKeyPackagePairSerialized),
              );
              const ownInvite = matchingInvites.length > 0
                ? matchingInvites[matchingInvites.length - 1]
                : null;

              if (ownInvite && (ownInvite.ownKeyPackagePoolId || ownInvite.ownKeyPackagePairSerialized)) {
                // 取 KP pair：优先池条目（池化路径，池随备份走）；回退旧格式
                // pair 本体序列化（池化前的历史邀请记录）
                let pair: { publicPackage: KeyPackage; privatePackage: PrivateKeyPackage } | null = null;
                if (ownInvite.ownKeyPackagePoolId) {
                  const entry = (await msgStorage.getKeyPackagePool()).find(
                    (e) => e.id === ownInvite.ownKeyPackagePoolId && !e.consumed,
                  );
                  if (entry) {
                    pair = {
                      publicPackage: deserializeWithUint8Array<KeyPackage>(entry.publicPackageSerialized),
                      privatePackage: deserializeWithUint8Array<PrivateKeyPackage>(entry.privatePackageSerialized),
                    };
                  }
                } else if (ownInvite.ownKeyPackagePairSerialized) {
                  const { deserializeOwnKeyPackagePair } = await import('../handshake/group-invite');
                  pair = deserializeOwnKeyPackagePair(ownInvite.ownKeyPackagePairSerialized);
                }
                if (!pair) throw new Error('key package pair unavailable (consumed or missing from pool)');

                const { decodeMlsMessage } = await import('ts-mls');
                const { MlsSession } = await import('../crypto/mls-session');
                const impl = await getNobleMlsImpl();
                const welcomeBytes = base64urlToBytes(welcome.welcomePayload);
                const decoded = decodeMlsMessage(welcomeBytes, 0);
                if (!decoded) throw new Error('failed to decode welcome');
                const msg = decoded[0]!;
                if (msg.wireformat !== 'mls_welcome') {
                  throw new Error(`expected mls_welcome, got ${msg.wireformat}`);
                }
                const mlsWelcome = msg.welcome;

                const newSession = await MlsSession.joinViaWelcome(
                  mlsWelcome,
                  pair,
                  impl,
                );

                await msgStorage.putMlsSession(welcome.groupId, newSession.serialize());
                poller.addSession(welcome.groupId, newSession);
                joined = true;
                // KP 一次性：join 成功才标记池条目 consumed（welcome 未到达时
                // pair 保持未消费，随备份供恢复端 join——池化闭环的关键）
                if (ownInvite.ownKeyPackagePoolId) {
                  await msgStorage.markKeyPackageConsumed(ownInvite.ownKeyPackagePoolId);
                }
                // 备份点：新群会话建立，必须立即联动备份（其他端恢复后才有此群）
                await triggerBackupAfterAdvance(`joinGroupViaWelcome ${welcome.groupId}`);
                // 刚经 Welcome 真正入群：立刻收敛该群残留的 pending 邀请。
                // 重放的邀请信封可能在入群之后才到达（信封按代际游标重放），
                // 若不在这里收敛，邀请卡片会活到下次重启才被 reconcile 清掉
                for (const inv of await msgStorage.getPendingInvites()) {
                  if (inv.status === 'pending' && inv.groupId === welcome.groupId) {
                    await msgStorage.updatePendingInviteStatus(inv.inviteId, 'accepted');
                  }
                }
                setReceivedGroupInvites((prev) =>
                  prev.map((i) =>
                    i.status === 'pending' && i.groupId === welcome.groupId
                      ? { ...i, status: 'accepted' }
                      : i,
                  ),
                );
                // Keep invite in storage (status stays 'accepted'): the group_invite message
                // persists in the 1:1 conversation, so receivedGroupInvites must survive
                // restart to keep the card showing "Responded" instead of Accept/Decline.
              } else {
                // 本机没有该群的 KP pair（邀请记录丢失 / 恢复场景）：
                // 无法经 KeyPackage 加入，绝不能插「你已加入群聊」
                console.log(
                  'handleIncomingMessage: ignoring group_welcome without local key package pair',
                  welcome.groupId,
                );
              }
            } catch (err) {
              // join 失败：会话未建立，绝不插假入群消息、绝不覆盖 GroupInfo
              console.error('handleIncomingMessage: failed to join group via welcome:', err);
            }
          }

          // 统一出口：join 未成功一律忽略插消息。KP pair 只在点「接受」时
          // 随邀请记录生成，而邀请记录不进备份——恢复/新端场景下 welcome
          // 虽然重放到达，但其加密对应的那把 KeyPackage 私钥已不存在，
          // 数学上永远解不开，插消息与群元数据只会产生僵尸群假条目。
          // 重新入群的唯一路径是重新接受（生成新 pair），因此把该群
          // 自己的邀请记录重置回 pending，让卡片重新出现「接受」按钮——
          // 否则用户看到「已接受」却永远进不了群，界面无任何解释
          // （实测踩坑：恢复后能收到邀请/自己确认/Bob 确认，唯独进不了群）
          if (!joined) {
            // 本机无法加入：保留已由 sibling 响应收敛为 accepted 的状态，避免
            // 把「需恢复备份」的提示又改回 pending。其他非 pending 状态（如旧
            // 中间态）重置回 pending，让卡片重新提供接受入口。
            for (const inv of await msgStorage.getPendingInvites()) {
              if (
                inv.groupId === welcome.groupId &&
                inv.inviteeDid === userDid &&
                inv.status !== 'pending' &&
                inv.status !== 'accepted'
              ) {
                await msgStorage.putPendingInvite({
                  ...inv,
                  status: 'pending',
                  keyPackageSerialized: undefined,
                  ownKeyPackagePairSerialized: undefined,
                  ownKeyPackagePoolId: undefined,
                });
              }
            }
            setReceivedGroupInvites((prev) =>
              prev.map((i) =>
                i.groupId === welcome.groupId && i.inviteeDid === userDid && i.status !== 'pending' && i.status !== 'accepted'
                  ? { ...i, status: 'pending' as const, keyPackageSerialized: undefined, ownKeyPackagePairSerialized: undefined }
                  : i,
              ),
            );
            setChatListVersion((v) => v + 1);
            break;
          }
          if (!(await msgStorage.getMlsSession(welcome.groupId))) {
            console.log(
              'handleIncomingMessage: ignoring stale group_welcome replay (no local session)',
              welcome.groupId,
            );
            break;
          }

          await msgStorage.putMessage({
            id: msg.envelope.queueId,
            fromDid: msg.senderDid,
            toDid: userDid,
            plaintext: t(language, 'group.joined', { group: welcome.groupName }),
            createdAt: msg.envelope.createdAt,
            sent: false,
            kind: 'group_system',
            conversationId: welcome.groupId,
          });

          const groupInfo: GroupInfo = {
            groupId: welcome.groupId,
            groupName: welcome.groupName,
            creatorDid: msg.senderDid,
            members: welcome.members,
            createdAt: msg.envelope.createdAt,
          };
          await msgStorage.putGroupInfo(groupInfo);
          setGroupInfos((prev) => prev.some((g) => g.groupId === welcome.groupId) ? prev : [...prev, groupInfo]);
          setGroups((prev) => prev.includes(welcome.groupId) ? prev : [...prev, welcome.groupId]);
          break;
        }
        case 'group_metadata_update': {
          const update = parsed as unknown as GroupMetadataUpdate;
          const existing = await msgStorage.getGroupInfo(update.groupId);
          // 2026-10-16 修复：改为「不存在就新建」。同账号兄弟端拿到群会话的路径
          // 是群 queueId 空间的 commit wrapper（group_commit 分支），该路径只
          // 应用 MLS 状态、不写 GroupInfo；而 group_welcome 只发给受邀人，兄弟端
          // 收不到。此前 `if (existing)` 门禁让兄弟端永远建不出 GroupInfo——
          // 会话列表出现该群但 groupInfoMap 查不到，落到 1:1 兜底分支用 groupId
          // 当显示名（实测：A 端建群「瞌睡」，B 端列表显示 mval8b8m2hklqzjj）。
          // metadata 自带 groupName + members，足以构造完整 GroupInfo。
          const creatorMember = update.members.find((m) => m.role === 'creator');
          const info: GroupInfo = existing
            ? { ...existing, members: update.members, groupName: update.groupName }
            : {
                groupId: update.groupId,
                groupName: update.groupName,
                creatorDid: creatorMember?.did ?? msg.senderDid,
                members: update.members,
                createdAt: msg.envelope.createdAt,
              };
          await msgStorage.putGroupInfo(info);
          setGroupInfos((prev) =>
            prev.some((g) => g.groupId === update.groupId)
              ? prev.map((g) => g.groupId === update.groupId ? info : g)
              : [...prev, info],
          );
          setGroups((prev) => prev.includes(update.groupId) ? prev : [...prev, update.groupId]);
          // 2026-10-16 收敛（双端）：本机是该群邀请人且收到该群 metadata =
          // 兄弟端已建群成功（welcome/metadata 只投给受邀者，群主兄弟端靠
          // 共享 1v1 会话状态重放解到）。此时本机的镜像 pending 邀请应就地
          // cancelled——不依赖 mlsSession（群主兄弟端结构性收不到 welcome、
          // 没有群 mlsSession，reconcileStaleGroupInvites 的会话判据永不触发）。
          // 后续真正的群 mlsSession 由恢复群主端备份获得。
          const mySentInvite = (await msgStorage.getPendingInvites()).find(
            (i) => i.groupId === update.groupId && i.inviterDid === userDid &&
              (i.status === 'pending' || i.status === 'accepted'),
          );
          if (mySentInvite) {
            await msgStorage.updatePendingInviteStatus(mySentInvite.inviteId, 'cancelled');
            setPendingInvites((prev) => prev.map((i) =>
              i.inviteId === mySentInvite.inviteId ? { ...i, status: 'cancelled' } : i,
            ));
          }
          await msgStorage.putMessage({
            id: msg.envelope.queueId,
            fromDid: msg.senderDid,
            toDid: userDid,
            plaintext: t(language, 'group.membersUpdated'),
            createdAt: msg.envelope.createdAt,
            sent: false,
            kind: 'group_system',
            conversationId: update.groupId,
          });
          setChatListVersion((v) => v + 1);
          break;
        }
        case 'group_commit': {
          const commit = parsed as unknown as { type: string; groupId: string; commitPayload: string };

          // 谱系账本补观测（P1，group-fork-plan.md 3.1）：poller 侧只观测群
          // 会话 ctx（归属护栏见 poller.ts），1v1 通道扇出的 commit 副本
          // （建群/退群清理）在这里按解析出的真实 groupId 补记。poller 已
          // 观测过的 group-space 信封在账本里是 duplicate，幂等无害。
          if (typeof msg.envelope.groupSeq === 'number') {
            try {
              const verdict = await msgStorage.observeGroupCommit(
                commit.groupId,
                msg.envelope.groupSeq,
                msg.envelope.queueId,
              );
              if (verdict === 'fork') {
                console.error(
                  '[dme:fork] commit lineage fork detected (AppContext):',
                  commit.groupId,
                  'seq',
                  msg.envelope.groupSeq,
                  'queueId',
                  msg.envelope.queueId,
                );
                await msgStorage.setSessionIssue(commit.groupId, 'forked');
              }
            } catch (err) {
              console.warn('[dme:fork] ledger observe (AppContext) failed:', err);
            }
          }

          if (poller) {
            const groupSession = poller.getSession(commit.groupId);
            if (groupSession) {
              try {
                const commitBytes = base64urlToBytes(commit.commitPayload);
                await groupSession.decrypt(commitBytes);
                await msgStorage.putMlsSession(commit.groupId, groupSession.serialize());
                if (msg.senderDid === userDid && identityKeys && pds) {
                  // 宣言 v2：兄弟端 commit 应用成功 → 异步追平账号 commit 高水位
                  // （best-effort）。正常在线端消费了兄弟的 wrapper 后状态一致，
                  // 若不追平，本端下次轮换时会发现 PDS seq > 本地 seq 而误判
                  // 落后（stale）。追平后 seq 与云端一致，不误报。
                  void (async () => {
                    try {
                      const params = await deriveRotationClaimParams(identityKeys.signing.publicKey);
                      const remote = await peekCommitSeq(params, claimStore!);
                      if (remote !== null) {
                        const local = await msgStorage.getCommitSeq();
                        if (remote > local) await msgStorage.setCommitSeq(remote);
                      }
                    } catch {
                      // best-effort：追平失败不影响本次 commit 应用
                    }
                  })();
                }
              } catch (err) {
                console.error('handleIncomingMessage: failed to process group commit:', err);
                if (msg.senderDid === userDid) {
                  // 同账号兄弟设备产生了本机无法应用的 commit（密钥轮换/多端推进）：
                  // 本机旧状态推不出新 epoch（新熵不在任何寄给本叶的密文里），无法自行追赶，
                  // 唯一恢复路径是恢复最新备份（key-rotation-plan.md 1.6 / 1.4）
                  await msgStorage.setSessionIssue(commit.groupId, 'sibling-rotated');
                  console.warn('[dme:rotation] sibling device advanced session', commit.groupId, '- backup restore required');
                } else {
                  // 普通成员的 commit 应用失败：会话已脱钩，需要重新握手（1.4 desync 兜底）。
                  // 记录发送者 DID 供横幅「oo」展示（2026-10-20 文案改版）
                  await msgStorage.setSessionIssue(commit.groupId, 'desynced', msg.senderDid);
                  console.warn('[dme:desync] commit from', msg.senderDid, 'failed to apply on session', commit.groupId);
                }
              }
            }
          }
          break;
        }
        case 'group_fork_ruling': {
          // 群主拍板裁定（P2，group-fork-plan.md 3.3/3.4）：只有权威世界
          // （群主本机所在谱系）能解开此消息——非权威世界解不开，天然走不到
          // 本分支，维持 forked 横幅走恢复备份路径。
          const ruling = parsed as unknown as GroupForkRuling;
          if (ruling.groupId && ruling.groupId !== '') {
            const rulingInfo = await msgStorage.getGroupInfo(ruling.groupId);
            // 防伪：仅群主可发裁定（MLS 发送者认证 + creatorDid 比对）
            if (!rulingInfo || rulingInfo.creatorDid !== msg.senderDid) {
              console.warn(
                '[dme:fork] ignoring fork ruling: sender is not group creator',
                ruling.groupId,
                msg.senderDid,
              );
              break;
            }
            // 幂等：仅当本机带 forked 标记时收敛（不清 sibling-rotated /
            // desynced——那些标记语义不同）
            if ((await msgStorage.getSessionIssue(ruling.groupId)) === 'forked') {
              console.log('[dme:fork] fork ruling received, clearing forked flag', ruling.groupId);
              await msgStorage.setSessionIssue(ruling.groupId, null);
              await msgStorage.putMessage({
                id: msg.envelope.queueId,
                fromDid: msg.senderDid,
                toDid: userDid,
                plaintext: t(language, 'group.forkRulingApplied'),
                createdAt: msg.envelope.createdAt,
                sent: false,
                kind: 'group_system',
                conversationId: ruling.groupId,
              });
              setChatListVersion((v) => v + 1);
            }
            // 备份联动（约定：备份点原则）——权威世界成员收到裁定后刷新
            // 备份，让非权威兄弟端后续可恢复到权威谱系；无缓存密码时置
            // backupRequired 强提示（triggerBackupAfterAdvance 内部分流）
            await triggerBackupAfterAdvance(`fork ruling received ${ruling.groupId}`);
          }
          break;
        }
        case 'group_dissolved': {
          const dissolved = parsed as unknown as GroupDissolved;

          // 陈旧重放防线：同一条 dissolved 已处理过（消息已入库）则跳过，
          // 避免恢复备份后重复插「群已解散」系统消息
          if (await msgStorage.hasMessage(dissolved.groupId, msg.envelope.queueId)) {
            console.log('handleIncomingMessage: duplicate group_dissolved, skipping', msg.envelope.queueId);
            break;
          }
          const dissolvedExisting = await msgStorage.getGroupInfo(dissolved.groupId);
          // 幂等：已标记解散的不重复处理
          if (dissolvedExisting?.dissolved) {
            console.log('handleIncomingMessage: already marked dissolved, skipping', dissolved.groupId);
            break;
          }

          if (poller) {
            poller.removeSession(dissolved.groupId);
          }
          await msgStorage.deleteMlsSession(dissolved.groupId);

          if (dissolvedExisting) {
            const dissolvedInfo: GroupInfo = { ...dissolvedExisting, dissolved: true };
            await msgStorage.putGroupInfo(dissolvedInfo);
            setGroupInfos((prev) => prev.map((g) => g.groupId === dissolved.groupId ? dissolvedInfo : g));
          }

          await msgStorage.putMessage({
            id: msg.envelope.queueId,
            fromDid: msg.senderDid,
            toDid: userDid,
            plaintext: t(language, 'group.dissolved', { group: dissolved.groupName }),
            createdAt: msg.envelope.createdAt,
            sent: false,
            kind: 'group_system',
            conversationId: dissolved.groupId,
          });
          break;
        }
        case 'group_member_removed': {
          const removed = parsed as unknown as GroupMemberRemoved;

          // 陈旧重放防线（2026-10-14 实测踩坑）：恢复旧备份会把 1v1 代际
          // 游标拨回，7 天 TTL 内真实发生过的 removed 信封会被重新投递。
          // 无差别处理会重复插「你已被移出群聊」系统消息，更严重的是会
          // 删掉本机刚经 group_welcome 重新入群新建的会话（用户实测：
          // 点接受后无法聊天 + 惊现「你已被移出群聊：666」）。
          //
          // 防线 1：定向校验——新版消息带 memberDid，只处理发给自己的；
          // 旧版消息无该字段（协议只单发给被踢者），宽松放行
          if (removed.memberDid && removed.memberDid !== userDid) {
            console.log('handleIncomingMessage: ignoring removed notice for other member', removed.memberDid);
            break;
          }
          // 防线 2：queueId 去重——同一条 removed 重复到达只处理一次
          if (await msgStorage.hasMessage(removed.groupId, msg.envelope.queueId)) {
            console.log('handleIncomingMessage: duplicate group_member_removed, skipping', msg.envelope.queueId);
            break;
          }
          const removedExisting = await msgStorage.getGroupInfo(removed.groupId);
          // 防线 3：新鲜度——本机群元数据比这条 removed 信封更新，说明
          // 用户在「被踢」之后重新入群过（新 welcome 的 createdAt 必然晚于
          // 旧 removed），这是重放的陈旧通知，绝不能删新会话
          if (
            removedExisting &&
            !removedExisting.removed &&
            new Date(removedExisting.createdAt).getTime() > new Date(msg.envelope.createdAt).getTime()
          ) {
            console.log(
              'handleIncomingMessage: ignoring stale group_member_removed (re-joined after removal)',
              removed.groupId,
            );
            break;
          }
          // 防线 4：幂等——已处理过的 removed（备份带回标记）不重复插消息
          if (removedExisting?.removed) {
            console.log('handleIncomingMessage: already marked removed, skipping', removed.groupId);
            break;
          }

          if (poller) {
            poller.removeSession(removed.groupId);
          }
          await msgStorage.deleteMlsSession(removed.groupId);

          if (removedExisting) {
            const removedInfo: GroupInfo = { ...removedExisting, removed: true };
            await msgStorage.putGroupInfo(removedInfo);
            setGroupInfos((prev) => prev.map((g) => g.groupId === removed.groupId ? removedInfo : g));
          }

          await msgStorage.putMessage({
            id: msg.envelope.queueId,
            fromDid: msg.senderDid,
            toDid: userDid,
            plaintext: t(language, 'group.removed', { group: removed.groupName }),
            createdAt: msg.envelope.createdAt,
            sent: false,
            kind: 'group_system',
            conversationId: removed.groupId,
          });
          break;
        }
        case 'group_member_left': {
          const left = parsed as unknown as GroupMemberLeft;

          const existing = await msgStorage.getGroupInfo(left.groupId);
          if (!existing) break;

          const isCreator = existing.creatorDid === userDid;

          if (isCreator && poller && pds) {
            const groupSession = poller.getSession(left.groupId);
            if (groupSession) {
              try {
                const leafIndex = groupSession.getMemberDids().indexOf(left.memberDid);
                if (leafIndex >= 0) {
                  // 宣言门禁（约定7）：群主执行退群清理 commit 前必须先宣言；
                  // taken/stale 已置 sibling-rotated 提示恢复备份，fail-closed 静默放弃
                  const claimSeq = await acquireClaimForCommit(left.groupId, groupSession.getEpoch());
                  if (claimSeq === null) break;
                  try {
                    const { commitMessage } = await groupSession.removeMember(leafIndex);
                    await msgStorage.putMlsSession(left.groupId, groupSession.serialize());
                    await msgStorage.setCommitSeq(claimSeq);
                    // 备份点：群主执行退群清理 commit，群会话状态推进，
                    // 立即联动备份（其他端恢复后才有含此次移除的新状态）
                    await triggerBackupAfterAdvance(`removeLeavingMember ${left.groupId}`);

                    // 谱系账本（group-fork-plan.md 3.1）：1v1 扇出的同一逻辑
                    // commit 共享同一 seq；每份副本 queueId 不同，逐份追加
                    const seqMeta = await msgStorage.reserveGroupCommit(left.groupId);

                    const commitMsg = {
                      type: 'group_commit' as const,
                      groupId: left.groupId,
                      commitPayload: bytesToBase64url(commitMessage),
                    };

                    for (const member of existing.members) {
                      if (member.did === userDid || member.did === left.memberDid) continue;
                      const memberSession = poller.getSession(member.did);
                      if (!memberSession) continue;

                      const plaintextBytes = new TextEncoder().encode(JSON.stringify(commitMsg));
                      const encResult = await memberSession.encrypt(plaintextBytes);
                      await msgStorage.putMlsSession(member.did, memberSession.serialize());

                      const envelope: DmeEnvelope = {
                        $type: 'dme.queue.envelope',
                        queueId: encResult.queueId,
                        payload: bytesToBase64url(encResult.ciphertext),
                        createdAt: new Date().toISOString(),
                        messageType: 'application',
                        groupSeq: seqMeta.seq,
                        ...(seqMeta.parentQueueId ? { parentQueueId: seqMeta.parentQueueId } : {}),
                      };
                      await pds.createEnvelope(envelope);
                      await msgStorage.appendGroupCommitQueueId(
                        left.groupId,
                        seqMeta.seq,
                        encResult.queueId,
                      );
                    }
                  } catch (err) {
                    // commit/投递失败：释放宣言避免虚高水位；本周期放弃，
                    // 信封重放时下次处理自然重试
                    await releaseClaim();
                    throw err;
                  }
                }
              } catch (err) {
                console.error('handleIncomingMessage: failed to remove leaving member:', err);
              }
            }
          }

          const updatedMembers = existing.members.filter((m) => m.did !== left.memberDid);
          const updatedInfo: GroupInfo = { ...existing, members: updatedMembers };
          await msgStorage.putGroupInfo(updatedInfo);
          setGroupInfos((prev) => prev.map((g) => g.groupId === left.groupId ? updatedInfo : g));

          const senderHandle = await resolveHandleCached(left.memberDid);
          await msgStorage.putMessage({
            id: msg.envelope.queueId,
            fromDid: msg.senderDid,
            toDid: userDid,
            plaintext: t(language, 'group.memberLeft', { handle: senderHandle }),
            createdAt: msg.envelope.createdAt,
            sent: false,
            kind: 'group_system',
            conversationId: left.groupId,
          });
          break;
        }
        default:
          if (await msgStorage.hasMessage(msg.groupId, msg.envelope.queueId)) {
            console.log('handleIncomingMessage: duplicate group text message, skipping', msg.envelope.queueId);
            break;
          }
          await msgStorage.putMessage({
            id: msg.envelope.queueId,
            fromDid: msg.senderDid,
            toDid: userDid,
            plaintext: msg.plaintext,
            createdAt: msg.envelope.createdAt,
            sent: msg.senderDid === userDid,
            kind: 'text',
            conversationId: msg.groupId,
          });
          const shouldPlay = soundEnabled && (activeConversationRef.current === null || activeConversationRef.current === msg.groupId);
          if (shouldPlay) {
            void playMessageSound();
          }
      }
    } else if (msgType === 'reaction') {
      const r = parsed as unknown as ReactionMessage;
      const reaction = {
        emoji: r.emoji,
        did: msg.senderDid,
        createdAt: r.createdAt || msg.envelope.createdAt,
      };
      if (r.action === 'add') {
        await msgStorage.addReaction(msg.groupId, r.targetMessageId, reaction);
      } else {
        await msgStorage.removeReaction(msg.groupId, r.targetMessageId, msg.senderDid, r.emoji);
      }
    } else if (msgType === FILE_MANIFEST_TYPE) {
      if (await msgStorage.hasMessage(msg.groupId, msg.envelope.queueId)) {
        console.log('handleIncomingMessage: duplicate file message, skipping', msg.envelope.queueId);
        return;
      }
      const manifest = JSON.parse(msg.plaintext) as FileManifestMessage;
      await msgStorage.putMessage({
        id: msg.envelope.queueId,
        fromDid: msg.senderDid,
        toDid: userDid,
        plaintext: msg.plaintext,
         fileMeta: {
           fileId: manifest.fileId,
           fileName: manifest.fileName,
           fileSize: manifest.fileSize,
           mimeType: manifest.mimeType,
           sha256: manifest.sha256,
           chunkCount: manifest.chunkCount,
           chunkSize: manifest.chunkSize,
           fileKey: manifest.fileKey,
           blobCids: msg.envelope.blobCids,
           downloadStatus: 'pending',
         },
        kind: 'file',
        createdAt: msg.envelope.createdAt,
        sent: msg.senderDid === userDid,
        conversationId: msg.groupId,
      });

      if (manifest.mimeType.startsWith('image/') && manifest.fileSize <= 5 * 1024 * 1024) {
        void downloadFile(msg.groupId, msg.envelope.queueId).catch((err: unknown) => {
          console.error('Auto-download failed:', err);
        });
      }

const shouldPlayFile = soundEnabled && (activeConversationRef.current === null || activeConversationRef.current === msg.groupId);
          if (shouldPlayFile) {
        void playMessageSound();
      }
    } else if (msgType === POST_MESSAGE_TYPE) {
      if (await msgStorage.hasMessage(msg.groupId, msg.envelope.queueId)) {
        console.log('handleIncomingMessage: duplicate post message, skipping', msg.envelope.queueId);
        return;
      }
      await msgStorage.putMessage({
        id: msg.envelope.queueId,
        fromDid: msg.senderDid,
        toDid: userDid,
        plaintext: msg.plaintext,
        createdAt: msg.envelope.createdAt,
        sent: msg.senderDid === userDid,
        kind: 'post',
        conversationId: msg.groupId,
      });
      const shouldPlayPost = soundEnabled && (activeConversationRef.current === null || activeConversationRef.current === msg.groupId);
      if (shouldPlayPost) {
        void playMessageSound();
      }
    } else {
      if (await msgStorage.hasMessage(msg.groupId, msg.envelope.queueId)) {
        console.log('handleIncomingMessage: duplicate text message, skipping', msg.envelope.queueId);
        return;
      }
          await msgStorage.putMessage({
            id: msg.envelope.queueId,
            fromDid: msg.senderDid,
            toDid: userDid,
            plaintext: msg.plaintext,
            createdAt: msg.envelope.createdAt,
            sent: msg.senderDid === userDid,
            kind: 'text',
            conversationId: msg.groupId,
          });
          const shouldPlayText = soundEnabled && (activeConversationRef.current === null || activeConversationRef.current === msg.groupId);
      if (shouldPlayText) {
        void playMessageSound();
      }
    }

    // In embed mode, mark the message as read only when the parent frame
    // reports the user is actively viewing the chat route, the current DME
    // screen is this exact conversation, and the browser tab is visible.
    console.log('[DME embed] markRead check', {
      isEmbed: isEmbedContext(),
      chatActive: chatActiveRef.current,
      activeConversation: activeConversationRef.current,
      msgGroup: msg.groupId,
      visibility: typeof document !== 'undefined' ? document.visibilityState : 'n/a',
    });
    const shouldMarkReadInEmbed =
      isEmbedContext() &&
      chatActiveRef.current === true &&
      activeConversationRef.current === msg.groupId &&
      typeof document !== 'undefined' &&
      document.visibilityState === 'visible';
    if (shouldMarkReadInEmbed) {
      await msgStorage.markMessagesAsRead(msg.groupId);
    }

    setChatListVersion((v) => v + 1);
  }, [identityKeys, poller, pds, soundEnabled, downloadFile, language, triggerBackupAfterAdvance, acquireClaimForCommit, releaseClaim]);

  handleIncomingMessageRef.current = handleIncomingMessage;

  // -------------------------------------------------------------------------
  // Messaging
  // -------------------------------------------------------------------------

  const sendMessage = useCallback(async (groupId: string, text: string): Promise<void> => {
    if (!session || !storage || !pds || !poller) {
      throw new Error('sendMessage: not fully initialized');
    }

    const mlsSession = poller.getSession(groupId);
    if (!mlsSession) throw new Error(`sendMessage: no MLS session for ${groupId}`);

    const plaintextBytes = new TextEncoder().encode(text);
    const result = await mlsSession.encrypt(plaintextBytes);

    // Save updated session state
    await storage.putMlsSession(groupId, mlsSession.serialize());

    // Store message locally
    const msg: StoredMessage = {
      id: result.queueId,
      fromDid: session.did,
      toDid: groupId,
      plaintext: text,
      createdAt: new Date().toISOString(),
      sent: true,
    };
    await storage.putMessage(msg);

    // Send via PDS
    const envelope: DmeEnvelope = {
      $type: 'dme.queue.envelope',
      queueId: result.queueId,
      payload: bytesToBase64url(result.ciphertext),
      createdAt: new Date().toISOString(),
      messageType: 'application',
    };
    try {
      await pds.createEnvelope(envelope);
    } catch (err) {
      // 上传失败：回滚本地记录，避免留下从未上云的"幽灵消息"（本地可见、对方收不到）
      await storage.deleteMessage(groupId, msg.id);
      throw err;
    }

    setChatListVersion((v) => v + 1);
  }, [session, storage, pds, poller]);

  /**
   * 握手成功建立 1v1 会话后自动发送打招呼文案。三个触发点：
   * acceptInviteQr（扫码方）/ processReceivedWelcome（被扫码方，含救援
   * callback）/ acceptRescueInvite（施救方）。尽力而为：失败只记日志。
   */
  const sendGreetingAfterHandshake = useCallback(async (groupId: string): Promise<void> => {
    if (!storage || !session || !pds || !poller) return;
    const text = await storage.getGreetingText();
    await sendMessage(groupId, text);
  }, [storage, session, pds, poller, sendMessage]);

  sendGreetingRef.current = sendGreetingAfterHandshake;

  /**
   * Send an embedded post-card message. The fatesky-provided share payload is
   * serialized as a `PostMessage` JSON plaintext and sent through the existing
   * MLS application-message path (same wire shape as text/file messages).
   */
  const sendPostMessage = useCallback(async (
    groupId: string,
    post: { uri: string; url: string; html?: string },
  ): Promise<void> => {
    if (!session || !storage || !pds || !poller) {
      throw new Error('sendPostMessage: not fully initialized');
    }

    const mlsSession = poller.getSession(groupId);
    if (!mlsSession) throw new Error(`sendPostMessage: no MLS session for ${groupId}`);

    const plaintext = JSON.stringify({
      type: POST_MESSAGE_TYPE,
      uri: post.uri,
      url: post.url,
      ...(post.html ? { html: post.html } : {}),
    } as PostMessage);

    const plaintextBytes = new TextEncoder().encode(plaintext);
    const result = await mlsSession.encrypt(plaintextBytes);
    await storage.putMlsSession(groupId, mlsSession.serialize());

    const msg: StoredMessage = {
      id: result.queueId,
      fromDid: session.did,
      toDid: groupId,
      plaintext,
      createdAt: new Date().toISOString(),
      sent: true,
      kind: 'post',
      conversationId: groupId,
    };
    await storage.putMessage(msg);

    const envelope: DmeEnvelope = {
      $type: 'dme.queue.envelope',
      queueId: result.queueId,
      payload: bytesToBase64url(result.ciphertext),
      createdAt: new Date().toISOString(),
      messageType: 'application',
    };
    try {
      await pds.createEnvelope(envelope);
    } catch (err) {
      // 上传失败：回滚本地记录，避免留下从未上云的"幽灵消息"（本地可见、对方收不到）
      await storage.deleteMessage(groupId, msg.id);
      throw err;
    }

    setChatListVersion((v) => v + 1);
  }, [session, storage, pds, poller]);

  const sendFileMessage = useCallback(async (
    conversationId: string,
    fileUri: string,
    fileName: string,
    mimeType: string,
    fileSize: number,
  ): Promise<void> => {
    if (!session || !storage || !pds || !poller) {
      throw new Error('sendFileMessage: not fully initialized');
    }
    if (fileSize > 500 * 1024 * 1024) {
      console.warn('sendFileMessage: file > 500MB, upload may take a while');
    }
    const mlsSession = poller.getSession(conversationId);
    if (!mlsSession) {
      throw new Error(`sendFileMessage: no MLS session for ${conversationId}`);
    }

    const fileId = generateFileId();
    const fileKey = generateFileKey();
    const tempId = generateId();
    const chunkSize = 5 * 1024 * 1024;
    const fileIdHex = bytesToHex(fileId);

    // Save local copy first, then upload from that copy.
    let senderLocalPath: string;
    if (Platform.OS === 'web') {
      const response = await fetch(fileUri);
      const webFileBytes = new Uint8Array(await response.arrayBuffer());
      if (webFileBytes.byteLength !== fileSize) {
        console.warn(`sendFileMessage: web file size ${webFileBytes.byteLength} != reported ${fileSize}`);
      }
      await cacheFile(fileIdHex, webFileBytes, mimeType);
      senderLocalPath = makeIndexedDbUri(fileIdHex);
    } else {
      const sanitizedFileName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
      senderLocalPath = `${FileSystem.documentDirectory}${fileIdHex}_${sanitizedFileName}`;
      const fileBase64 = await FileSystem.readAsStringAsync(fileUri, {
        encoding: FileSystem.EncodingType.Base64,
      });
      await FileSystem.writeAsStringAsync(senderLocalPath, fileBase64, {
        encoding: FileSystem.EncodingType.Base64,
      });
    }

    const optimisticMsg: StoredMessage = {
      id: tempId,
      fromDid: session.did,
      toDid: conversationId,
      plaintext: JSON.stringify({ type: 'file', fileId: fileIdHex, fileName, fileSize, mimeType, sha256: '', chunkCount: 0, chunkSize, fileKey: bytesToBase64url(fileKey) }),
      createdAt: new Date().toISOString(),
      sent: false,
      kind: 'file',
      fileMeta: {
        fileId: fileIdHex,
        fileName,
        fileSize,
        mimeType,
        sha256: '',
        chunkCount: 0,
        chunkSize,
        fileKey: bytesToBase64url(fileKey),
        localPath: senderLocalPath,
        downloadStatus: 'pending',
        uploadStatus: 'uploading',
      },
    };
    await storage.putMessage(optimisticMsg);
    setChatListVersion((v) => v + 1);

    let uploadResult: { blobRefs: DmeBlobRef[]; sha256: string; chunkCount: number };
    try {
      const pdsUrlStr = session.pdsUrlStr;
      const accessJwt = session.accessJwt;
      if (!accessJwt) throw new Error('sendFileMessage: no access token');
      const proxyHeader = session.agent.proxy ?? null;

      uploadResult = await uploadFileChunks(
        fileSize,
        fileKey,
        fileId,
        pdsUrlStr,
        accessJwt,
        proxyHeader,
        async (offset, readSize) => {
          if (Platform.OS === 'web') {
            const bytes = await getCachedFileBytes(fileIdHex);
            if (!bytes) throw new Error('sendFileMessage: cached file bytes not available');
            const end = Math.min(offset + readSize, bytes.length);
            return bytes.subarray(offset, end);
          }
          const base64 = await FileSystem.readAsStringAsync(senderLocalPath, {
            position: offset,
            length: readSize,
            encoding: FileSystem.EncodingType.Base64,
          });
          return base64ToBytes(base64);
        },
        async (progress) => {
          await storage.updateFileMessageMeta(conversationId, tempId, { uploadProgress: progress });
          setChatListVersion((v) => v + 1);
        },
      );
    } catch (err) {
      console.error('sendFileMessage: upload failed', err);
      await storage.updateFileMessageMeta(conversationId, tempId, { uploadStatus: 'failed', uploadProgress: undefined });
      setChatListVersion((v) => v + 1);
      return;
    }

    const manifestBytes = new TextEncoder().encode(JSON.stringify({
      type: 'file',
      fileId: fileIdHex,
      fileName,
      fileSize,
      mimeType,
      sha256: uploadResult.sha256,
      chunkCount: uploadResult.chunkCount,
      chunkSize,
      fileKey: bytesToBase64url(fileKey),
    } as FileManifestMessage));

    const encResult = await mlsSession.encrypt(manifestBytes);
    await storage.putMlsSession(conversationId, mlsSession.serialize());
    try {
      await pds.createEnvelope({
        $type: 'dme.queue.envelope',
        queueId: encResult.queueId,
        payload: bytesToBase64url(encResult.ciphertext),
        blobCids: uploadResult.blobRefs,
        createdAt: new Date().toISOString(),
        messageType: 'application',
      });
    } catch (err) {
      // 清单上云失败：文件已传上云，不删记录，回退为 failed 走现有重试 UI
      console.error('sendFileMessage: manifest send failed', err);
      await storage.updateFileMessageMeta(conversationId, tempId, { uploadStatus: 'failed' });
      setChatListVersion((v) => v + 1);
      return;
    }

    await storage.deleteMessage(conversationId, tempId);
    let thumb: string | null = null;
    if (mimeType.startsWith('video/')) {
      thumb = await generateVideoThumbnail({
        sourceUri: senderLocalPath,
        mimeType,
        thumbKey: fileIdHex,
      });
    }
    const finalMsg: StoredMessage = {
      id: encResult.queueId,
      fromDid: session.did,
      toDid: conversationId,
      plaintext: JSON.stringify({ type: 'file', fileId: fileIdHex, fileName, fileSize, mimeType, sha256: uploadResult.sha256, chunkCount: uploadResult.chunkCount, chunkSize, fileKey: bytesToBase64url(fileKey) }),
      createdAt: new Date().toISOString(),
      sent: true,
      kind: 'file',
      fileMeta: {
        fileId: fileIdHex,
        fileName,
        fileSize,
        mimeType,
        sha256: uploadResult.sha256,
        chunkCount: uploadResult.chunkCount,
        chunkSize,
        fileKey: bytesToBase64url(fileKey),
        blobCids: uploadResult.blobRefs,
        downloadStatus: 'ready',
        uploadStatus: 'uploaded',
        localPath: senderLocalPath,
        thumbnailPath: thumb ?? undefined,
      },
    };
    await storage.putMessage(finalMsg);
    setChatListVersion((v) => v + 1);
  }, [session, storage, pds, poller]);

  const retryUploadFileMessage = useCallback(async (
    conversationId: string,
    msgId: string,
  ): Promise<void> => {
    if (!session || !storage || !pds || !poller) {
      throw new Error('retryUploadFileMessage: not fully initialized');
    }
    const mlsSession = poller.getSession(conversationId);
    if (!mlsSession) {
      throw new Error(`retryUploadFileMessage: no MLS session for ${conversationId}`);
    }

    const msgs = await storage.getMessages(conversationId);
    const msg = msgs.find((m) => m.id === msgId);
    if (!msg || !msg.fileMeta) {
      throw new Error('retryUploadFileMessage: message or fileMeta not found');
    }
    const { fileMeta } = msg;
    if (!fileMeta.localPath) {
      throw new Error('retryUploadFileMessage: local copy missing, cannot retry');
    }

    const fileId = hexToBytes(fileMeta.fileId);
    const fileKey = base64urlToBytes(fileMeta.fileKey);
    const fileSize = fileMeta.fileSize;
    const mimeType = fileMeta.mimeType;
    const fileName = fileMeta.fileName;
    const senderLocalPath = fileMeta.localPath;
    const chunkSize = fileMeta.chunkSize || 5 * 1024 * 1024;

    await storage.updateFileMessageMeta(conversationId, msgId, { uploadStatus: 'uploading' });
    setChatListVersion((v) => v + 1);

    let uploadResult: { blobRefs: DmeBlobRef[]; sha256: string; chunkCount: number };
    try {
      const pdsUrlStr = session.pdsUrlStr;
      const accessJwt = session.accessJwt;
      if (!accessJwt) throw new Error('retryUploadFileMessage: no access token');
      const proxyHeader = session.agent.proxy ?? null;

      uploadResult = await uploadFileChunks(
        fileSize,
        fileKey,
        fileId,
        pdsUrlStr,
        accessJwt,
        proxyHeader,
        async (offset, readSize) => {
          if (Platform.OS === 'web') {
            const bytes = await getCachedFileBytes(fileMeta.fileId);
            if (!bytes) throw new Error('retryUploadFileMessage: cached file bytes not available');
            const end = Math.min(offset + readSize, bytes.length);
            return bytes.subarray(offset, end);
          }
          const base64 = await FileSystem.readAsStringAsync(senderLocalPath, {
            position: offset,
            length: readSize,
            encoding: FileSystem.EncodingType.Base64,
          });
          return base64ToBytes(base64);
        },
        async (progress) => {
          await storage.updateFileMessageMeta(conversationId, msgId, { uploadProgress: progress });
          setChatListVersion((v) => v + 1);
        },
      );
    } catch (err) {
      console.error('retryUploadFileMessage: upload failed', err);
      await storage.updateFileMessageMeta(conversationId, msgId, { uploadStatus: 'failed', uploadProgress: undefined });
      setChatListVersion((v) => v + 1);
      return;
    }

    const manifestBytes = new TextEncoder().encode(JSON.stringify({
      type: 'file',
      fileId: fileMeta.fileId,
      fileName,
      fileSize,
      mimeType,
      sha256: uploadResult.sha256,
      chunkCount: uploadResult.chunkCount,
      chunkSize,
      fileKey: bytesToBase64url(fileKey),
    } as FileManifestMessage));

    const encResult = await mlsSession.encrypt(manifestBytes);
    await storage.putMlsSession(conversationId, mlsSession.serialize());
    try {
      await pds.createEnvelope({
        $type: 'dme.queue.envelope',
        queueId: encResult.queueId,
        payload: bytesToBase64url(encResult.ciphertext),
        blobCids: uploadResult.blobRefs,
        createdAt: new Date().toISOString(),
        messageType: 'application',
      });
    } catch (err) {
      // 清单上云失败：文件已传上云，不删记录，回退为 failed 走现有重试 UI
      console.error('retryUploadFileMessage: manifest send failed', err);
      await storage.updateFileMessageMeta(conversationId, msgId, { uploadStatus: 'failed' });
      setChatListVersion((v) => v + 1);
      return;
    }

    await storage.deleteMessage(conversationId, msgId);
    let thumb: string | null = null;
    if (mimeType.startsWith('video/')) {
      thumb = await generateVideoThumbnail({
        sourceUri: senderLocalPath,
        mimeType,
        thumbKey: fileMeta.fileId,
      });
    }
    const finalMsg: StoredMessage = {
      id: encResult.queueId,
      fromDid: session.did,
      toDid: conversationId,
      plaintext: JSON.stringify({ type: 'file', fileId: fileMeta.fileId, fileName, fileSize, mimeType, sha256: uploadResult.sha256, chunkCount: uploadResult.chunkCount, chunkSize, fileKey: bytesToBase64url(fileKey) }),
      createdAt: new Date().toISOString(),
      sent: true,
      kind: 'file',
      fileMeta: {
        fileId: fileMeta.fileId,
        fileName,
        fileSize,
        mimeType,
        sha256: uploadResult.sha256,
        chunkCount: uploadResult.chunkCount,
        chunkSize,
        fileKey: bytesToBase64url(fileKey),
        blobCids: uploadResult.blobRefs,
        downloadStatus: 'ready',
        uploadStatus: 'uploaded',
        localPath: senderLocalPath,
        thumbnailPath: thumb ?? undefined,
      },
    };
    await storage.putMessage(finalMsg);
    setChatListVersion((v) => v + 1);
  }, [session, storage, pds, poller]);

  const sendReaction = useCallback(async (conversationId: string, messageId: string, emoji: string): Promise<void> => {
    if (!session || !storage || !pds || !poller) {
      throw new Error('sendReaction: not fully initialized');
    }

    const mlsSession = poller.getSession(conversationId);
    if (!mlsSession) throw new Error(`sendReaction: no MLS session for ${conversationId}`);

    const msgs = await storage.getMessages(conversationId);
    const target = msgs.find((m) => m.id === messageId);
    const alreadyReacted = target?.reactions?.some((r) => r.did === session.did && r.emoji === emoji) ?? false;

    const action: 'add' | 'remove' = alreadyReacted ? 'remove' : 'add';

    if (action === 'remove') {
      await storage.removeReaction(conversationId, messageId, session.did, emoji);
    } else {
      await storage.addReaction(conversationId, messageId, {
        emoji,
        did: session.did,
        createdAt: new Date().toISOString(),
      });
    }

    const payload: ReactionMessage = {
      type: 'reaction',
      conversationId,
      targetMessageId: messageId,
      emoji,
      action,
      createdAt: new Date().toISOString(),
    };

    const plaintextBytes = new TextEncoder().encode(JSON.stringify(payload));
    const result = await mlsSession.encrypt(plaintextBytes);
    await storage.putMlsSession(conversationId, mlsSession.serialize());

    const envelope: DmeEnvelope = {
      $type: 'dme.queue.envelope',
      queueId: result.queueId,
      payload: bytesToBase64url(result.ciphertext),
      createdAt: new Date().toISOString(),
      messageType: 'application',
    };
    await pds.createEnvelope(envelope);

    setChatListVersion((v) => v + 1);
  }, [session, storage, pds, poller]);

  const deleteFriend = useCallback(async (groupId: string): Promise<void> => {
    if (!storage || !poller) throw new Error('deleteFriend: not initialized');

    poller.removeSession(groupId);
    await storage.deleteMlsSession(groupId);
    await storage.deleteMessages(groupId);

    setGroups((prev) => prev.filter((g) => g !== groupId));
    setChatListVersion((v) => v + 1);
  }, [storage, poller]);

  const markConversationAsRead = useCallback(async (groupId: string): Promise<void> => {
    if (!storage) return;
    await storage.markMessagesAsRead(groupId);
    setChatListVersion((v) => v + 1);
  }, [storage]);

  const deleteMessage = useCallback(async (conversationId: string, messageId: string): Promise<void> => {
    if (!storage) throw new Error('deleteMessage: not initialized');
    await storage.deleteMessage(conversationId, messageId);
    setChatListVersion((v) => v + 1);
  }, [storage]);

  // -------------------------------------------------------------------------
  // Group Chat Actions
  // -------------------------------------------------------------------------

  const sendGroupInvites = useCallback(async (
    groupName: string,
    friendDids: readonly string[],
  ): Promise<string> => {
    if (!session || !storage || !identityKeys || !pds || !poller) {
      throw new Error('sendGroupInvites: not fully initialized');
    }

    const groupId = generateId();
    const creatorMember: GroupMember = {
      did: session.did,
      displayName: session.did,
      role: 'creator',
    };

    const newPending: PendingInvite[] = [];

    for (const friendDid of friendDids) {
      const inviteId = generateId();

      const inviteRequest = createInviteRequest({
        inviteId,
        groupId,
        groupName,
        members: [creatorMember],
      });

      const mlsSession = poller.getSession(friendDid);
      if (!mlsSession) {
        console.error('sendGroupInvites: no MLS session for', friendDid);
        continue;
      }

      const plaintextBytes = new TextEncoder().encode(JSON.stringify(inviteRequest));
      const encResult = await mlsSession.encrypt(plaintextBytes);
      await storage.putMlsSession(friendDid, mlsSession.serialize());

      const envelope: DmeEnvelope = {
        $type: 'dme.queue.envelope',
        queueId: encResult.queueId,
        payload: bytesToBase64url(encResult.ciphertext),
        createdAt: new Date().toISOString(),
        messageType: 'application',
      };
      await pds.createEnvelope(envelope);

      const friendHandle = await resolveHandleCached(friendDid);
      await storage.putMessage({
        id: `sys_invite_${inviteId}`,
        fromDid: session.did,
        toDid: friendDid,
        plaintext: t(language, 'group.youInvited', { handle: friendHandle, group: groupName }),
        createdAt: new Date().toISOString(),
        sent: true,
        kind: 'group_system',
      });

      const invite: PendingInvite = {
        inviteId,
        groupId,
        groupName,
        inviterDid: session.did,
        inviteeDid: friendDid,
        status: 'pending',
        createdAt: new Date().toISOString(),
      };
      await storage.putPendingInvite(invite);
      newPending.push(invite);
    }

    setPendingInvites((prev) => [...prev, ...newPending]);
    setChatListVersion((v) => v + 1);
    return groupId;
  }, [session, storage, identityKeys, pds, poller, language]);

  const respondToGroupInvite = useCallback(async (
    inviteId: string,
    accepted: boolean,
  ): Promise<void> => {
    if (!session || !storage || !identityKeys || !pds || !poller) {
      throw new Error('respondToGroupInvite: not fully initialized');
    }

    const invite = receivedGroupInvites.find((i) => i.inviteId === inviteId);
    if (!invite) throw new Error('respondToGroupInvite: invite not found');

    if (accepted) {
      // 陈旧邀请防线（2026-10-14 实测踩坑）：恢复旧备份/重放复活的老邀请
      // 被再次点「接受」时，若本机已有该群的 MLS 会话，说明用户本来就在
      // 群中。此时再发 accept_response 是无效重复——群主端该 inviteId 早已
      // cancelled/不存在，静默丢弃后用户端卡片变「已接受」却永远等不到
      // welcome，静默卡死无法聊天。直接本地收敛，不发响应。
      if (await storage.getMlsSession(invite.groupId)) {
        console.log(
          'respondToGroupInvite: already in group, converging stale invite without re-accepting',
          invite.groupId,
        );
        const convergedInvite: PendingInvite = { ...invite, status: 'accepted' };
        await storage.putPendingInvite(convergedInvite);
        setReceivedGroupInvites((prev) =>
          prev.map((i) => i.inviteId === inviteId ? convergedInvite : i),
        );
        setChatListVersion((v) => v + 1);
        return;
      }

      const inviterEncKey = await getRemoteEncryptionKey(invite.inviterDid);
      if (!inviterEncKey) throw new Error('respondToGroupInvite: inviter has no encryption key');

      // KP 池化（备份点）：welcome 的解密依赖接受方 KP pair 的私钥，pair 必须
      // 随备份走，否则恢复后 welcome（TTL 内重放）数学上永远解不开（实测踩坑：
      // 恢复后收到邀请/自己确认/Bob 确认，唯独进不了群）。从 keyPackagePool
      // 取未消费 pair——池已进 FullBackupData：welcome 未到达时 pair 完好随
      // 备份，恢复后直接 join；join 成功才标 consumed（KP 一次性）。
      // 新鲜度过滤（rotation-baseline-plan.md 3.3）：只取年龄 ≤ 轮换周期的
      // 条目；预留路径不标 consumed（ownKeyPackagePoolId 持有至 join 成功）
      const findFreshEntry = async (): Promise<KeyPackagePoolEntry | undefined> => {
        const interval = await storage.getKeyRotationIntervalMs();
        return (await storage.getKeyPackagePool()).find(
          (e) => !e.consumed && isFreshPoolEntry(e, interval),
        );
      };
      let poolEntry = await findFreshEntry();
      if (!poolEntry) {
        await refreshKeyPackagePool();
        poolEntry = await findFreshEntry();
      }
      if (!poolEntry) throw new Error('respondToGroupInvite: key package pool exhausted');

      // 宣言门禁（约定7）：点接受（占用 KP、产生备份点状态）前必须先宣言。
      // 同账号多端同时点接受会向群主发两个不同 KP 的 accept_response，
      // 后者覆盖前者、先点的一端永远等不到 welcome；taken/stale 已置标记
      // 提示恢复备份，fail-closed 保持 pending 稍后重试
      const claimSeq = await acquireClaimForCommit(invite.groupId, 0);
      if (claimSeq === null) return;

      const { encryptKeyPackagePairForInvite } = await import('../handshake/group-invite');
      const poolPublicPackage = deserializeWithUint8Array<KeyPackage>(poolEntry.publicPackageSerialized);
      const encryptedKeyPackage = await encryptKeyPackagePairForInvite(
        poolPublicPackage,
        inviterEncKey,
      );

      const response = createAcceptResponse({
        inviteId,
        groupId: invite.groupId,
        encryptedKeyPackage,
      });

      const mlsSession = poller.getSession(invite.inviterDid);
      if (!mlsSession) throw new Error('respondToGroupInvite: no MLS session for inviter');

      let encResult: { queueId: string; ciphertext: Uint8Array };
      try {
        const plaintextBytes = new TextEncoder().encode(JSON.stringify(response));
        encResult = await mlsSession.encrypt(plaintextBytes);
        await storage.putMlsSession(invite.inviterDid, mlsSession.serialize());

        const envelope: DmeEnvelope = {
          $type: 'dme.queue.envelope',
          queueId: encResult.queueId,
          payload: bytesToBase64url(encResult.ciphertext),
          createdAt: new Date().toISOString(),
          messageType: 'application',
        };
        await pds.createEnvelope(envelope);
      } catch (err) {
        await releaseClaim();
        throw err;
      }
      await storage.setCommitSeq(claimSeq);

      const updatedInvite: PendingInvite = {
        ...invite,
        status: 'accepted',
        ownKeyPackagePoolId: poolEntry.id,
      };
      await storage.putPendingInvite(updatedInvite);
      setReceivedGroupInvites((prev) =>
        prev.map((i) => i.inviteId === inviteId ? updatedInvite : i),
      );
    } else {
      const response = createRejectResponse({ inviteId, groupId: invite.groupId });

      const mlsSession = poller.getSession(invite.inviterDid);
      if (!mlsSession) throw new Error('respondToGroupInvite: no MLS session for inviter');

      const plaintextBytes = new TextEncoder().encode(JSON.stringify(response));
      const encResult = await mlsSession.encrypt(plaintextBytes);
      await storage.putMlsSession(invite.inviterDid, mlsSession.serialize());

      const envelope: DmeEnvelope = {
        $type: 'dme.queue.envelope',
        queueId: encResult.queueId,
        payload: bytesToBase64url(encResult.ciphertext),
        createdAt: new Date().toISOString(),
        messageType: 'application',
      };
      await pds.createEnvelope(envelope);

      await storage.updatePendingInviteStatus(inviteId, 'rejected');
    }

    setReceivedGroupInvites((prev) =>
      prev.map((i) => i.inviteId === inviteId ? { ...i, status: accepted ? 'accepted' : 'rejected' } : i),
    );
    setChatListVersion((v) => v + 1);
  }, [session, storage, identityKeys, pds, poller, receivedGroupInvites, refreshKeyPackagePool, acquireClaimForCommit, releaseClaim]);

  const createGroupFromPendingInvites = useCallback(async (groupId: string): Promise<void> => {
    if (!session || !storage || !identityKeys || !pds || !poller) {
      throw new Error('createGroupFromPendingInvites: not fully initialized');
    }

    const accepted = pendingInvites.filter(
      (i) => i.groupId === groupId && i.status === 'accepted',
    );
    if (accepted.length === 0) {
      throw new Error('createGroupFromPendingInvites: no accepted members');
    }

    const { createGroupWithMembers } = await import('../handshake/group-invite');

    const acceptedMembers: { did: string; keyPackage: KeyPackage }[] = [];
    for (const invite of accepted) {
      if (!invite.keyPackageSerialized) continue;
      const keyPackage = await deserializeAcceptedKeyPackage({
        keyPackageSerialized: invite.keyPackageSerialized,
        ownEncryptionPrivateKey: identityKeys.encryption.privateKey,
      });
      acceptedMembers.push({ did: invite.inviteeDid, keyPackage });
    }

    // 宣言门禁（约定7）：建群（首串 commit）前必须先宣言；新群 epoch 从 0 起。
    // taken/stale 已置标记提示恢复备份，fail-closed 静默放弃本次操作
    const claimSeq = await acquireClaimForCommit(groupId, 0);
    if (claimSeq === null) return;

    // KP 池统一消费（rotation-baseline-plan.md 3.2）：群主叶子密钥改吃池，
    // 宣言通过后才取（失败不浪费池位），立即标 consumed（私钥随即进本机会话）
    let ownerPoolPair: KeyPackagePair;
    try {
      ownerPoolPair = (await takeFreshPoolPair('createGroupFromPendingInvites', true)).pair;
    } catch (err) {
      await releaseClaim();
      throw err;
    }

    let created: Awaited<ReturnType<typeof createGroupWithMembers>>;
    try {
      created = await createGroupWithMembers({
        groupId,
        ownerDid: session.did,
        ownerKeyPackagePair: ownerPoolPair,
        acceptedMembers,
      });
    } catch (err) {
      await releaseClaim();
      throw err;
    }
    const { mlsSession: newSession, welcomes, commits } = created;

    try {
    await storage.putMlsSession(groupId, newSession.serialize());
    poller.addSession(groupId, newSession);

    const creatorMember: GroupMember = {
      did: session.did,
      displayName: session.did,
      role: 'creator',
    };
    const memberList: GroupMember[] = [
      creatorMember,
      ...accepted.map((i) => ({ did: i.inviteeDid, displayName: i.inviteeDid, role: 'member' as const })),
    ];

    const groupInfo: GroupInfo = {
      groupId,
      groupName: accepted[0]?.groupName ?? t(language, 'group.newGroup'),
      creatorDid: session.did,
      members: memberList,
      createdAt: new Date().toISOString(),
    };
    await storage.putGroupInfo(groupInfo);
    setGroupInfos((prev) => [...prev, groupInfo]);
    setPendingInvites((prev) => prev.filter((i) => i.groupId !== groupId));

    for (const invite of accepted) {
      const welcomeBytes = welcomes.get(invite.inviteeDid);
      if (!welcomeBytes) continue;

      const welcomeMsg = createGroupWelcome({
        groupId,
        groupName: groupInfo.groupName,
        welcomePayload: bytesToBase64url(welcomeBytes),
        members: memberList,
      });

      const mlsSession = poller.getSession(invite.inviteeDid);
      if (!mlsSession) continue;

      const plaintextBytes = new TextEncoder().encode(JSON.stringify(welcomeMsg));
      const encResult = await mlsSession.encrypt(plaintextBytes);
      await storage.putMlsSession(invite.inviteeDid, mlsSession.serialize());

      const envelope: DmeEnvelope = {
        $type: 'dme.queue.envelope',
        queueId: encResult.queueId,
        payload: bytesToBase64url(encResult.ciphertext),
        createdAt: new Date().toISOString(),
        messageType: 'application',
      };
      await pds.createEnvelope(envelope);

      await storage.updatePendingInviteStatus(invite.inviteId, 'cancelled');
    }

    const metadataMsg = createMetadataUpdate({
      groupId,
      groupName: groupInfo.groupName,
      members: memberList,
    });

    for (const invite of accepted) {
      const mlsSession = poller.getSession(invite.inviteeDid);
      if (!mlsSession) continue;

      const plaintextBytes = new TextEncoder().encode(JSON.stringify(metadataMsg));
      const encResult = await mlsSession.encrypt(plaintextBytes);
      await storage.putMlsSession(invite.inviteeDid, mlsSession.serialize());

      const envelope: DmeEnvelope = {
        $type: 'dme.queue.envelope',
        queueId: encResult.queueId,
        payload: bytesToBase64url(encResult.ciphertext),
        createdAt: new Date().toISOString(),
        messageType: 'application',
      };
      await pds.createEnvelope(envelope);
    }

    // 注：建群阶段的 commit 投递保留成对 1v1 通道——committer 恒为 creator，
    // 而 creator 与每个受邀者的 1v1 会话由邀请流程（即 1v1 握手）结构性保证存在。
    // 其余 commit 场景（踢人/拉人/轮换）已改走群 queueId 空间（commit-delivery.ts）。
    for (const { commitMessage, memberDids } of commits) {
      // 谱系账本（group-fork-plan.md 3.1）：每条逻辑 commit 独立预留 seq，
      // 1v1 扇出的各副本共享该 seq，逐份追加 queueId
      const seqMeta = await storage.reserveGroupCommit(groupId);
      const commitMsg = {
        type: 'group_commit' as const,
        groupId,
        commitPayload: bytesToBase64url(commitMessage),
      };

      for (const memberDid of memberDids) {
        const mlsSession = poller.getSession(memberDid);
        if (!mlsSession) continue;

        const plaintextBytes = new TextEncoder().encode(JSON.stringify(commitMsg));
        const encResult = await mlsSession.encrypt(plaintextBytes);
        await storage.putMlsSession(memberDid, mlsSession.serialize());

        const envelope: DmeEnvelope = {
          $type: 'dme.queue.envelope',
          queueId: encResult.queueId,
          payload: bytesToBase64url(encResult.ciphertext),
          createdAt: new Date().toISOString(),
          messageType: 'application',
          groupSeq: seqMeta.seq,
          ...(seqMeta.parentQueueId ? { parentQueueId: seqMeta.parentQueueId } : {}),
        };
        await pds.createEnvelope(envelope);
        await storage.appendGroupCommitQueueId(groupId, seqMeta.seq, encResult.queueId);
      }
    }
    } catch (err) {
      // welcome/commit 投递失败：移除新群会话并释放宣言——绝不让
      // 「本地已换代而对端未收到」的状态落盘（否则全员脱钩），上层可重试
      console.warn('createGroupFromPendingInvites: delivery failed, cleaning up', err);
      poller.removeSession(groupId);
      await storage.deleteMlsSession(groupId);
      await releaseClaim();
      throw err;
    }

    await storage.setCommitSeq(claimSeq);

    // 备份点：新建群会话（覆盖同 groupId 的旧会话）+ owner KP + 全部
    // welcome/commit 投递完成，立即联动备份（群主其他端恢复后才有新群）
    await triggerBackupAfterAdvance(`createGroup ${groupId}`);

    setGroups((prev) => [...prev, groupId]);
    setChatListVersion((v) => v + 1);
  }, [session, storage, identityKeys, pds, poller, pendingInvites, language, triggerBackupAfterAdvance, acquireClaimForCommit, releaseClaim, takeFreshPoolPair]);

  const cancelGroupInvite = useCallback(async (inviteId: string): Promise<void> => {
    if (!storage) throw new Error('cancelGroupInvite: storage not initialized');

    await storage.updatePendingInviteStatus(inviteId, 'cancelled');
    setPendingInvites((prev) =>
      prev.map((i) => i.inviteId === inviteId ? { ...i, status: 'cancelled' as const } : i),
    );
    setChatListVersion((v) => v + 1);
  }, [storage]);

  const addMemberToGroup = useCallback(async (
    groupId: string,
    friendDid: string,
  ): Promise<void> => {
    if (!session || !storage || !identityKeys || !pds || !poller) {
      throw new Error('addMemberToGroup: not fully initialized');
    }

    const mlsSession = poller.getSession(groupId);
    if (!mlsSession) throw new Error('addMemberToGroup: no MLS session for group');

    const friendMlsSession = poller.getSession(friendDid);
    if (!friendMlsSession) throw new Error('addMemberToGroup: no MLS session for friend');

      const inviterEncKey = await getRemoteEncryptionKey(friendDid);
    if (!inviterEncKey) throw new Error('addMemberToGroup: friend has no encryption key');

    // 移除死调用（rotation-baseline-plan.md 3.2 附带清理）：原
    // generateEncryptedKeyPackageForInvite 的返回值从未被使用——接受方在
    // respondToGroupInvite 时自取池内 pair，邀请请求不携带 KP。

    const groupInfo = await storage.getGroupInfo(groupId);
    if (!groupInfo) throw new Error('addMemberToGroup: group info not found');

    const inviteId = generateId();
    const inviteRequest = createInviteRequest({
      inviteId,
      groupId,
      groupName: groupInfo.groupName,
      members: [...groupInfo.members],
    });

    const plaintextBytes = new TextEncoder().encode(JSON.stringify(inviteRequest));
    const encResult = await friendMlsSession.encrypt(plaintextBytes);
    await storage.putMlsSession(friendDid, friendMlsSession.serialize());

    const envelope: DmeEnvelope = {
      $type: 'dme.queue.envelope',
      queueId: encResult.queueId,
      payload: bytesToBase64url(encResult.ciphertext),
      createdAt: new Date().toISOString(),
      messageType: 'application',
    };
    await pds.createEnvelope(envelope);

    const friendHandle = await resolveHandleCached(friendDid);
    await storage.putMessage({
      id: `sys_invite_${inviteId}`,
      fromDid: session.did,
      toDid: friendDid,
        plaintext: t(language, 'group.youInvited', { handle: friendHandle, group: groupInfo.groupName }),
      createdAt: new Date().toISOString(),
      sent: true,
      kind: 'group_system',
    });

    const invite: PendingInvite = {
      inviteId,
      groupId,
      groupName: groupInfo.groupName,
      inviterDid: session.did,
      inviteeDid: friendDid,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    await storage.putPendingInvite(invite);
    setPendingInvites((prev) => [...prev, invite]);
    setChatListVersion((v) => v + 1);
  }, [session, storage, identityKeys, pds, poller, language]);

  const dissolveGroup = useCallback(async (groupId: string): Promise<void> => {
    if (!session || !storage || !pds || !poller) {
      throw new Error('dissolveGroup: not fully initialized');
    }

    const groupInfo = await storage.getGroupInfo(groupId);
    if (!groupInfo) throw new Error('dissolveGroup: group info not found');

    const dissolveMsg: GroupDissolved = {
      type: 'group_dissolved',
      groupId,
      groupName: groupInfo.groupName,
    };

    // Phase 1.0：解散通知改走群 queueId 空间（无 MLS commit、epoch 不变，
    // 当前 epoch 全员可达，不再依赖成对 1v1 会话）
    const groupSession = poller.getSession(groupId);
    if (groupSession) {
      const plaintextBytes = new TextEncoder().encode(JSON.stringify(dissolveMsg));
      const encResult = await groupSession.encrypt(plaintextBytes);
      await storage.putMlsSession(groupId, groupSession.serialize());

      const envelope: DmeEnvelope = {
        $type: 'dme.queue.envelope',
        queueId: encResult.queueId,
        payload: bytesToBase64url(encResult.ciphertext),
        createdAt: new Date().toISOString(),
        messageType: 'application',
      };
      await pds.createEnvelope(envelope);
    }

    const dissolvedInfo: GroupInfo = { ...groupInfo, dissolved: true };
    await storage.putGroupInfo(dissolvedInfo);
    poller.removeSession(groupId);
    await storage.deleteMlsSession(groupId);

    setGroupInfos((prev) => prev.map((g) => g.groupId === groupId ? dissolvedInfo : g));
    setChatListVersion((v) => v + 1);
  }, [session, storage, pds, poller]);

  const removeMemberFromGroup = useCallback(async (
    groupId: string,
    memberDid: string,
  ): Promise<void> => {
    if (!session || !storage || !pds || !poller) {
      throw new Error('removeMemberFromGroup: not fully initialized');
    }

    const groupInfo = await storage.getGroupInfo(groupId);
    if (!groupInfo) throw new Error('removeMemberFromGroup: group info not found');

    const mlsSession = poller.getSession(groupId);
    if (!mlsSession) throw new Error('removeMemberFromGroup: no MLS session for group');

    const leafIndex = mlsSession.getMemberDids().indexOf(memberDid);
    if (leafIndex < 0) throw new Error('removeMemberFromGroup: member not in group');

    // Phase 1.0：先快照「提交前状态」——commit 包装信封必须用旧 epoch 加密，
    // 投进群自己的 queueId 空间（不再依赖成对 1v1 会话，见 commit-delivery.ts）
    const preCommitState = mlsSession.serialize();

    // 宣言门禁（约定7）：踢人 commit 前必须先宣言；taken/stale 已置标记
    // 提示恢复备份，fail-closed 静默放弃本次操作
    const claimSeq = await acquireClaimForCommit(groupId, mlsSession.getEpoch());
    if (claimSeq === null) return;

    let commitMessage: Uint8Array;
    try {
      ({ commitMessage } = await mlsSession.removeMember(leafIndex));
      await storage.putMlsSession(groupId, mlsSession.serialize());

      const removedMsg: GroupMemberRemoved = {
        type: 'group_member_removed',
        groupId,
        groupName: groupInfo.groupName,
        memberDid,
      };

      const removedSession = poller.getSession(memberDid);
      if (removedSession) {
        const plaintextBytes = new TextEncoder().encode(JSON.stringify(removedMsg));
        const encResult = await removedSession.encrypt(plaintextBytes);
        await storage.putMlsSession(memberDid, removedSession.serialize());

        const envelope: DmeEnvelope = {
          $type: 'dme.queue.envelope',
          queueId: encResult.queueId,
          payload: bytesToBase64url(encResult.ciphertext),
          createdAt: new Date().toISOString(),
          messageType: 'application',
        };
        await pds.createEnvelope(envelope);
      }

      // 谱系账本（group-fork-plan.md 3.1）：预留 per-group seq
      const seqMeta = await storage.reserveGroupCommit(groupId);

      const delivered = await deliverCommitViaGroupSpace({
        preCommitStateSerialized: preCommitState,
        groupId,
        commitMessage,
        createEnvelope: (envelope) => pds.createEnvelope(envelope),
        groupSeq: seqMeta.seq,
        parentQueueId: seqMeta.parentQueueId,
      });
      await storage.appendGroupCommitQueueId(groupId, seqMeta.seq, delivered.queueId);
    } catch (err) {
      // commit/投递失败：从提交前快照回滚内存态与存储态、释放宣言
      // （避免虚高水位），绝不让「本地已换代而 commit 未投出」落盘
      console.warn('removeMemberFromGroup: commit failed, rolling back', err);
      const impl = await getNobleMlsImpl();
      const rolledBack = await MlsSession.deserialize(preCommitState, impl);
      poller.addSession(groupId, rolledBack);
      await storage.putMlsSession(groupId, preCommitState);
      await releaseClaim();
      throw err;
    }

    await storage.setCommitSeq(claimSeq);

    // 先落盘新成员列表再备份：备份快照包含 groupInfos，若备份先于
    // putGroupInfo 执行，云端快照里的成员列表仍是旧的（含被踢者），
    // 兄弟端按 sibling-rotated 提示恢复备份后照样显示已移除的成员
    const updatedMembers = groupInfo.members.filter((m) => m.did !== memberDid);
    const updatedInfo: GroupInfo = { ...groupInfo, members: updatedMembers };
    await storage.putGroupInfo(updatedInfo);
    setGroupInfos((prev) => prev.map((g) => g.groupId === groupId ? updatedInfo : g));
    setChatListVersion((v) => v + 1);

    // 成员列表收敛广播（2026-10-21）：commit wrapper 只推进各端 MLS 加密
    // 状态，从不更新各端本地 GroupInfo.members（群管理页据此渲染）——
    // 被踢者一直留在兄弟端/其他成员的群管理列表里。复用现成的
    // group_metadata_update 协议消息广播新成员列表，经群 queueId 空间
    // 投递：其他成员与同账号兄弟端（自叶扫描）收到后走现成 handler
    // 更新 GroupInfo；本机凭 own-leaf gen 游标跳过，不会重复处理；
    // 被踢者已不在树中解不开此消息，其通知走上面的 1v1
    // group_member_removed。best-effort：广播失败不回滚已成功的踢人。
    try {
      const metaMsg = createMetadataUpdate({
        groupId,
        groupName: groupInfo.groupName,
        members: updatedMembers,
      });
      const metaBytes = new TextEncoder().encode(JSON.stringify(metaMsg));
      const metaEnc = await mlsSession.encrypt(metaBytes);
      await storage.putMlsSession(groupId, mlsSession.serialize());
      const metaEnvelope: DmeEnvelope = {
        $type: 'dme.queue.envelope',
        queueId: metaEnc.queueId,
        payload: bytesToBase64url(metaEnc.ciphertext),
        createdAt: new Date().toISOString(),
        messageType: 'application',
      };
      await pds.createEnvelope(metaEnvelope);
    } catch (err) {
      console.warn('removeMemberFromGroup: metadata broadcast failed (best-effort)', err);
    }

    // 备份点：踢人 commit 投递成功，群会话状态推进，立即联动备份
    await triggerBackupAfterAdvance(`removeMember ${groupId}`);
  }, [session, storage, pds, poller, triggerBackupAfterAdvance, acquireClaimForCommit, releaseClaim]);

  const addAcceptedMembersToGroup = useCallback(async (groupId: string): Promise<void> => {
    if (!session || !storage || !identityKeys || !pds || !poller) {
      throw new Error('addAcceptedMembersToGroup: not fully initialized');
    }

    const groupInfo = await storage.getGroupInfo(groupId);
    if (!groupInfo) throw new Error('addAcceptedMembersToGroup: group info not found');

    const mlsSession = poller.getSession(groupId);
    if (!mlsSession) throw new Error('addAcceptedMembersToGroup: no MLS session for group');

    const accepted = pendingInvites.filter(
      (i) => i.groupId === groupId && i.status === 'accepted',
    );
    if (accepted.length === 0) {
      throw new Error('addAcceptedMembersToGroup: no accepted members');
    }

    // 宣言门禁（约定7）：拉人 commit 前必须先宣言；taken/stale 已置标记
    // 提示恢复备份，fail-closed 静默放弃本次操作
    const stateBeforeAdds = mlsSession.serialize();
    const claimSeq = await acquireClaimForCommit(groupId, mlsSession.getEpoch());
    if (claimSeq === null) return;

    const newMembers: GroupMember[] = [];
    const commitsWithTargets: { commitMessage: Uint8Array; preCommitState: string; targetDids: string[] }[] = [];
    const existingDids = new Set(groupInfo.members.map((m) => m.did));

    try {
    for (const invite of accepted) {
      if (!invite.keyPackageSerialized) continue;
      const keyPackage = await deserializeAcceptedKeyPackage({
        keyPackageSerialized: invite.keyPackageSerialized,
        ownEncryptionPrivateKey: identityKeys.encryption.privateKey,
      });

      // Phase 1.0：每个 commit 产生前快照，投递改走群 queueId 空间（见 commit-delivery.ts）
      const preCommitState = mlsSession.serialize();
      const { welcome, commitMessage } = await mlsSession.addMember(keyPackage);

      const welcomeMsg = createGroupWelcome({
        groupId,
        groupName: groupInfo.groupName,
        welcomePayload: bytesToBase64url(welcome),
        members: [...groupInfo.members, ...newMembers, { did: invite.inviteeDid, displayName: invite.inviteeDid, role: 'member' as const }],
      });

      const memberSession = poller.getSession(invite.inviteeDid);
      if (memberSession) {
        const plaintextBytes = new TextEncoder().encode(JSON.stringify(welcomeMsg));
        const encResult = await memberSession.encrypt(plaintextBytes);
        await storage.putMlsSession(invite.inviteeDid, memberSession.serialize());

        const envelope: DmeEnvelope = {
          $type: 'dme.queue.envelope',
          queueId: encResult.queueId,
          payload: bytesToBase64url(encResult.ciphertext),
          createdAt: new Date().toISOString(),
          messageType: 'application',
        };
        await pds.createEnvelope(envelope);
      }

      commitsWithTargets.push({
        commitMessage,
        preCommitState,
        targetDids: [...existingDids].filter((d) => d !== session.did),
      });

      newMembers.push({ did: invite.inviteeDid, displayName: invite.inviteeDid, role: 'member' as const });
      existingDids.add(invite.inviteeDid);
    }

    await storage.putMlsSession(groupId, mlsSession.serialize());

    for (const { commitMessage, preCommitState } of commitsWithTargets) {
      // 谱系账本（group-fork-plan.md 3.1）：每条 commit 独立预留 seq
      const seqMeta = await storage.reserveGroupCommit(groupId);
      const delivered = await deliverCommitViaGroupSpace({
        preCommitStateSerialized: preCommitState,
        groupId,
        commitMessage,
        createEnvelope: (envelope) => pds.createEnvelope(envelope),
        groupSeq: seqMeta.seq,
        parentQueueId: seqMeta.parentQueueId,
      });
      await storage.appendGroupCommitQueueId(groupId, seqMeta.seq, delivered.queueId);
    }
    } catch (err) {
      // addMember/投递失败：从动作前快照回滚内存态与存储态、释放宣言，
      // 绝不让「本地已换代而 commit 未投出」落盘
      console.warn('addAcceptedMembersToGroup: commit failed, rolling back', err);
      const impl = await getNobleMlsImpl();
      const rolledBack = await MlsSession.deserialize(stateBeforeAdds, impl);
      poller.addSession(groupId, rolledBack);
      await storage.putMlsSession(groupId, stateBeforeAdds);
      await releaseClaim();
      throw err;
    }

    await storage.setCommitSeq(claimSeq);

    // 先落盘新成员列表再备份：备份快照包含 groupInfos，若备份先于
    // putGroupInfo 执行，云端快照里的成员列表不含新成员，兄弟端恢复
    // 备份后群管理页看不到拉进来的人
    const updatedInfo: GroupInfo = { ...groupInfo, members: [...groupInfo.members, ...newMembers] };
    await storage.putGroupInfo(updatedInfo);

    // 成员列表收敛广播（2026-10-21，同 removeMember）：commit wrapper 只推进
    // MLS 状态，兄弟端/其他成员的本地 GroupInfo.members 不会更新。广播
    // group_metadata_update，best-effort，失败不回滚已成功的拉人。
    try {
      const metaMsg = createMetadataUpdate({
        groupId,
        groupName: groupInfo.groupName,
        members: updatedInfo.members,
      });
      const metaBytes = new TextEncoder().encode(JSON.stringify(metaMsg));
      const metaEnc = await mlsSession.encrypt(metaBytes);
      await storage.putMlsSession(groupId, mlsSession.serialize());
      const metaEnvelope: DmeEnvelope = {
        $type: 'dme.queue.envelope',
        queueId: metaEnc.queueId,
        payload: bytesToBase64url(metaEnc.ciphertext),
        createdAt: new Date().toISOString(),
        messageType: 'application',
      };
      await pds.createEnvelope(metaEnvelope);
    } catch (err) {
      console.warn('addAcceptedMembersToGroup: metadata broadcast failed (best-effort)', err);
    }

    // 备份点：拉人 commit 全部投递成功，群会话状态推进，立即联动备份
    await triggerBackupAfterAdvance(`addAcceptedMembers ${groupId}`);

    for (const invite of accepted) {
      await storage.updatePendingInviteStatus(invite.inviteId, 'cancelled');
    }

    setGroupInfos((prev) => prev.map((g) => g.groupId === groupId ? updatedInfo : g));
    setPendingInvites((prev) => prev.filter((i) => i.groupId !== groupId));
    setChatListVersion((v) => v + 1);
  }, [session, storage, identityKeys, pds, poller, pendingInvites, triggerBackupAfterAdvance, acquireClaimForCommit, releaseClaim]);

  const leaveGroup = useCallback(async (groupId: string): Promise<void> => {
    if (!session || !storage || !pds || !poller) {
      throw new Error('leaveGroup: not fully initialized');
    }

    const groupInfo = await storage.getGroupInfo(groupId);
    if (!groupInfo) throw new Error('leaveGroup: group info not found');

    const leftMsg = {
      type: 'group_member_left' as const,
      groupId,
      memberDid: session.did,
      groupName: groupInfo.groupName,
    };

    for (const member of groupInfo.members) {
      if (member.did === session.did) continue;
      const memberSession = poller.getSession(member.did);
      if (!memberSession) continue;

      const plaintextBytes = new TextEncoder().encode(JSON.stringify(leftMsg));
      const encResult = await memberSession.encrypt(plaintextBytes);
      await storage.putMlsSession(member.did, memberSession.serialize());

      const envelope: DmeEnvelope = {
        $type: 'dme.queue.envelope',
        queueId: encResult.queueId,
        payload: bytesToBase64url(encResult.ciphertext),
        createdAt: new Date().toISOString(),
        messageType: 'application',
      };
      await pds.createEnvelope(envelope);
    }

    poller.removeSession(groupId);
    await storage.deleteMlsSession(groupId);

    const leftInfo: GroupInfo = { ...groupInfo, left: true };
    await storage.putGroupInfo(leftInfo);

    await storage.putMessage({
      id: `sys_left_${groupId}_${Date.now()}`,
      fromDid: session.did,
      toDid: groupId,
      plaintext: t(language, 'group.youLeft', { group: groupInfo.groupName }),
      createdAt: new Date().toISOString(),
      sent: true,
      kind: 'group_system',
      conversationId: groupId,
    });

    setGroupInfos((prev) => prev.map((g) => g.groupId === groupId ? leftInfo : g));
    setChatListVersion((v) => v + 1);
  }, [session, storage, pds, poller, language]);

  /**
   * 群主拍板（P2，group-fork-plan.md 3.2 / 3.3）：forked 会话中仅群主端展示
   * 拍板确认。确认后经群 MLS 会话广播 group_fork_ruling——群会话密钥天然
   * 决定只有权威世界（本机所在谱系）能解开；非权威世界收不到，维持 forked
   * 横幅走恢复备份路径。本机清除 forked 标记并触发备份联动（备份让非权威
   * 的兄弟端后续可恢复到权威谱系）。
   *
   * 防伪：接收端校验 senderDid == GroupInfo.creatorDid（MLS 自带发送者
   * 认证 + DID 比对），无额外签名机制。
   */
  const issueForkRuling = useCallback(async (groupId: string): Promise<boolean> => {
    if (!session || !storage || !pds || !poller) {
      throw new Error('issueForkRuling: not fully initialized');
    }

    const groupInfo = await storage.getGroupInfo(groupId);
    if (!groupInfo) {
      console.warn('[dme:fork] issueForkRuling: group info not found', groupId);
      return false;
    }
    if (groupInfo.creatorDid !== session.did) {
      // 仅群主可拍板（前端横幅已按角色分流，此处兜底）
      console.warn('[dme:fork] issueForkRuling: non-owner ignored', groupId);
      return false;
    }
    // 兜底：仅对 forked 会话拍板；已收敛/其他异常标记不重复发裁定
    if ((await storage.getSessionIssue(groupId)) !== 'forked') {
      console.log('[dme:fork] issueForkRuling: session not forked, skip', groupId);
      return false;
    }
    const mlsSession = poller.getSession(groupId);
    if (!mlsSession) {
      console.warn('[dme:fork] issueForkRuling: no group session', groupId);
      return false;
    }

    const ruling: GroupForkRuling = { type: 'group_fork_ruling', groupId };
    const plaintextBytes = new TextEncoder().encode(JSON.stringify(ruling));
    const encResult = await mlsSession.encrypt(plaintextBytes);
    await storage.putMlsSession(groupId, mlsSession.serialize());

    const envelope: DmeEnvelope = {
      $type: 'dme.queue.envelope',
      queueId: encResult.queueId,
      payload: bytesToBase64url(encResult.ciphertext),
      createdAt: new Date().toISOString(),
      messageType: 'application',
    };
    await pds.createEnvelope(envelope);

    // 本机即权威：清除 forked 标记（不清 sibling-rotated / desynced——那
    // 些标记语义不同，各有各的恢复路径），并联动备份（备份让非权威的
    // 兄弟端后续可恢复到权威谱系；备份点铁律：先落盘状态再备份，此处
    // 状态变更只有标记清除，标记在 triggerBackup 之前已写回）
    await storage.setSessionIssue(groupId, null);
    await triggerBackupAfterAdvance(`fork ruling ${groupId}`);
    setChatListVersion((v) => v + 1);
    console.log('[dme:fork] fork ruling issued for', groupId);
    return true;
  }, [session, storage, pds, poller, triggerBackupAfterAdvance]);

  // -------------------------------------------------------------------------
  // Block list
  // -------------------------------------------------------------------------

  const refreshBlockList = useCallback(async (): Promise<void> => {
    if (!storage) return;
    setBlockList(await storage.getBlockList());
  }, [storage]);

  const blockMember = useCallback(async (did: string): Promise<void> => {
    if (!storage) throw new Error('blockMember: not initialized');
    await storage.addBlockedDid(did);
    const next = await storage.getBlockList();
    setBlockList(next);
    setChatListVersion((v) => v + 1);
  }, [storage]);

  const unblockMember = useCallback(async (did: string): Promise<void> => {
    if (!storage) throw new Error('unblockMember: not initialized');
    await storage.removeBlockedDid(did);
    const next = await storage.getBlockList();
    setBlockList(next);
    setChatListVersion((v) => v + 1);
  }, [storage]);

  // -------------------------------------------------------------------------
  // Embed token application
  // -------------------------------------------------------------------------

  const consumeShareIntent = useCallback((): void => {
    setShareIntent(null);
  }, []);

  const consumeStartChatIntent = useCallback((): void => {
    setStartChatIntent(null);
  }, []);

  const applyEmbedToken = useCallback(async (payload: EmbedTokenPayload): Promise<void> => {
    if (!isEmbedContext()) return;
    if (embedMismatch) return;
    if (
      typeof payload?.did !== 'string' || payload.did.length === 0 ||
      typeof payload?.handle !== 'string' || payload.handle.length === 0 ||
      typeof payload?.accessJwt !== 'string' || payload.accessJwt.length === 0 ||
      typeof payload?.refreshJwt !== 'string' || payload.refreshJwt.length === 0
    ) return;

    if (!session) {
      const newSession = new DmeSession();
      const newStorage = new DmeStorage(payload.did);
      newSession.setStorage(newStorage);
      newSession.setEmbedToken(payload);
      await hydrateRestoredApp(newSession, newStorage, payload.did);
      setEmbedTokenApplied(true);
      return;
    }

    if (session.did === payload.did) {
      session.setEmbedToken(payload);
      setEmbedTokenApplied(true);
      return;
    }

    setEmbedMismatch({ localDid: session.did, tokenDid: payload.did });
    poller?.stop();
    return;
  }, [embedMismatch, session, poller, hydrateRestoredApp]);

  useEffect(() => {
    start(applyEmbedToken);
  }, [applyEmbedToken]);

  // Inbound share intents from fatesky: surfaced as `shareIntent` state so the
  // navigation root can route to the conversation picker, then cleared via
  // `consumeShareIntent`.
  useEffect(() => {
    onShare((share) => { setShareIntent(share); });
    return () => { onShare(null); };
  }, []);

  // Inbound start-chat intents from fatesky (`DME_START_CHAT`): surfaced as
  // `startChatIntent` state so the navigation root can open the 1v1
  // conversation with the target DID, then cleared via
  // `consumeStartChatIntent`. Payload validation (did shape) lives in the
  // bridge; buffering here is intentional — an intent that arrives before
  // login/navigation is ready fires once the session exists (需求 §3.2).
  useEffect(() => {
    onStartChat((intent) => { setStartChatIntent(intent); });
    return () => { onStartChat(null); };
  }, []);

  useEffect(() => {
    if (!isEmbedContext()) return;
    const inst = sessionRef.current;
    inst?.setEmbedRefreshBlockedHandler(() => {
      const jwt = inst.accessJwt;
      if (jwt) notifySessionInvalid(jwt);
    });
    return () => {
      inst?.setEmbedRefreshBlockedHandler(null);
    };
  }, [session]);

  // Track the parent's chat-active state in embed mode. When the user returns
  // to the /messages route, mark the currently-opened conversation as read so
  // the unread badge updates immediately.
  useEffect(() => {
    if (!isEmbedContext()) return;
    const handler = (active: boolean): void => {
      const wasActive = chatActiveRef.current;
      chatActiveRef.current = active;
      if (!wasActive && active) {
        const conversationId = activeConversationRef.current;
        if (conversationId) {
          markConversationAsRead(conversationId).catch((err: unknown) => {
            console.error('embed mark-conversation-read on activate failed:', err);
          });
        }
      }
    };
    onChatActiveChange(handler);
    return () => {
      offChatActiveChange(handler);
    };
  }, [markConversationAsRead]);

  // Push total unread count to the parent frame (embed mode only). Reports
  // immediately on every chatListVersion bump and every 30s as a fallback.
  useEffect(() => {
    if (!isEmbedContext() || !embedTokenApplied || !session || !storage || embedMismatch) return;
    let cancelled = false;
    const report = async (): Promise<void> => {
      try {
        if (embedMismatch) return;
        const total = await computeTotalUnread(storage, session.did, new Set(blockList));
        if (!cancelled) sendUnread(total, total > 0);
      } catch (err) {
        console.error('embed unread report failed:', err);
      }
    };
    void report();
    const id = setInterval(() => void report(), 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [chatListVersion, session, storage, blockList, embedTokenApplied, embedMismatch]);

  // -------------------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------------------

  useEffect(() => {
    return () => {
      poller?.stop();
    };
  }, [poller]);

  // -------------------------------------------------------------------------
  // Context value
  // -------------------------------------------------------------------------

  const value = useMemo<AppContextValue>(
    () => ({
      session,
      storage,
      identityKeys,
      poller,
      pds,
      loading,
      error,
      groups,
      pendingWelcomes,
      keyPackagePool,
      chatListVersion,
      pollBatchSize,
      keyRotationIntervalMs,
      backupRequired,
      appViewProxy,
      serverUrl,
      gatewayUrl,
      pendingInvites,
      groupInfos,
      receivedGroupInvites,
      pendingRescueInvites,
      blockList,
      soundEnabled,
      embedMismatch,
      embedTokenApplied,
      loginStep,
      loginFormSnapshot,
      login,
      cancel2FA,
      logout,
      restoreSession,
      setupIdentity,
      declareKeys: declareKeysAction,
      backupIdentity,
      backupIdentityGuarded,
      peekBackupConflict,
      backupIdentityForced,
      restoreIdentityFromBackup,
      hasIdentityBackup,
      sendMessage,
      sendFileMessage,
      retryUploadFileMessage,
      sendReaction,
      downloadFile,
      deleteMessage,
      deleteFriend,
      markConversationAsRead,
      generateInviteQr,
      trackInvitePendingWelcome,
      deletePendingWelcome,
      acceptInviteQr,
      refreshKeyPackagePool,
      setPollBatchSize,
      setKeyRotationIntervalMs,
      setAppViewProxy,
      setServerUrl,
      setGatewayUrl,
      acceptRescueInvite,
      declineRescueInvite,
      sendRescueHandshake,
      sendGroupInvites,
      respondToGroupInvite,
      createGroupFromPendingInvites,
      cancelGroupInvite,
      addMemberToGroup,
      addAcceptedMembersToGroup,
      dissolveGroup,
      removeMemberFromGroup,
      leaveGroup,
      issueForkRuling,
      refreshBlockList,
      blockMember,
      unblockMember,
      setActiveConversation,
      setSoundEnabled,
      sendPostMessage,
      shareIntent,
      consumeShareIntent,
      startChatIntent,
      consumeStartChatIntent,
      applyEmbedToken,
    }),
    [
      session, storage, identityKeys, poller, pds, loading, error,
      groups, pendingWelcomes, keyPackagePool, chatListVersion, pollBatchSize,
      // backupRequired / keyRotationIntervalMs 必须在依赖里：轮换/备份只改
      // 这两个 state，漏掉会让 useMemo 持续吐旧值，横幅直到刷新才消失
      keyRotationIntervalMs, backupRequired, appViewProxy, serverUrl, gatewayUrl,
      pendingInvites, groupInfos, receivedGroupInvites, pendingRescueInvites, blockList, soundEnabled,
      embedMismatch, embedTokenApplied, loginStep, loginFormSnapshot,
      login, cancel2FA, logout, restoreSession, setupIdentity, declareKeysAction,
      backupIdentity, backupIdentityGuarded, peekBackupConflict, restoreIdentityFromBackup, hasIdentityBackup,
      sendMessage, sendFileMessage, retryUploadFileMessage, sendReaction, downloadFile, deleteFriend, markConversationAsRead, generateInviteQr, trackInvitePendingWelcome, deletePendingWelcome, acceptInviteQr,
      refreshKeyPackagePool, setPollBatchSize, setAppViewProxy, setServerUrl, setGatewayUrl,
      acceptRescueInvite, declineRescueInvite, sendRescueHandshake, sendGroupInvites, respondToGroupInvite, createGroupFromPendingInvites,
      cancelGroupInvite, addMemberToGroup, addAcceptedMembersToGroup, dissolveGroup, removeMemberFromGroup,
      leaveGroup, issueForkRuling, refreshBlockList, blockMember, unblockMember, setActiveConversation, setSoundEnabled,
      sendPostMessage, shareIntent, consumeShareIntent,
      startChatIntent, consumeStartChatIntent,
      applyEmbedToken,
    ],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) {
    throw new Error('useApp must be used within an AppProvider');
  }
  return ctx;
}
