/**
 * state/AppContext.tsx - 全局状态 + 动作（小程序 MVP 版）。
 *
 * 与 dme-client/src/state/AppContext.tsx 保持同名 state / action，
 * 便于页面层直接对齐；差异仅在于平台适配：
 *   - 存储：AsyncStorage -> platform/storage 的 DmeAsyncStorage
 *   - 会话：@atproto/api 的 Agent -> 自研 DmeSession（session.agent.proxy
 *     改为 session 上暴露的等价字段）
 *   - 文件/图片/表情/群聊：移到后续阶段（本文件已留出同名 action 占位，
 *     调用即抛「未实现」，避免页面层 import 失败）
 *
 * 阶段划分见 PLAN.md：
 *   Phase 6 本文（MVP：登录 / 身份 / 握手 / 1:1 文本 / 屏蔽 / 设置）
 *   Phase 2 群聊（group_* 协议）
 *   Phase 3 文件与图片
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
import Taro from '@tarojs/taro';
import type { KeyPackage, PrivateKeyPackage } from 'ts-mls';

import { DmeSession } from '../atproto/session';
import { DmePds } from '../atproto/pds';
import { declareKeys, getRemoteEncryptionKey, resolvePdsUrl } from '../atproto/did';
import { resolveHandleCached } from '../atproto/profile-cache';
import { acceptInvite, processWelcome } from '../handshake/handshake';
import { decodeAndDecryptQr } from '../handshake/qr-decode';
import { encodeQrPayload } from '../handshake/qr-encode';
import { DmePoller } from '../poll/poller';
import type { IncomingMessage, IncomingWelcome } from '../poll/poller';
import { DmeStorage } from '../storage/db';
import type { PendingWelcome, KeyPackagePoolEntry, StoredMessage, Reaction } from '../storage/db';
import { generateIdentityKeys } from '../crypto/identity';
import type { IdentityKeys } from '../crypto/identity';
import { MlsSession } from '../crypto/mls-session';
import { deliverCommitViaGroupSpace } from './commit-delivery';
import { clearBackupPassword, getBackupPassword, saveBackupPassword } from '../crypto/password-cache';
import { maybeRotateGroups, type RotationDeps } from '../crypto/rotation';
import {
  acquireBackupLock,
  acquireRotationClaim,
  deriveRotationClaimParams,
  peekCommitSeq,
  releaseBackupLock,
  releaseRotationClaim,
  type RotationClaimStore,
} from '../crypto/rotation-claim';
import { getNobleMlsImpl } from '../crypto/mls-noble-kdf';
import { KEYPACKAGE_POOL_SIZE } from '../crypto/mls-config';
import {
  generateKeyPackageForUser,
  encryptKeyPackage,
  serializeEncryptedKeyPackage,
} from '../crypto/keypackage';
import type { KeyPackagePair } from '../crypto/keypackage';
import { deriveWelcomeQueueId } from '../crypto/mls-queue-id';
import { encryptBackup, decryptBackup, computeSessionFingerprints, cloudHasUnknownSessions, type FullBackupData } from '../crypto/backup';
import { getOrCreateDeviceId, getPlatformLabel, formatDeviceLabel } from '../utils/device-id';
import { bytesToBase64url, base64urlToBytes, bytesToHex, hexToBytes } from '../crypto/utils';
import {
  generateFileId,
  generateFileKey,
  decryptChunk,
  computeSha256,
} from '../crypto/file-crypto';
import {
  FILE_CHUNK_SIZE,
  uploadFileChunks,
  downloadBlobBytes,
  type UploadFileChunksResult,
} from '../platform/file-transfer';
import { copyIntoCache, readFileChunk, writeBytesToCache } from '../platform/file-cache';
import type {
  DmeBlobRef,
  DmeEnvelope,
  FileManifestMessage,
  FileMeta,
} from '../protocol/types';
import { FILE_MANIFEST_TYPE } from '../protocol/types';
import type { BackupMeta } from '../protocol/types';
import type { ReactionMessage } from '../protocol/reaction';
import { playMessageSound } from '../utils/sound';
import {
  DME_SERVER_URL,
  PDS_URL,
  DEFAULT_APPVIEW_PROXY,
  DEFAULT_DME_GATEWAY_URL,
} from '../config';
import type {
  GroupInfo,
  PendingInvite,
  GroupMember,
  GroupDissolved,
  GroupMemberRemoved,
  GroupMemberLeft,
  GroupInviteRequest,
  GroupInviteResponse,
  GroupWelcome,
  GroupMetadataUpdate,
} from '../protocol/group-message';
import {
  createInviteRequest,
  createAcceptResponse,
  createRejectResponse,
  generateEncryptedKeyPackageForInvite,
  deserializeAcceptedKeyPackage,
  deserializeOwnKeyPackagePair,
  createGroupWithMembers,
  createGroupWelcome,
  createMetadataUpdate,
} from '../handshake/group-invite';
import { useI18n } from '../i18n/I18nContext';
import { t } from '../i18n/format';
import {
  DmeAsyncStorage as AsyncStorage,
} from '../platform/storage';

// ---------------------------------------------------------------------------
// 序列化辅助（Uint8Array <-> base64url via JSON replacer）
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
  return JSON.parse(serialized, (_k, v: unknown) => {
    if (v && typeof v === 'object' && (v as { __type?: string }).__type === 'Uint8Array') {
      const data = (v as { data: string }).data;
      return base64urlToBytes(data);
    }
    if (v && typeof v === 'object' && (v as { __type?: string }).__type === 'BigInt') {
      return BigInt((v as { data: string }).data);
    }
    return v;
  }) as T;
}

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
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

// ---------------------------------------------------------------------------
// Context 类型
// ---------------------------------------------------------------------------

interface AppState {
  session: DmeSession | null;
  storage: DmeStorage | null;
  identityKeys: IdentityKeys | null;
  /** 同步镜像：与 storage 同值，但**在同一个 await 链里立即可读**（见 storageRef 注释）。 */
  storageSync: DmeStorage | null;
  /** 同步镜像：与 identityKeys 同值，供 await 链里立即读取。 */
  identityKeysSync: IdentityKeys | null;
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
  blockList: string[];
  soundEnabled: boolean;
  /** 上次恢复会话时是否因 token 失效而失败。 */
  sessionExpired: boolean;
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
  /**
   * 仅清除会话（吊销 token + 删除本地持久化 session），**保留**身份密钥与
   * 消息库。用于 setup 页「返回登录」：若用 logout（全量清库）会连密钥一起
   * 删掉，重新登录后密钥对不上只能走恢复/重声明；若只跳转不清会话，
   * login 页 restoreSession 又会把用户弹回 setup —— 死循环。
   */
  clearSession: () => Promise<void>;
  restoreSession: () => Promise<boolean>;
  /**
   * 校验**当前内存中**的会话是否仍有效（服务端确认），失效则清会话。
   * 供已登录页面（chat-list 等）在 useDidShow 时调用，覆盖「热启动直接回到主页」
   * 这条 login 页 useEffect 永远不会跑的路径。
   */
  ensureValidSession: () => Promise<boolean>;
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
  restoreIdentityFromBackup: (password: string) => Promise<boolean>;
  hasIdentityBackup: () => Promise<boolean>;
  sendMessage: (groupId: string, text: string) => Promise<void>;
  deleteMessage: (conversationId: string, messageId: string) => Promise<void>;
  // ---- 文件消息（Phase 4B）----
  /**
   * 发送文件消息。
   * `filePath` 是 `wx.chooseMedia` / `wx.chooseMessageFile` 返回的**本地临时路径**，
   * 会先复制进 `USER_DATA_PATH` 再分块加密上传（对齐 web 的「先落盘再上传」）。
   */
  sendFileMessage: (
    conversationId: string,
    filePath: string,
    fileName: string,
    mimeType: string,
    fileSize: number,
  ) => Promise<void>;
  /** 上传失败后重试（复用本地副本，不重新选文件）。 */
  retryUploadFileMessage: (conversationId: string, msgId: string) => Promise<void>;
  /** 下载并解密文件（分片、进度、失败重试 3 次）。 */
  downloadFile: (conversationId: string, msgId: string) => Promise<void>;
  /** 发送 / 撤销表情回应（MLS 加密的 reaction 消息）。 */
  sendReaction: (conversationId: string, messageId: string, emoji: string) => Promise<void>;
  deleteFriend: (groupId: string) => Promise<void>;
  markConversationAsRead: (groupId: string) => Promise<void>;
  generateInviteQr: (bobDid: string) => Promise<{
    qrString: string;
    keyPackageInitKey: Uint8Array;
    keyPackageSerialized: string;
    welcomeQueueId: string;
  }>;
  trackInvitePendingWelcome: (
    bobDid: string,
    keyPackageSerialized: string,
    welcomeQueueId: string,
  ) => Promise<void>;
  deletePendingWelcome: (queueId: string) => Promise<void>;
  acceptInviteQr: (qrString: string) => Promise<void>;
  refreshKeyPackagePool: () => Promise<void>;
  setPollBatchSize: (size: number) => Promise<void>;
  setKeyRotationIntervalMs: (ms: number) => Promise<void>;
  setAppViewProxy: (proxy: string) => Promise<void>;
  setServerUrl: (url: string) => Promise<void>;
  setGatewayUrl: (url: string) => Promise<void>;
  refreshBlockList: () => Promise<void>;
  blockMember: (did: string) => Promise<void>;
  unblockMember: (did: string) => Promise<void>;
  setActiveConversation: (conversationId: string | null) => void;
  setSoundEnabled: (enabled: boolean) => Promise<void>;
  // ---- 群聊（Phase 3）----
  sendGroupInvites: (groupName: string, friendDids: readonly string[]) => Promise<string>;
  respondToGroupInvite: (inviteId: string, accepted: boolean) => Promise<void>;
  createGroupFromPendingInvites: (groupId: string) => Promise<void>;
  cancelGroupInvite: (inviteId: string) => Promise<void>;
  addMemberToGroup: (groupId: string, friendDid: string) => Promise<void>;
  addAcceptedMembersToGroup: (groupId: string) => Promise<void>;
  dissolveGroup: (groupId: string) => Promise<void>;
  removeMemberFromGroup: (groupId: string, memberDid: string) => Promise<void>;
  leaveGroup: (groupId: string) => Promise<void>;
  /** 手动触发一次轮询（小程序无后台推送，页面 onShow 时调用）。 */
  pollNow: () => Promise<void>;
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

  /**
   * ⚠️ 同步镜像 ref —— 解决「await 之后读到的 useState 还是旧值」的经典陷阱。
   *
   * React 的 setState 是**异步批处理**的：`login()` 内部 `await bootstrapForDid()`
   * 里调用了 `setStorage(correctStorage)`，但**同一个 tick 内** 紧接着执行的
   *   `await login(...); await setupIdentity();`
   * 读到的 `storage` 仍然是**闭包里的旧值 null**，于是抛
   *   `setupIdentity: storage 未初始化`
   * （2026-09-28 真机实测：登录成功后立刻报此错）。
   *
   * web 端不存在这个问题，因为那边 storage 是直接在 login 里 new 出来的局部变量。
   *
   * 约定：凡是「写完就要在同一次 await 链里读」的核心引用（session / storage /
   * pds / poller / identityKeys）统一走 ref 读取，state 只负责触发重渲染。
   */
  const storageRef = useRef<DmeStorage | null>(null);
  const identityKeysRef = useRef<IdentityKeys | null>(null);
  const sessionRef = useRef<DmeSession | null>(null);
  const pdsRef = useRef<DmePds | null>(null);
  const pollerRef = useRef<DmePoller | null>(null);

  /** 同步写 state + ref，避免两处不一致。 */
  const putStorage = useCallback((next: DmeStorage | null): void => {
    storageRef.current = next;
    setStorage(next);
  }, []);
  const putIdentityKeys = useCallback((next: IdentityKeys | null): void => {
    identityKeysRef.current = next;
    setIdentityKeys(next);
  }, []);
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
  const [blockList, setBlockList] = useState<string[]>([]);
  const [soundEnabled, setSoundEnabledState] = useState(true);
  const soundEnabledRef = useRef(true);
  /** 恢复会话时发现 token 已失效（用于 LoginScreen 提示）。 */
  const [sessionExpired, setSessionExpired] = useState(false);
  const [loginStep, setLoginStep] = useState<'idle' | 'loggingIn' | 'awaiting2FA'>('idle');
  const [loginFormSnapshot, setLoginFormSnapshot] = useState<{ identifier: string; password: string; pdsUrl: string } | null>(null);

  /**
   * ⚠️ 初始值**故意抛错**而不是空函数。
   *
   * poller 在 `bootstrapForDid()` 里就 `start()` 了，而首次 render 时
   * `processReceivedWelcome` 还没赋值（它在后面才被赋给本 ref）。
   * 若初始值是 `async () => {}`，poller 会认为"回调成功执行了"，
   * 于是把这条 welcome 标记为已处理 —— 消息就此静默丢失。
   * 抛错则会被 poller 的 catch 捕获 → 回滚标记 → 下一轮重试。
   */
  const processWelcomeRef = useRef<(welcome: IncomingWelcome) => Promise<void>>(
    async (welcome: IncomingWelcome) => {
      throw new Error(
        `processReceivedWelcome 尚未就绪，暂不处理 welcome ${welcome.queueId}`,
      );
    },
  );
  const handleIncomingMessageRef = useRef<
    (msg: IncomingMessage, userDid: string, storage: DmeStorage) => Promise<void>
  >(async () => {});

  /**
   * `downloadFile` 的转发 ref。
   *
   * `handleIncomingMessage` 的 deps 是 `[]`（它要挂给 poller，必须稳定），
   * 而 `downloadFile` 定义在它**之后**。收到图片时想自动下载，只能走 ref。
   * 初值为空——自动下载是**尽力而为**，未就绪时静默跳过（用户仍可手动点「下载」）。
   */
  const downloadFileRef = useRef<
    ((conversationId: string, msgId: string) => Promise<void>) | null
  >(null);

  const activeConversationRef = useRef<string | null>(null);

  const setActiveConversation = useCallback((conversationId: string | null): void => {
    activeConversationRef.current = conversationId;
  }, []);

  const setSoundEnabled = useCallback(
    async (enabled: boolean): Promise<void> => {
      if (!storage) return;
      await storage.setSoundEnabled(enabled);
      soundEnabledRef.current = enabled;
      setSoundEnabledState(enabled);
    },
    [storage],
  );

  // -------------------------------------------------------------------------
  // KeyPackage 池
  // -------------------------------------------------------------------------

  const refreshKeyPackagePool = useCallback(async (): Promise<void> => {
    if (!storage || !identityKeys || !session) return;

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

    if (needed > 0) {
      setKeyPackagePool(await storage.getKeyPackagePool());
    }
  }, [storage, identityKeys, session]);

  const setPollBatchSize = useCallback(
    async (size: number): Promise<void> => {
      if (!storage || !poller) return;
      await storage.setPollBatchSize(size);
      poller.setBatchSize(size);
      setPollBatchSizeState(size);
    },
    [storage, poller],
  );

  const setKeyRotationIntervalMs = useCallback(
    async (ms: number): Promise<void> => {
      if (!storage) return;
      await storage.setKeyRotationIntervalMs(ms);
      setKeyRotationIntervalMsState(ms);
      // 周期变更后立即重查一次（缩短周期可提前触发）
      runRotationCheckRef.current?.();
    },
    [storage],
  );

  const setAppViewProxy = useCallback(
    async (proxy: string): Promise<void> => {
      if (!storage || !pds) return;
      await storage.setAppViewProxy(proxy);
      pds.setAppViewProxy(proxy);
      setAppViewProxyState(proxy);
    },
    [storage, pds],
  );

  const setServerUrl = useCallback(
    async (url: string): Promise<void> => {
      if (!storage || !pds) return;
      await storage.setDmeServerUrl(url);
      pds.setServerUrl(url);
      setServerUrlState(url);
    },
    [storage, pds],
  );

  const setGatewayUrl = useCallback(
    async (url: string): Promise<void> => {
      if (!storage || !pds) return;
      await storage.setDmeGatewayUrl(url);
      pds.setGatewayUrl(url);
      setGatewayUrlState(url);
    },
    [storage, pds],
  );

  // -------------------------------------------------------------------------
  // 内部：按 DID 装配会话（login / restoreSession 共用）
  // -------------------------------------------------------------------------

  const bootstrapForDid = useCallback(
    async (userDid: string, activeSession: DmeSession): Promise<void> => {
      const correctStorage = new DmeStorage(userDid);
      activeSession.setStorage(correctStorage);

      const appViewProxyValue = await correctStorage.getAppViewProxy();
      const serverUrlValue = await correctStorage.getDmeServerUrl();
      const gatewayUrlValue = await correctStorage.getDmeGatewayUrl();
      const newPds = new DmePds(activeSession, serverUrlValue, gatewayUrlValue, appViewProxyValue);

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
      );

      // 恢复 MLS 会话
      const groupIds = await correctStorage.listGroups();
      const impl = await getNobleMlsImpl();
      // 僵尸群清理（与 dme-client 同步）：listGroups 是 messages ∪ mlsSession
      // 键的并集——group_welcome 重放在本机无会话时也会插入 group.joined
      // 消息（已修），产生「有消息、无会话」的僵尸群条目。只显示真正
      // 持有 MLS 会话（= 在群中）的条目。
      const sessionGroupIds: string[] = [];
      for (const gid of groupIds) {
        const serialized = await correctStorage.getMlsSession(gid);
        if (serialized) {
          sessionGroupIds.push(gid);
          try {
            const mlsSession = await MlsSession.deserialize(serialized, impl);
            newPoller.addSession(gid, mlsSession);
          } catch (err) {
            console.error('AppContext: 恢复 MLS 会话失败', gid, err);
          }
        }
      }

      // 恢复 pending welcomes
      const welcomes = await correctStorage.getPendingWelcomes();
      for (const w of welcomes) {
        newPoller.addPendingWelcome(w);
      }

      const pool = await correctStorage.getKeyPackagePool();
      const storedGroupInfos = await correctStorage.listGroupInfos();

      // 恢复群邀请：pendingInvites（我发出的）/ receivedGroupInvites（我收到的）
      // receivedGroupInvites 必须跨重启存活 —— 1:1 会话里的 group_invite 卡片要一直显示"已响应"。
      const allInvites = await reconcileStaleGroupInvites(correctStorage);
      const mySentInvites = allInvites.filter((i) => i.inviterDid === userDid);
      const myReceivedInvites = allInvites.filter((i) => i.inviteeDid === userDid);

      setSession(activeSession);
      sessionRef.current = activeSession;
      putStorage(correctStorage);
      putIdentityKeys(keys);
      setPds(newPds);
      pdsRef.current = newPds;
      setPoller(newPoller);
      pollerRef.current = newPoller;
      setGroups(sessionGroupIds);
      setPendingWelcomes(welcomes);
      setKeyPackagePool(pool);
      setPollBatchSizeState(batchSize);
      setKeyRotationIntervalMsState(rotationIntervalValue);
      setBackupRequiredState(backupRequiredValue);
      setAppViewProxyState(appViewProxyValue);
      setServerUrlState(serverUrlValue);
      setGatewayUrlState(gatewayUrlValue);
      setGroupInfos(storedGroupInfos.filter((g) => sessionGroupIds.includes(g.groupId)));
      setPendingInvites(mySentInvites);
      setReceivedGroupInvites(myReceivedInvites);
      setBlockList(await correctStorage.getBlockList());
      const soundEnabledValue = await correctStorage.getSoundEnabled();
      soundEnabledRef.current = soundEnabledValue;
      setSoundEnabledState(soundEnabledValue);
    },
    [putStorage, putIdentityKeys],
  );

  // -------------------------------------------------------------------------
  // 登录 / 登出 / 恢复
  // -------------------------------------------------------------------------

  const login = useCallback(
    async (params: LoginParams): Promise<void> => {
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

        // 迁移占位 DID 下写入的会话记录
        const allKeys = await AsyncStorage.getAllKeys();
        const placeholderPrefix = `dme:${userDidPlaceholder}:`;
        const placeholderKeys = allKeys.filter((k) => k.startsWith(placeholderPrefix));
        for (const key of placeholderKeys) {
          const value = await AsyncStorage.getItem(key);
          if (value !== null) {
            const newKey = `dme:${userDid}:${key.slice(placeholderPrefix.length)}`;
            await AsyncStorage.setItem(newKey, value);
          }
        }
        if (placeholderKeys.length > 0) {
          await Promise.all(placeholderKeys.map((key) => AsyncStorage.removeItem(key)));
        }

        await bootstrapForDid(userDid, newSession);
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
  },
  [language, bootstrapForDid],
);

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
      // 1.2：登出清除密码缓存（内存），换账号不残留
      await clearBackupPassword();
    } catch (err) {
      console.error('登出失败:', err);
    } finally {
      // state 与 ref 必须同步清空，否则下一次 await 链里会读到已登出的影子实例
      setSession(null);
      putStorage(null);
      putIdentityKeys(null);
      setPds(null);
      setPoller(null);
      sessionRef.current = null;
      pdsRef.current = null;
      pollerRef.current = null;
      setError(null);
      setGroups([]);
      setPendingWelcomes([]);
      setKeyPackagePool([]);
      setGroupInfos([]);
      setPollBatchSizeState(3);
      setKeyRotationIntervalMsState(7 * 24 * 60 * 60 * 1000);
      setBackupRequiredState(false);
      setAppViewProxyState(DEFAULT_APPVIEW_PROXY);
      setServerUrlState(DME_SERVER_URL);
      setGatewayUrlState(DEFAULT_DME_GATEWAY_URL);
      setBlockList([]);
      setLoginStep('idle');
      setLoginFormSnapshot(null);
      setLoading(false);
      setChatListVersion((v) => v + 1);
    }
  }, [session, storage, poller]);

  /** 仅清会话：吊销 token + 删本地 session 持久化，保留密钥/消息/偏好。 */
  const clearSession = useCallback(async (): Promise<void> => {
    try {
      poller?.stop();
      if (session) {
        await session.logout(storage ?? undefined);
      }
    } catch (err) {
      console.error('clearSession 失败（忽略，继续回登录页）:', err);
    } finally {
      // session 必须清（否则 login 页底部还会显示已登录 hint、
      // 各页面仍能读到影子会话）；storage/identityKeys 保留。
      setSession(null);
      setPds(null);
      setPoller(null);
      sessionRef.current = null;
      pdsRef.current = null;
      pollerRef.current = null;
      setError(null);
      setSessionExpired(false);
      setLoginStep('idle');
      setLoginFormSnapshot(null);
    }
  }, [session, storage, poller]);

  const restoreSession = useCallback(async (): Promise<boolean> => {
    setLoading(true);
    setError(null);

    try {
      const keys = await AsyncStorage.getAllKeys();
      const sessionKeys = keys.filter((k) => k.startsWith('dme:') && k.endsWith(':session'));
      if (sessionKeys.length === 0) return false;

      const nonPlaceholderKeys = sessionKeys.filter((k) => !k.includes('did:plc:unknown'));
      const keysToProcess = nonPlaceholderKeys.length > 0 ? nonPlaceholderKeys : sessionKeys;

      for (const key of keysToProcess) {
        // key 形如 `dme:<did>:session`，切掉前缀 4 字符与后缀 `:session` 8 字符
        const did = key.slice(4, -8);
        const tempStorage = new DmeStorage(did);
        const tempSession = new DmeSession();
        const restored = await tempSession.restore(tempStorage);
        if (!restored) continue;

        // ⚠️ restore() 只读本地、不碰网络，过期/被吊销的 token 在本地"看起来"完全正常。
        //    这里做一次服务端校验（内部会在 accessJwt 过期时静默刷新）。
        //    校验不通过 → 跳过该账号并继续找下一个，全都不行则返回 false，
        //    让 LoginScreen 显示登录页（而不是进去后一操作就 401）。
        const tokenOk = await tempSession.validateAccessToken();
        if (!tokenOk) {
          console.warn('restoreSession: token 已失效，跳过该会话:', did);
          // 记下来让 LoginScreen 提示"登录已过期"，而不是无声地弹回登录页
          setSessionExpired(true);
          continue;
        }

        await bootstrapForDid(did, tempSession);
        return true;
      }

      return false;
    } catch (err) {
      setError(err instanceof Error ? err.message : t(language, 'login.restoreFailed'));
      return false;
    } finally {
      setLoading(false);
    }
  }, [language, bootstrapForDid]);

  /**
   * 校验当前会话是否仍有效，失效则清空并标记 sessionExpired。
   *
   * 为什么单独要这个：`restoreSession()` 只在 **login 页挂载** 时调用。但小程序
   * 有两条路径会**绕过 login 页**直接落在 chat-list 上：
   *   1. 热启动 —— 小程序还在后台，用户再次点开，微信直接恢复到**当前页**（chat-list），
   *      login 页的 useEffect 根本不会执行；
   *   2. chat-list 里 `if (session) { setReady(true); return; }` 的短路 ——
   *      内存里已有 session 就直接放行，**从不做服务端校验**（这正是"token 过期
   *      却仍然进了主页"的直接原因）。
   *
   * 所以需要在已登录页面每次 `useDidShow` 时主动校验一次。
   * 校验成本很低（一次 getSession），但能保证"过期 token → 回登录页"。
   */
  const ensureValidSession = useCallback(async (): Promise<boolean> => {
    const current = session;
    if (!current) return false;

    const ok = await current.validateAccessToken();
    if (!ok) {
      console.warn('ensureValidSession: token 已失效，登出并回登录页');
      setSession(null);
      putStorage(null);
      putIdentityKeys(null);
      setPoller(null);
      setPds(null);
      sessionRef.current = null;
      pdsRef.current = null;
      pollerRef.current = null;
      setSessionExpired(true);
      return false;
    }
    return true;
  }, [session, putStorage, putIdentityKeys]);

  // -------------------------------------------------------------------------
  // 身份
  // -------------------------------------------------------------------------

  /**
   * 确保本地存在身份密钥（没有就生成并落盘）。
   *
   * ⚠️ 为什么读 ref 而不是 state：
   *   登录页的调用链是 `await login(...)` → `await setupIdentity()`，两句话在
   *   **同一个 tick**。`login()` 内部的 `setStorage(...)` 是异步批处理的，此时
   *   `storage` 这个闭包变量**仍是 null**，直接 `if (!storage) throw` 就会在
   *   「登录成功」之后立刻炸出 `setupIdentity: storage 未初始化`（2026-09-28 真机）。
   *   改成 `storageRef.current`（同步赋值）即可读到刚装配好的实例。
   *
   *   兜底：ref 也为空时，尝试从 session 自己持有的 storage 取
   *   （`bootstrapForDid` 里调过 `activeSession.setStorage(correctStorage)`）。
   */
  const setupIdentity = useCallback(async (): Promise<void> => {
    // 三级兜底，全部走「同步可读」的引用，不依赖 React state 的提交时机：
    //   1. storageRef —— bootstrapForDid 装配时同步写入（正常路径）
    //   2. sessionRef.boundStorage —— DmeSession 自己绑定的存储
    //   3. 已完成 DmeStorage 的构造（只要有 DID 就能建）
    const activeStorage =
      storageRef.current ?? sessionRef.current?.boundStorage ?? null;

    // 已有内存中的密钥：确保持久化后直接返回（幂等）
    if (identityKeysRef.current) {
      if (activeStorage) await activeStorage.putIdentityKeys(identityKeysRef.current);
      return;
    }
    if (!activeStorage) throw new Error('setupIdentity: storage 未初始化');

    const stored = await activeStorage.getIdentityKeys();
    if (stored) {
      putIdentityKeys(stored);
      return;
    }

    const keys = generateIdentityKeys();
    await activeStorage.putIdentityKeys(keys);
    putIdentityKeys(keys);
  }, [putIdentityKeys]);

  const declareKeysAction = useCallback(
    async (plcToken: string): Promise<void> => {
      const activeKeys = identityKeysRef.current ?? identityKeys;
      const activeSession = sessionRef.current ?? session;

      if (!activeKeys) throw new Error('declareKeys: 身份密钥不可用');
      if (!activeSession) throw new Error('declareKeys: 会话未初始化');

      await declareKeys(activeSession.did, activeKeys, activeSession, plcToken);
    },
    [identityKeys, session],
  );

  // -------------------------------------------------------------------------
  // 身份备份
  // -------------------------------------------------------------------------

  const backupIdentity = useCallback(
    async (password: string): Promise<void> => {
      // 与 setupIdentity 同理：这些 action 常在 await 链里被调用，
      // 读 ref 才能拿到刚装配好的实例，避免误报"未初始化"。
      const activeStorage = storageRef.current ?? storage;
      const activeKeys = identityKeysRef.current ?? identityKeys;
      const activePds = pdsRef.current ?? pds;

      if (!activeKeys) throw new Error('backupIdentity: 身份密钥不可用');
      if (!activePds) throw new Error('backupIdentity: pds 未初始化');
      if (!activeStorage) throw new Error('backupIdentity: storage 未初始化');

      // 缺口③配套：本机存在 sibling-rotated 会话时，本机状态落后于兄弟端，
      // 此时备份会用旧状态覆盖云端备份（云端可能已由兄弟端刷新为包含其推进
      // 的新状态）。正确顺序是先「从备份恢复」，恢复完成后再备份。
      for (const gid of await activeStorage.listGroups()) {
        if ((await activeStorage.getSessionIssue(gid)) === 'sibling-rotated') {
          throw new Error('BACKUP_BLOCKED_STALE');
        }
      }

      const groupIds = await activeStorage.listGroups();
      const mlsSessions: Record<string, string> = {};
      const rotationAt: Record<string, number> = {};
      for (const gid of groupIds) {
        const serialized = await activeStorage.getMlsSession(gid);
        if (serialized) mlsSessions[gid] = serialized;
        rotationAt[gid] = await activeStorage.getLastRotationAt(gid);
      }

      const data: FullBackupData = {
        identity: activeKeys,
        mlsSessions,
        keyPackagePool: await activeStorage.getKeyPackagePool(),
        groupInfos: await activeStorage.listGroupInfos(),
        blockList: await activeStorage.getBlockList(),
        rotationAt,
        commitSeq: await activeStorage.getCommitSeq(),
      };

      const encryptedData = encryptBackup(data, password);
      // 方案C外层元数据：设备短码 + 平台 + 会话指纹。只供覆盖提示与展示，
      // 恢复流程不读它；构建失败不应阻断备份本体（元数据尽力而为）。
      let meta: BackupMeta | undefined;
      try {
        meta = {
          deviceId: await getOrCreateDeviceId(),
          platform: getPlatformLabel(),
          sessionFps: computeSessionFingerprints(groupIds, activeKeys.signing.privateKey),
        };
      } catch (metaErr) {
        console.warn('[dme:backup] 构建 meta 失败，降级无 meta 写入:', metaErr);
      }
      await activePds.putIdentityBackup(encryptedData, meta);

      // 1.2：备份成功即记住密码（小程序仅会话内存），供轮换后静默刷新备份（1.5）；
      // 并清除「必须备份」强提示标记
      await saveBackupPassword(password);
      await activeStorage.setBackupRequired(false);
      setBackupRequiredState(false);
    },
    [identityKeys, pds, storage],
  );

  // 缺口①：所有推进会话状态的动作（轮换 / 握手接会话）之后统一走这里的
  // 备份联动——云端备份必须始终包含最新推进，否则兄弟端按 sibling-rotated
  // 提示恢复时会倒灌旧状态（把新握手 / 新轮换抹掉，实测踩过）。
  const triggerBackupAfterAdvance = useCallback(
    async (tag: string): Promise<void> => {
      const activeStorage = storageRef.current ?? storage;
      const activePds = pdsRef.current ?? pds;
      const activeKeys = identityKeysRef.current ?? identityKeys;
      if (!activeStorage || !activePds || !activeKeys) return;
      try {
        const cachedPassword = await getBackupPassword();
        if (cachedPassword) {
          // 方案C：写入前比对外层元数据指纹——云端有本机没有的会话时跳过
          // 自动写入（无人值守场景不能覆盖掉兄弟端刚写的新备份），置
          // backupRequired 引导手动备份（手动入口有确认弹窗把关）。
          // 无差异 / 云端是自己写的 / 元数据缺失（旧记录或读取失败）→
          // 正常写入，绝不阻断。比对失败也放行（尽力而为）。
          try {
            const record = await activePds.getIdentityBackupRecord();
            const meta = record?.meta;
            if (
              meta &&
              meta.deviceId !== (await getOrCreateDeviceId()) &&
              cloudHasUnknownSessions(meta, await activeStorage.listGroups(), activeKeys.signing.privateKey)
            ) {
              console.warn(
                `[dme:backup] 云端备份（由 ${formatDeviceLabel(meta)} 写入）含本机没有的会话，${tag} 后自动刷新跳过，待手动处理`,
              );
              await activeStorage.setBackupRequired(true);
              setBackupRequiredState(true);
              return;
            }
          } catch (peekErr) {
            console.warn('[dme:backup] 覆盖提示比对失败，继续自动备份:', peekErr);
          }
          await backupIdentity(cachedPassword);
          console.log(`[dme:backup] ${tag} 后已静默刷新备份`);
        } else {
          await activeStorage.setBackupRequired(true);
          setBackupRequiredState(true);
        }
      } catch (err) {
        // 刷新失败仅 log（不影响推进结果）。若是因存在待恢复会话被拒
        // （BACKUP_BLOCKED_STALE），sibling-rotated 横幅本就在引导恢复。
        console.warn(`[dme:backup] ${tag} 后备份刷新失败:`, err);
      }
    },
    [storage, backupIdentity],
  );

  /** 覆盖提示（方案C）：见 AppActions.peekBackupConflict 注释。 */
  const peekBackupConflict = useCallback(
    async (): Promise<{ conflict: boolean; deviceLabel: string; writtenAt: string } | null> => {
      const activeStorage = storageRef.current ?? storage;
      const activePds = pdsRef.current ?? pds;
      const activeKeys = identityKeysRef.current ?? identityKeys;
      if (!activeStorage || !activePds || !activeKeys) return null;
      try {
        const record = await activePds.getIdentityBackupRecord();
        const meta = record?.meta;
        if (!meta) return null; // 旧记录 / 无元数据：无从判断，降级放行
        const conflict =
          meta.deviceId !== (await getOrCreateDeviceId()) &&
          cloudHasUnknownSessions(meta, await activeStorage.listGroups(), activeKeys.signing.privateKey);
        return {
          conflict,
          deviceLabel: formatDeviceLabel(meta),
          writtenAt: record?.createdAt ?? '',
        };
      } catch {
        return null; // 读取失败：提示尽力而为，绝不阻断
      }
    },
    [pds, identityKeys, storage],
  );

  /**
   * 宣言门禁（约定7/8/9，2026-10-15 破例全量接入）：本账号任何 commit 型
   * 备份点动作（轮换/建群/踢人/拉人/退群清理/扫码握手/点接受群邀请）的
   * 前置检查。账号级单调 commit 高水位仲裁：
   * 返回应写入的高水位 seq，调用方在 commit 投递成功后 setCommitSeq；
   * 返回 null = 拒绝执行——taken/stale（其他端已推进/备份分叉）已置
   * sibling-rotated 提示恢复最新备份；PDS 不可用 fail-closed（不置标记、
   * 不动作，下个时机重试，绝不无仲裁 commit）。
   */
  const acquireClaimForCommit = useCallback(
    async (groupId: string, epoch: number): Promise<number | null> => {
      const activeStorage = storageRef.current ?? storage;
      const activePds = pdsRef.current ?? pds;
      const activeKeys = identityKeysRef.current ?? identityKeys;
      if (!activeStorage || !activePds || !activeKeys) return null;
      const params = await deriveRotationClaimParams(activeKeys.signing.publicKey);
      const store: RotationClaimStore = {
        get: (rkey) => activePds.getRotationClaim(rkey),
        put: (rkey, payload, expectedCid) => activePds.putRotationClaim(rkey, payload, expectedCid),
        del: (rkey, expectedCid) => activePds.deleteRotationClaim(rkey, expectedCid),
      };
      try {
        const { verdict, seq } = await acquireRotationClaim(
          params,
          { groupId, epoch, localSeq: await activeStorage.getCommitSeq() },
          store,
        );
        if (verdict === 'acquired') return seq;
        console.warn(`[dme:claim] 宣言${verdict}: 禁止 commit，需恢复备份`, groupId);
        await activeStorage.setSessionIssue(groupId, 'sibling-rotated');
        return null;
      } catch (err) {
        console.warn('[dme:claim] 宣言检查失败，fail-closed（不 commit）', groupId, err);
        return null;
      }
    },
    [storage, pds, identityKeys],
  );

  /** 释放宣言：commit/投递失败回滚时调用，避免虚高水位（尽力而为）。 */
  const releaseClaim = useCallback(async (): Promise<void> => {
    const activePds = pdsRef.current ?? pds;
    const activeKeys = identityKeysRef.current ?? identityKeys;
    if (!activePds || !activeKeys) return;
    const params = await deriveRotationClaimParams(activeKeys.signing.publicKey);
    const store: RotationClaimStore = {
      get: (rkey) => activePds.getRotationClaim(rkey),
      put: (rkey, payload, expectedCid) => activePds.putRotationClaim(rkey, payload, expectedCid),
      del: (rkey, expectedCid) => activePds.deleteRotationClaim(rkey, expectedCid),
    };
    await releaseRotationClaim(params, store);
  }, [pds, identityKeys]);

  /**
   * 手动备份（约定：任何备份点都必须先遵守宣言）——与 client 同语义：
   * 宣言仲裁 busy/stale 一律拒绝并提示；通过则持锁备份 + 完成后恢复占用
   * 前的记录（备份不推进账号状态，兄弟端 commit 的高水位必须原样保留）。
   * PDS 不可用 fail-closed：无法仲裁时宁可不备份。
   */
  const backupIdentityGuarded = useCallback(
    async (password: string): Promise<void> => {
      const activeStorage = storageRef.current ?? storage;
      const activePds = pdsRef.current ?? pds;
      const activeKeys = identityKeysRef.current ?? identityKeys;
      if (!activeStorage) throw new Error('backupIdentityGuarded: storage 未初始化');
      if (!activePds) throw new Error('backupIdentityGuarded: pds 未初始化');
      if (!activeKeys) throw new Error('backupIdentityGuarded: 身份密钥不可用');
      const params = await deriveRotationClaimParams(activeKeys.signing.publicKey);
      const store: RotationClaimStore = {
        get: (rkey) => activePds.getRotationClaim(rkey),
        put: (rkey, payload, expectedCid) => activePds.putRotationClaim(rkey, payload, expectedCid),
        del: (rkey, expectedCid) => activePds.deleteRotationClaim(rkey, expectedCid),
      };
      const outcome = await acquireBackupLock(params, await activeStorage.getCommitSeq(), store);
      if (outcome.verdict !== 'acquired') {
        throw new Error(outcome.verdict === 'busy' ? 'BACKUP_CLAIM_BUSY' : 'BACKUP_CLAIM_STALE');
      }
      const { handle } = outcome;
      try {
        await backupIdentity(password);
      } finally {
        await releaseBackupLock(handle, store);
      }
    },
    [storage, pds, identityKeys, backupIdentity],
  );

  /**
   * 强制备份（接管高水位）：与 client 同语义——最新密钥材料因忘记备份
   * 丢失时宣言 stale 永久阻断正常备份，本机再也无法追平高水位。不删除
   * 宣言（保单调性、避免无仲裁窗口、僵尸端归来仍能被 stale 拦截）：改为
   * 读取 PDS 高水位并接管为本地 commitSeq，再走正常持锁备份。云端备份
   * 会被本机较旧的状态覆盖且不可逆——调用方必须已获得用户明确确认。
   * PDS 不可用/读取失败 fail-closed（peekCommitSeq 抛出即中止）。
   */
  const backupIdentityForced = useCallback(
    async (password: string): Promise<void> => {
      const activeStorage = storageRef.current ?? storage;
      const activeKeys = identityKeysRef.current ?? identityKeys;
      if (!activeStorage) throw new Error('backupIdentityForced: storage 未初始化');
      if (!activeKeys) throw new Error('backupIdentityForced: 身份密钥不可用');
      const params = await deriveRotationClaimParams(activeKeys.signing.publicKey);
      const store: RotationClaimStore = {
        get: (rkey) => (pdsRef.current ?? pds)!.getRotationClaim(rkey),
        put: (rkey, payload, expectedCid) => (pdsRef.current ?? pds)!.putRotationClaim(rkey, payload, expectedCid),
        del: (rkey, expectedCid) => (pdsRef.current ?? pds)!.deleteRotationClaim(rkey, expectedCid),
      };
      const cloudSeq = await peekCommitSeq(params, store);
      if (cloudSeq !== null && cloudSeq > (await activeStorage.getCommitSeq())) {
        await activeStorage.setCommitSeq(cloudSeq);
        console.warn('[dme:claim] forced backup: adopted PDS high watermark', cloudSeq);
      }
      await backupIdentityGuarded(password);
    },
    [storage, pds, identityKeys, backupIdentityGuarded],
  );

  const restoreIdentityFromBackup = useCallback(
    async (password: string): Promise<boolean> => {
      const activeStorage = storageRef.current ?? storage;
      const activePds = pdsRef.current ?? pds;
      const activePoller = pollerRef.current ?? poller;

      if (!activePds) throw new Error('restoreIdentityFromBackup: pds 未初始化');
      if (!activeStorage) throw new Error('restoreIdentityFromBackup: storage 未初始化');
      if (!activePoller) throw new Error('restoreIdentityFromBackup: poller 未初始化');

      const encryptedData = await activePds.getIdentityBackup();
      if (!encryptedData) return false;

      const data = decryptBackup(encryptedData, password);

      // 缺口③护栏：对每个 sibling-rotated 会话，云端备份必须确实包含
      // 兄弟端推进后的新状态——若备份里该会话与本机状态完全相同（备份
      // 停留在推进之前）或根本没有该会话，恢复只会倒灌旧状态（实测踩过：
      // 把重新握手的新会话覆盖回脱钩状态）。此时应先在已更新的设备上
      // 重新备份。以「备份内容 ≠ 本机（落后的）内容」作为"备份包含
      // 推进"的充分条件。
      const staleGroupIds: string[] = [];
      for (const gid of await activeStorage.listGroups()) {
        if ((await activeStorage.getSessionIssue(gid)) !== 'sibling-rotated') continue;
        const localSerialized = await activeStorage.getMlsSession(gid);
        if (!localSerialized) continue; // 本机无此会话状态，无从比对
        const backupSerialized = data.mlsSessions[gid];
        if (!backupSerialized || backupSerialized === localSerialized) {
          staleGroupIds.push(gid);
        }
      }
      if (staleGroupIds.length > 0) {
        throw new Error('RESTORE_BACKUP_STALE');
      }

      await activeStorage.putIdentityKeys(data.identity);
      putIdentityKeys(data.identity);

      // 全量收敛：以云端备份为权威快照，删除本机多出来的会话。备份不含
      // 信令的账号级事实（如单方面删除好友）只能靠备份携带——恢复若只做
      // 合并，本机残留的会话会让已删好友复活（实测：a 删好友并备份，b 恢复
      // 后好友仍在列表且仍可解密收发）。连带清理消息、轮换时间戳、poller
      // 会话与孤儿群元数据；sessionIssue / queueId LRU 下面已有全局清理。
      const backupGroupIds = new Set(Object.keys(data.mlsSessions));
      for (const gid of await activeStorage.listGroups()) {
        if (backupGroupIds.has(gid)) continue;
        activePoller.removeSession(gid);
        await activeStorage.deleteMlsSession(gid);
        await activeStorage.deleteMessages(gid);
        await activeStorage.deleteRaw(`rotationAt:${gid}`);
        console.info('restoreIdentityFromBackup: removed local group not in backup', gid);
      }
      for (const info of await activeStorage.listGroupInfos()) {
        if (!backupGroupIds.has(info.groupId)) {
          await activeStorage.deleteGroupInfo(info.groupId);
        }
      }

      // 恢复账号级 commit 高水位（宣言 v2 比对基准；旧备份无此字段 → 0）
      await activeStorage.setCommitSeq(data.commitSeq ?? 0);

      for (const [groupId, serialized] of Object.entries(data.mlsSessions)) {
        await activeStorage.putMlsSession(groupId, serialized);
        // 同时写回轮换时间戳——否则多端同时恢复后 lastRotationAt 全部归零，
        // 又同时到期、同时轮换、再撞槽（备份无此字段的旧格式视为 0，向后兼容）
        await activeStorage.setLastRotationAt(groupId, data.rotationAt?.[groupId] ?? 0);
        try {
          const impl = await getNobleMlsImpl();
          const mlsSession = await MlsSession.deserialize(serialized, impl);
          activePoller.addSession(groupId, mlsSession);
        } catch (err) {
          console.error('restoreIdentityFromBackup: 加载 MLS 会话失败', groupId, err);
        }
      }

      await activeStorage.putKeyPackagePool(data.keyPackagePool);
      setKeyPackagePool(data.keyPackagePool);

      for (const info of data.groupInfos) {
        await activeStorage.putGroupInfo(info);
      }
      setGroupInfos(data.groupInfos);

      await activeStorage.setBlockList(data.blockList);
      setBlockList(data.blockList);

      await activeStorage.setCommitSeq(data.commitSeq ?? 0);

      // 缺口⑨修复：恢复后状态整体重建，旧的脱钩/兄弟轮换标记作废；
      // 必须在 setChatListVersion 之前清，否则 chat-list 页面 effect 监听
      // chatListVersion 首次跑会读到 storage 旧标记写进 React state，之
      // 后没人再触发 setChatListVersion 重跑（收发正常路径不触发）→ 横
      // 幅永久卡住直到下次输密码恢复
      await activeStorage.clearAllSessionIssues();
      // 缺口⑨修复：清空 queueId LRU 去重集合。b 端 web 之前用过 DME
      // 时本机已用旧 mlsSession decrypt 过 a 端的 envelope，processed
      // 集合残留在 storage；输密码恢复后 mlsSession 来自备份（a 端建
      // 群那一刻），旧 envelope 被 isQueueIdProcessed 命中直接跳过 →
      // mlsSession 永远不推进 → exporterSecret 永远停在备份那一刻 →
      // 后续 envelope 永远拉不到 → b 端自己发消息也用旧 mlsSession，
      // a 端解不开。清空后 b 端重新 decrypt 这些 envelope：commit
      // wrapper 推进 mlsSession（自愈），群消息正常入屏。
      await activeStorage.clearQueueIdLru();

      setGroups(Object.keys(data.mlsSessions));
      setChatListVersion((v) => v + 1);

      // 备份不含邀请状态：恢复后立即收敛本地残留的 pending 邀请（群会话
      // 已随备份恢复，残留记录会让邀请卡片复活），并同步界面状态
      const reconciledInvites = await reconcileStaleGroupInvites(
        activeStorage,
      );
      setReceivedGroupInvites(
        reconciledInvites.filter((i) => i.inviteeDid === (sessionRef.current ?? session)?.did),
      );
      // 1.2：恢复时也输过密码，同样记住（用户拍板）
      await saveBackupPassword(password);
      await activeStorage.setBackupRequired(false);
      setBackupRequiredState(false);

      return true;
    },
    [pds, storage, poller, putIdentityKeys, session],
  );

  const hasIdentityBackup = useCallback(async (): Promise<boolean> => {
    const activePds = pdsRef.current ?? pds;
    if (!activePds) return false;
    const data = await activePds.getIdentityBackup();
    return data !== null;
  }, [pds]);

  // -------------------------------------------------------------------------
  // 定期密钥轮换（key-rotation-plan.md 1.3 / 1.5，Phase 2 移植）
  // -------------------------------------------------------------------------

  const runRotationCheck = useCallback((): void => {
    const activeStorage = storageRef.current ?? storage;
    const activePds = pdsRef.current ?? pds;
    const activePoller = pollerRef.current ?? poller;
    const activeKeys = identityKeysRef.current ?? identityKeys;
    if (!session || !activeStorage || !activePds || !activePoller || !activeKeys) return;
    const deps: RotationDeps = {
      listGroupIds: () => activeStorage.listGroups(),
      getSession: (groupId) => activePoller.getSession(groupId),
      reloadSession: async (groupId, serialized) => {
        const impl = await getNobleMlsImpl();
        const restored = await MlsSession.deserialize(serialized, impl);
        activePoller.addSession(groupId, restored);
      },
      putMlsSession: (groupId, serialized) => activeStorage.putMlsSession(groupId, serialized),
      createEnvelope: (envelope) => activePds.createEnvelope(envelope),
      getIntervalMs: () => activeStorage.getKeyRotationIntervalMs(),
      getLastRotationAt: (groupId) => activeStorage.getLastRotationAt(groupId),
      setLastRotationAt: (groupId, ts) => activeStorage.setLastRotationAt(groupId, ts),
      // 缺口②：带异常标记的会话不参与轮换——状态已废，且克隆端一端轮换会
      // 在所有兄弟端触发 sibling-rotated 横幅风暴（实测踩过）
      getSessionIssue: (groupId) => activeStorage.getSessionIssue(groupId),
      claimStore: {
        get: (rkey) => activePds.getRotationClaim(rkey),
        put: (rkey, payload, expectedCid) => activePds.putRotationClaim(rkey, payload, expectedCid),
        del: (rkey, expectedCid) => activePds.deleteRotationClaim(rkey, expectedCid),
      } as RotationClaimStore,
      // 宣言 v2：账号级单调 commit 高水位（本地计数随备份走）
      getCommitSeq: () => activeStorage.getCommitSeq(),
      setCommitSeq: (seq) => activeStorage.setCommitSeq(seq),
      getIdentitySigningPublicKey: async () => activeKeys.signing.publicKey,
      onRotated: async (groupId) => {
        // 1.5 备份联动（统一走 triggerBackupAfterAdvance）：有缓存密码 →
        // 静默刷新备份；无 → 置强提示标记。
        await triggerBackupAfterAdvance(`轮换 ${groupId}`);
      },
      onAborted: (groupId, reason) => {
        console.warn('[dme:rotation] 轮换中止', groupId, reason);
        // sibling-rotated 与 stale（宣言 v2 检测到的备份分叉/对端已认领）
        // 恢复路径一致：本机落后，宣言失败即提示恢复最新备份（约定9）
        void activeStorage.setSessionIssue(groupId, 'sibling-rotated');
      },
    };
    maybeRotateGroups(deps);
  }, [session, storage, pds, poller, identityKeys, triggerBackupAfterAdvance]);

  const runRotationCheckRef = useRef<(() => void) | null>(null);
  runRotationCheckRef.current = runRotationCheck;

  useEffect(() => {
    if (!poller) return;
    // 小程序无全局 AppState：启动后延迟首检 + 定时检查；
    // 页面层可在 useDidShow 里调用 runRotationCheck 补充前台触发
    const initial = setTimeout(() => runRotationCheck(), 60_000);
    const periodic = setInterval(() => runRotationCheck(), 30 * 60 * 1000);
    return () => {
      clearTimeout(initial);
      clearInterval(periodic);
    };
  }, [runRotationCheck, poller]);

  // -------------------------------------------------------------------------
  // 邀请 / 接受（1:1 握手）
  // -------------------------------------------------------------------------

  const generateInviteQr = useCallback(
    async (
      bobDid: string,
    ): Promise<{
      qrString: string;
      keyPackageInitKey: Uint8Array;
      keyPackageSerialized: string;
      welcomeQueueId: string;
    }> => {
      if (!storage || !identityKeys || !session) {
        throw new Error('generateInviteQr: 尚未完全初始化');
      }

      await refreshKeyPackagePool();
      const pool = await storage.getKeyPackagePool();
      const available = pool.find((e) => !e.consumed);
      if (!available) throw new Error('generateInviteQr: KeyPackage 池中没有可用条目');

      const pair: KeyPackagePair = {
        publicPackage: deserializeWithUint8Array<KeyPackage>(available.publicPackageSerialized),
        privatePackage: deserializeWithUint8Array<PrivateKeyPackage>(
          available.privatePackageSerialized,
        ),
      };

      const bobEncKey = await getRemoteEncryptionKey(bobDid);
      if (!bobEncKey) throw new Error('generateInviteQr: 对方未声明 DME 加密公钥');

      const encrypted = await encryptKeyPackage(pair.publicPackage, bobEncKey);
      const encryptedKeyPackage = serializeEncryptedKeyPackage(
        encrypted.ephemeralPublicKey,
        encrypted.ciphertext,
      );
      const qrString = encodeQrPayload({ encryptedKeyPackage, aliceDid: session.did });
      const keyPackageInitKey = pair.publicPackage.initKey;
      const keyPackageSerialized = serializeWithUint8Array(pair);
      const welcomeQueueId = deriveWelcomeQueueId(keyPackageInitKey);

      // 该 KeyPackage 与本次二维码绑定，标记为已消费
      await storage.markKeyPackageConsumed(available.id);
      setKeyPackagePool(await storage.getKeyPackagePool());

      return { qrString, keyPackageInitKey, keyPackageSerialized, welcomeQueueId };
    },
    [storage, identityKeys, session, refreshKeyPackagePool],
  );

  const trackInvitePendingWelcome = useCallback(
    async (
      bobDid: string,
      keyPackageSerialized: string,
      welcomeQueueId: string,
    ): Promise<void> => {
      if (!storage || !poller) throw new Error('trackInvitePendingWelcome: 尚未完全初始化');

      const entry: PendingWelcome = {
        queueId: welcomeQueueId,
        groupId: bobDid,
        keyPackageSerialized,
        createdAt: new Date().toISOString(),
      };
      await storage.putPendingWelcome(entry);
      poller.addPendingWelcome(entry);
      setPendingWelcomes((prev) => [...prev, entry]);
    },
    [storage, poller],
  );

  const deletePendingWelcome = useCallback(
    async (queueId: string): Promise<void> => {
      if (!storage || !poller) throw new Error('deletePendingWelcome: 尚未完全初始化');

      await storage.deletePendingWelcome(queueId);
      poller.removePendingWelcome(queueId);
      setPendingWelcomes((prev) => prev.filter((w) => w.queueId !== queueId));
    },
    [storage, poller],
  );

  const acceptInviteQr = useCallback(
    async (qrString: string): Promise<void> => {
      if (!storage || !identityKeys || !session || !pds || !poller) {
        throw new Error('acceptInviteQr: 尚未完全初始化');
      }

      // 宣言门禁（约定7）：建立 1v1 会话（备份点）前必须先宣言——同账号
      // 多端同时扫同一码会各自生成不同叶密钥、同 groupId 状态分叉；
      // taken/stale 已置 sibling-rotated 提示恢复备份，fail-closed 放弃本次添加
      const { aliceDid } = await decodeAndDecryptQr(qrString, identityKeys.encryption.privateKey);
      const claimSeq = await acquireClaimForCommit(aliceDid, 0);
      if (claimSeq === null) {
        throw new Error('acceptInviteQr: 宣言被拒（需恢复备份或 PDS 不可用）');
      }

      let result: Awaited<ReturnType<typeof acceptInvite>>;
      try {
        result = await acceptInvite(session.did, identityKeys, qrString);
      } catch (err) {
        await releaseClaim();
        throw err;
      }

      await storage.putMlsSession(result.groupId, result.mlsSession.serialize());
      poller.addSession(result.groupId, result.mlsSession);
      await storage.setCommitSeq(claimSeq);

      // 缺口①：握手推进了会话状态，立即联动备份——保证兄弟端之后恢复
      // 备份时拿到的是新会话，而不是被倒灌回旧状态
      await triggerBackupAfterAdvance(`acceptInvite ${result.groupId}`);

      const envelope: DmeEnvelope = {
        $type: 'dme.queue.envelope',
        queueId: result.welcomeQueueId,
        payload: result.welcomePayload,
        createdAt: new Date().toISOString(),
        messageType: 'welcome',
      };
      await pds.createEnvelope(envelope);

      setGroups((prev) => (prev.includes(result.groupId) ? prev : [...prev, result.groupId]));
      setChatListVersion((v) => v + 1);
    },
    [storage, identityKeys, session, pds, poller, triggerBackupAfterAdvance, acquireClaimForCommit, releaseClaim],
  );

  // -------------------------------------------------------------------------
  // 处理收到的 Welcome（poller 回调）
  // -------------------------------------------------------------------------

  const processReceivedWelcome = useCallback(
    async (welcome: IncomingWelcome): Promise<void> => {
      // ⚠️ 全部读 ref 而非 state：poller 在 bootstrapForDid() 里就启动了，
      //    首个 welcome 可能在 React state 提交之前就到了（2026-09-28 真机）。
      //    早前这里读 state 拿到 null 直接 return，而 poller 那边已经先把
      //    queueId 标成"已处理"，welcome 就此永久丢失。
      const activeStorage = storageRef.current ?? storage;
      const activeKeys = identityKeysRef.current ?? identityKeys;
      const activeSession = sessionRef.current ?? session;
      const activePoller = pollerRef.current ?? poller;

      if (!activeStorage || !activeKeys || !activeSession || !activePoller) {
        // 抛出去让 poller 的 catch 捕获 → 不标记已处理 → 下轮重试
        throw new Error('processReceivedWelcome: 尚未完全初始化');
      }

      const welcomes = await activeStorage.getPendingWelcomes();
      const entry = welcomes.find((w) => w.queueId === welcome.queueId);
      if (!entry) {
        // 同理：没有匹配的 pending entry 说明这条 welcome 无法消费，
        // 绝不能静默 return（否则被永久标记为已处理）。抛错重试。
        throw new Error(
          `processReceivedWelcome: 无匹配的 pending welcome ${welcome.queueId}`,
        );
      }

      const pair = deserializeWithUint8Array<KeyPackagePair>(entry.keyPackageSerialized);

      const result = await processWelcome(
        welcome.welcomeBytes,
        activeSession.did,
        activeKeys,
        pair.publicPackage,
        pair.privatePackage,
      );

      await activeStorage.putMlsSession(result.groupId, result.mlsSession.serialize());
      activePoller.addSession(result.groupId, result.mlsSession);

      // 缺口①：接会话推进了状态，立即联动备份（同 acceptInviteQr）
      await triggerBackupAfterAdvance(`processWelcome ${result.groupId}`);

      await activeStorage.deletePendingWelcome(welcome.queueId);
      activePoller.removePendingWelcome(welcome.queueId);

      setGroups((prev) => (prev.includes(result.groupId) ? prev : [...prev, result.groupId]));
      setPendingWelcomes((prev) => prev.filter((w) => w.queueId !== welcome.queueId));
      setChatListVersion((v) => v + 1);

      console.log('processReceivedWelcome: 配对成功，已加入 MLS 群', result.groupId);
    },
    [storage, identityKeys, session, poller, putStorage, putIdentityKeys, triggerBackupAfterAdvance],
  );

  processWelcomeRef.current = processReceivedWelcome;

  // -------------------------------------------------------------------------
  // 入站消息处理（MVP：文本 + reaction）
  // -------------------------------------------------------------------------

  const handleIncomingMessage = useCallback(
    async (msg: IncomingMessage, userDid: string, msgStorage: DmeStorage): Promise<void> => {
      const isSelfSender = msg.senderDid === userDid;
      // 2026-10-18 实测：群消息在两台同 DID 设备上，兄弟端 poller 因 mls session
      // 状态短暂不一致，ownLeafIndex 错位导致 ownLeaf 跳过漏判，senderDid=本机
      // DID 的消息进了 onMessage → 提示音误响。统一用 isSelfSender 在所有
      // 提示音调用点过滤；消息仍正常落库显示（不影响同步）。
      const isBlockedSender = (await msgStorage.getBlockList()).includes(msg.senderDid);
      if (isBlockedSender) {
        console.log('handleIncomingMessage: 忽略被屏蔽发送者的消息', msg.senderDid);
        return;
      }

      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = JSON.parse(msg.plaintext) as Record<string, unknown>;
      } catch {
        // 非 JSON 即普通文本
      }

      const msgType = parsed?.['type'] as string | undefined;

      if (msgType && msgType.startsWith('group_')) {
        // 群聊协议：逐类型处理（与 dme-client 的 switch 分支一一对应）
        switch (msgType) {
          case 'group_invite_request': {
            const req = parsed as unknown as GroupInviteRequest;
            // 2026-10-15 真根因：poller 244 行的 own-leaf skip 是 `gen < expected`，
            // 仅能挡"自己叶子下 gen 已过期"，**挡不住 `gen > expected`**——备份
            // 恢复 / 多端 / 跨设备登录 场景下，自己通过 1v1 session 发出去的
            // group_invite_request 落进自己 leaf，PDS 保留 7 天；恢复到 expected
            // 更老的 mls session 时 `gen > expected`，不 skip，照常解密 + onMessage
            // → 旧实现「自邀请自」写入。1v1 ownLeaf 下的 envelope 语义上
            // 永远是自己发出去的 application message（commit 走群 session）——
            // 「收到的群邀请」不可能出自自己叶子。
            // 陈旧重放防线：恢复旧备份会把会话代际游标拨回，7 天 TTL 内的
            // 信封会被重新拉取。若该群会话已存在（已在群中），忽略重放的
            // 邀请请求，避免邀请卡片复活、被再次接受时向群主重复 accept
            if (await msgStorage.getMlsSession(req.groupId)) {
              console.log('handleIncomingMessage: 忽略陈旧的 group_invite_request（已在群中）', req.groupId);
              break;
            }
            if (msg.senderDid === userDid) {
              // 2026-10-16 own-leaf 镜像收敛（与 dme-client 同步）：同账号多端下，
              // 兄弟端轮询到本账号发出的 invite_request（1v1 对端 = 受邀人），
              // 此前一刀切拒收导致兄弟端既无 pending 记录也无「你邀请了…」系统
              // 消息——多端邀请状态永不同步。重建镜像记录：inviterDid=本机、
              // inviteeDid=1v1 对端（msg.groupId），以 inviteId 幂等去重。
              if (await msgStorage.getPendingInvite(req.inviteId)) {
                console.log(
                  'handleIncomingMessage: 重复的 own-leaf group_invite_request 镜像，跳过',
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
                'handleIncomingMessage: own-leaf group_invite_request 镜像已重建',
                req.inviteId, req.groupId,
              );
              break;
            }
            // 幂等 + 保状态（与 dme-client 同步）：response 先到时已落最终状态
            // 记录，此处不得覆盖为 pending
            const priorInvite = await msgStorage.getPendingInvite(req.inviteId);
            if (priorInvite && priorInvite.status !== 'pending') {
              console.log('handleIncomingMessage: group_invite_request 晚于 response，保留最终状态', req.inviteId, priorInvite.status);
              break;
            }
            // 2026-10-16 权威收敛（与 dme-client 同步）：重放重建 pending 前，
            // 若该群 GroupInfo 已存在（群已建成），邀请必然已终结——受邀人侧
            // 收敛为 accepted（曾响应过，别再亮接受按钮）。
            const existingGroup = await msgStorage.getGroupInfo(req.groupId);
            const invite: PendingInvite = {
              inviteId: req.inviteId,
              groupId: req.groupId,
              groupName: req.groupName,
              inviterDid: msg.senderDid,
              inviteeDid: userDid,
              status: existingGroup ? 'accepted' : 'pending',
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
            if (
              soundEnabledRef.current &&
              !isSelfSender &&
              (activeConversationRef.current === null || activeConversationRef.current === msg.groupId)
            ) {
              void playMessageSound();
            }
            break;
          }

          case 'group_invite_response': {
            const resp = parsed as unknown as GroupInviteResponse;
            // 重放去重（与 dme-client 同步）：同一条响应重复投递只处理一次
            // （存储桶与 putMessage 的默认归属一致：发送者 1v1 会话，保持
            // 系统消息原显示位置）
            const respBucket = msg.senderDid === userDid ? userDid : msg.senderDid;
            if (await msgStorage.hasMessage(respBucket, msg.envelope.queueId)) {
              console.log('handleIncomingMessage: duplicate group_invite_response, skipping', msg.envelope.queueId);
              break;
            }
            const existing = await msgStorage.getPendingInvite(resp.inviteId);
            if (!existing) {
              // 2026-10-16 恢复备份重放顺序修复（与 dme-client 同步）：response
              // 可能先于 request 被处理（清缓存后 PDS 重拉不保证顺序）。此前
              // 此处只写系统消息，随后 request 到达会把已拒绝/已接受的邀请按
              // pending 重建——卡片复活（实测：双端恢复备份后被拒邀请重新出现
              // 待处理卡片）。先落一条带最终状态的记录，request 后到时被
              // inviteId 幂等挡住，不会重置为 pending。
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
              console.log('handleIncomingMessage: group_invite_response 先于 request，已记录最终状态', resp.inviteId, resp.accepted);
            }
            if (existing) {
              // 「恢复备份后重放自己过去的接受确认」的精确判定（与 dme-client
              // 17f209c 同步）：响应发送者是本机用户 + 邀请记录里受邀人就是
              // 本机用户 + 本机无 KP pair。旧条件只看本机有无 pair 会误伤
              // 群主——群主发出去的邀请记录本来就没有 pair（pair 只在受邀方
              // 记录里），受邀人真实接受的响应会被误判为重放：邀请永远
              // pending、会话列表「0 接受」且 keyPackageSerialized 落不了库、
              // 无法建群（2026-10-15 实测踩坑）。
              const ownReplayWithoutPair =
                msg.senderDid === userDid &&
                existing.inviteeDid === userDid &&
                !(existing.ownKeyPackagePoolId || existing.ownKeyPackagePairSerialized);
              // 2026-10-20 状态机护栏（与 dme-client 同步）：响应只允许把
              // pending 推向终态。cancelled 是终态——群主兄弟端已凭
              // group_metadata_update 收敛（兄弟端建群成功），迟到的
              // accept_response 不得把建群卡片复活成 accepted（实测：a 端点
              // 创建后，b 端因 1v1 对端叶子代际落后、accept_response 晚于
              // metadata 解密处理，复活卡片显示「添加/取消」；c 端响应先于
              // metadata 处理则一切正常）。rejected/accepted 同为终态，重复
              // 响应幂等跳过。ownReplayWithoutPair 例外保留：其记录恒为受邀
              // 方向（inviteeDid===本机），与 inviter 方向的 cancelled 天然
              // 不相交，不受此护栏影响。
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
                  // 本机是受邀方但无 pair（恢复备份后重放「过去某个自己」的
                  // 确认，或多端另一台设备接受的）：welcome 对本机数学上解不开
                  // （KP 私钥不在本机）。把状态收敛为 accepted，避免会话列表/私聊
                  // 卡片永远 pending；并标记 issue，引导从其他设备最新备份恢复。
                  updated = { ...existing, status: 'accepted' };
                  await msgStorage.setSessionIssue(existing.groupId, 'sibling-rotated');
                  setChatListVersion((v) => v + 1);
                } else {
                  // 接受响应如实记账：① 群主收到受邀人的接受（建群前置状态，
                  // keyPackageSerialized 是 createGroupFromPendingInvites 的必要
                  // 输入）；② 受邀方自己的确认镜像（有 pair）
                  updated = { ...existing, status: 'accepted', keyPackageSerialized: resp.keyPackageSerialized };
                }
                await msgStorage.putPendingInvite(updated);
                setPendingInvites((prev) =>
                  prev.map((i) => (i.inviteId === resp.inviteId ? updated : i)),
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

            // 陈旧重放防线（与 dme-client 同步）：同一条 welcome 已处理过
            // （消息已入库）则整体跳过。joinViaWelcome 消耗 KP pair 具有一次性，
            // 重复执行只会抛错，且恢复旧备份后游标拨回会导致 welcome 被重新拉取
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
                const matching = allInvites.filter(
                  (i) =>
                    i.groupId === welcome.groupId &&
                    i.inviteeDid === userDid &&
                    (i.ownKeyPackagePoolId || i.ownKeyPackagePairSerialized),
                );
                const ownInvite = matching.length > 0 ? matching[matching.length - 1] : null;

                if (ownInvite && (ownInvite.ownKeyPackagePoolId || ownInvite.ownKeyPackagePairSerialized)) {
                  // 取 KP pair（池化闭环）：优先池条目（池随备份走，恢复后可直接
                  // join）；回退旧格式 pair 本体序列化（池化前的历史邀请记录）
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
                    pair = deserializeOwnKeyPackagePair(ownInvite.ownKeyPackagePairSerialized);
                  }
                  if (!pair) throw new Error('key package pair unavailable (consumed or missing from pool)');

                  const { decodeMlsMessage } = await import('ts-mls');
                  const impl = await getNobleMlsImpl();
                  const decoded = decodeMlsMessage(base64urlToBytes(welcome.welcomePayload), 0);
                  if (!decoded) throw new Error('welcome 解码失败');
                  const m = decoded[0]!;
                  if (m.wireformat !== 'mls_welcome') {
                    throw new Error(`期望 mls_welcome，实际 ${m.wireformat}`);
                  }
                  const newSession = await MlsSession.joinViaWelcome(m.welcome, pair, impl);
                  await msgStorage.putMlsSession(welcome.groupId, newSession.serialize());
                  poller.addSession(welcome.groupId, newSession);
                  joined = true;
                  // KP 一次性：join 成功才标记池条目 consumed（welcome 未到达时
                  // pair 保持未消费，随备份供恢复端 join——池化闭环的关键）
                  if (ownInvite.ownKeyPackagePoolId) {
                    await msgStorage.markKeyPackageConsumed(ownInvite.ownKeyPackagePoolId);
                  }
                  // 备份点（与 dme-client 同步）：新群会话建立，必须立即联动备份
                  // （其他端恢复后才有此群）
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
                  // 保留 invite（status 仍为 accepted）：group_invite 消息会留在 1:1 会话里，
                  // receivedGroupInvites 必须跨重启存活，卡片才能一直显示"已响应"。
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
                console.error('handleIncomingMessage: 通过 welcome 入群失败', err);
              }
            }

            // 统一出口（与 dme-client 同步）：join 未成功一律忽略插消息。
            // KP pair 只在点「接受」时随邀请记录生成，而邀请记录不进备份——
            // 恢复/新端场景下 welcome 虽然重放到达，但其加密对应的那把
            // KeyPackage 私钥已不存在，数学上永远解不开，插消息与群元数据
            // 只会产生僵尸群假条目。重新入群的唯一路径是重新接受（生成新
            // pair / 池条目），因此把该群自己的邀请记录重置回 pending，让
            // 卡片重新出现「接受」按钮——否则用户看到「已接受」却永远进不了
            // 群，界面无任何解释（实测踩坑：恢复后能收到邀请/自己确认/Bob
            // 确认，唯独进不了群）
            if (!joined) {
              // 本机无法加入：保留已由 sibling 响应收敛为 accepted 的状态，避免
              // 把「需恢复备份」的提示又改回 pending。其他非 pending 状态重置回
              // pending，让卡片重新提供接受入口。
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
                    ? { ...i, status: 'pending' as const, keyPackageSerialized: undefined, ownKeyPackagePairSerialized: undefined, ownKeyPackagePoolId: undefined }
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
            setGroupInfos((prev) =>
              prev.some((g) => g.groupId === welcome.groupId) ? prev : [...prev, groupInfo],
            );
            setGroups((prev) =>
              prev.includes(welcome.groupId) ? prev : [...prev, welcome.groupId],
            );
            break;
          }

          case 'group_metadata_update': {
            const update = parsed as unknown as GroupMetadataUpdate;
            const existing = await msgStorage.getGroupInfo(update.groupId);
            // 2026-10-16 修复（与 dme-client 同步）：改为「不存在就新建」。同账号
            // 兄弟端拿到群会话走的是群 queueId 空间的 commit wrapper，该路径只应用
            // MLS 状态、不写 GroupInfo；group_welcome 又只发给受邀人。此前
            // `if (existing)` 门禁让兄弟端永远建不出 GroupInfo——会话列表出现该群
            // 但查不到群元数据，落到 1:1 兜底分支用 groupId 当显示名。
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
                ? prev.map((g) => (g.groupId === update.groupId ? info : g))
                : [...prev, info],
            );
            setGroups((prev) => (prev.includes(update.groupId) ? prev : [...prev, update.groupId]));
            // 2026-10-16 收敛（与 dme-client 同步）：本机是该群邀请人且收到该群
            // metadata = 兄弟端已建群成功（welcome/metadata 只投给受邀者，群主
            // 兄弟端靠共享 1v1 会话状态重放解到）。本机镜像 pending 邀请就地
            // cancelled——不依赖 mlsSession（群主兄弟端结构性收不到 welcome，
            // reconcileStaleGroupInvites 的会话判据永不触发）。真正的群 mlsSession
            // 由恢复群主端备份获得。
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
            const commit = parsed as unknown as { groupId: string; commitPayload: string };
            if (poller) {
              const groupSession = poller.getSession(commit.groupId);
              if (groupSession) {
                try {
                  await groupSession.decrypt(base64urlToBytes(commit.commitPayload));
                  await msgStorage.putMlsSession(commit.groupId, groupSession.serialize());
                } catch (err) {
                  console.error('handleIncomingMessage: 处理 group commit 失败', err);
                  if (msg.senderDid === userDid) {
                    // 同账号兄弟设备产生了本机无法应用的 commit（密钥轮换/多端推进）：
                    // 唯一恢复路径是恢复最新备份（key-rotation-plan.md 1.6 / 1.4）
                    await msgStorage.setSessionIssue(commit.groupId, 'sibling-rotated');
                    console.warn('[dme:rotation] 兄弟设备已推进会话', commit.groupId, '需恢复备份');
                  } else {
                    // 普通成员的 commit 应用失败：会话已脱钩，需重新握手（1.4 desync 兑底）。
                    // 记录发送者 DID 供横幅「oo」展示（2026-10-20 与 dme-client 同步）
                    await msgStorage.setSessionIssue(commit.groupId, 'desynced', msg.senderDid);
                    console.warn('[dme:desync]', msg.senderDid, '的 commit 应用失败', commit.groupId);
                  }
                }
              }
            }
            break;
          }

          case 'group_dissolved': {
            const dissolved = parsed as unknown as GroupDissolved;

            // 陈旧重放防线（与 dme-client 同步）：同一条 dissolved 已处理过
            // （消息已入库）则跳过，避免恢复备份后重复插「群已解散」系统消息
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

            poller?.removeSession(dissolved.groupId);
            await msgStorage.deleteMlsSession(dissolved.groupId);

            if (dissolvedExisting) {
              const dissolvedInfo: GroupInfo = { ...dissolvedExisting, dissolved: true };
              await msgStorage.putGroupInfo(dissolvedInfo);
              setGroupInfos((prev) =>
                prev.map((g) => (g.groupId === dissolved.groupId ? dissolvedInfo : g)),
              );
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

            // 陈旧重放防线（与 dme-client 同步，2026-10-14 实测踩坑）：恢复旧
            // 备份会把 1v1 代际游标拨回，7 天 TTL 内真实发生过的 removed 信封
            // 会被重新投递。无差别处理会重复插「你已被移出群聊」系统消息，
            // 更严重的是会删掉本机刚经 group_welcome 重新入群新建的会话。
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

            poller?.removeSession(removed.groupId);
            await msgStorage.deleteMlsSession(removed.groupId);

            if (removedExisting) {
              const removedInfo: GroupInfo = { ...removedExisting, removed: true };
              await msgStorage.putGroupInfo(removedInfo);
              setGroupInfos((prev) =>
                prev.map((g) => (g.groupId === removed.groupId ? removedInfo : g)),
              );
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
                    // Phase 1.0：先快照提交前状态，commit 投群 queueId 空间
                    const preCommitState = groupSession.serialize();

                    // 宣言门禁（约定7）：群主执行退群清理 commit 前必须先宣言；
                    // taken/stale 已置 sibling-rotated 提示恢复备份，fail-closed 放弃
                    const claimSeq = await acquireClaimForCommit(left.groupId, groupSession.getEpoch());
                    if (claimSeq === null) break;

                    try {
                      const { commitMessage } = await groupSession.removeMember(leafIndex);
                      await msgStorage.putMlsSession(left.groupId, groupSession.serialize());
                      await msgStorage.setCommitSeq(claimSeq);

                      await deliverCommitViaGroupSpace({
                        preCommitStateSerialized: preCommitState,
                        groupId: left.groupId,
                        commitMessage,
                        createEnvelope: (envelope) => pds.createEnvelope(envelope),
                      });

                      // 备份点：群主执行退群清理 commit，群会话状态推进，
                      // 立即联动备份（其他端恢复后才有含此次移除的新状态）
                      await triggerBackupAfterAdvance(`removeLeavingMember ${left.groupId}`);
                    } catch (err) {
                      // commit/投递失败：释放宣言避免虚高水位；信封重放时
                      // 下次处理自然重试
                      await releaseClaim();
                      throw err;
                    }
                  }
                } catch (err) {
                  console.error('handleIncomingMessage: 移除退群成员失败', err);
                }
              }
            }

            const updatedInfo: GroupInfo = {
              ...existing,
              members: existing.members.filter((m) => m.did !== left.memberDid),
            };
            await msgStorage.putGroupInfo(updatedInfo);
            setGroupInfos((prev) =>
              prev.map((g) => (g.groupId === left.groupId ? updatedInfo : g)),
            );

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

          default: {
            // 群内普通文本
            if (await msgStorage.hasMessage(msg.groupId, msg.envelope.queueId)) break;
            await msgStorage.putMessage({
              id: msg.envelope.queueId,
              fromDid: msg.senderDid,
              toDid: userDid,
              plaintext: msg.plaintext,
              createdAt: msg.envelope.createdAt,
              sent: false,
              kind: 'text',
              conversationId: msg.groupId,
            });
            if (
              soundEnabledRef.current &&
              !isSelfSender &&
              (activeConversationRef.current === null || activeConversationRef.current === msg.groupId)
            ) {
              void playMessageSound();
            }
            break;
          }
        }
      } else if (msgType === 'reaction') {
        const r = parsed as unknown as { action: 'add' | 'remove'; emoji: string; targetMessageId: string; createdAt?: string };
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
        // 文件清单：把 manifest（MLS 内层明文）+ envelope 上的 blobCids（外层明文）
        // 合成 fileMeta 落库，之后即可下载。与 web 完全同构。
        if (await msgStorage.hasMessage(msg.groupId, msg.envelope.queueId)) {
          console.log('handleIncomingMessage: 重复文件消息，跳过', msg.envelope.queueId);
          return;
        }
        const manifest = JSON.parse(msg.plaintext) as FileManifestMessage;
        await msgStorage.putMessage({
          id: msg.envelope.queueId,
          fromDid: msg.senderDid,
          toDid: userDid,
          plaintext: msg.plaintext,
          createdAt: msg.envelope.createdAt,
          sent: false,
          kind: 'file',
          conversationId: msg.groupId,
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
        });

        // 图片且 ≤5MB 时自动下载（与 web 一致）
        if (manifest.mimeType.startsWith('image/') && manifest.fileSize <= 5 * 1024 * 1024) {
          void downloadFileRef.current?.(msg.groupId, msg.envelope.queueId).catch((err: unknown) => {
            console.error('handleIncomingMessage: 自动下载图片失败', err);
          });
        }

        if (
          soundEnabledRef.current &&
          !isSelfSender &&
          (activeConversationRef.current === null || activeConversationRef.current === msg.groupId)
        ) {
          void playMessageSound();
        }
      } else {
        if (await msgStorage.hasMessage(msg.groupId, msg.envelope.queueId)) {
          console.log('handleIncomingMessage: 重复文本消息，跳过', msg.envelope.queueId);
          return;
        }
        await msgStorage.putMessage({
          id: msg.envelope.queueId,
          fromDid: msg.senderDid,
          toDid: userDid,
          plaintext: msg.plaintext,
          createdAt: msg.envelope.createdAt,
          sent: false,
          kind: 'text',
          conversationId: msg.groupId,
        });

        if (
          soundEnabledRef.current &&
          !isSelfSender &&
          (activeConversationRef.current === null || activeConversationRef.current === msg.groupId)
        ) {
          void playMessageSound();
        }
      }

      setChatListVersion((v) => v + 1);
    },
    [],
  );

  handleIncomingMessageRef.current = handleIncomingMessage;

  // -------------------------------------------------------------------------
  // 发消息
  // -------------------------------------------------------------------------

  const sendMessage = useCallback(
    async (groupId: string, text: string): Promise<void> => {
      if (!session || !storage || !pds || !poller) {
        throw new Error('sendMessage: 尚未完全初始化');
      }

      const mlsSession = poller.getSession(groupId);
      if (!mlsSession) throw new Error(`sendMessage: 无 ${groupId} 的 MLS 会话`);

      const plaintextBytes = new TextEncoder().encode(text);
      const result = await mlsSession.encrypt(plaintextBytes);

      await storage.putMlsSession(groupId, mlsSession.serialize());

      const msg: StoredMessage = {
        id: result.queueId,
        fromDid: session.did,
        toDid: groupId,
        plaintext: text,
        createdAt: new Date().toISOString(),
        sent: true,
        kind: 'text',
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
      await pds.createEnvelope(envelope);

      setChatListVersion((v) => v + 1);
    },
    [session, storage, pds, poller],
  );

  // -------------------------------------------------------------------------
  // 文件消息（Phase 4B）
  //
  // 全链路：本地副本 → 乐观消息(uploading) → 分块加密上传 → MLS 文件清单
  //        → 替换为正式消息。与 web `AppContext.tsx:1553-1855` 同构。
  // -------------------------------------------------------------------------

  /** 把 fileMeta 转成发给对端的明文清单（结构与 web 的 FileManifestMessage 一致）。 */
  const buildFileManifest = (meta: FileMeta): FileManifestMessage => ({
    type: FILE_MANIFEST_TYPE,
    fileId: meta.fileId,
    fileName: meta.fileName,
    fileSize: meta.fileSize,
    mimeType: meta.mimeType,
    sha256: meta.sha256,
    chunkCount: meta.chunkCount,
    chunkSize: meta.chunkSize,
    fileKey: meta.fileKey,
  });

  /**
   * 分块加密上传本地缓存文件。
   *
   * 进度按「已上传密文字节 / 预计总密文字节」计算（每片固定 +16B GCM tag），
   * 粒度是分片级 —— UI 不要承诺精确百分比。
   * 写盘是 fire-and-forget：进度落盘失败不该中断上传本身。
   */
  const uploadLocalFile = useCallback(
    async (params: {
      conversationId: string;
      msgId: string;
      filePath: string;
      fileId: Uint8Array;
      fileKey: Uint8Array;
      fileSize: number;
      chunkSize: number;
    }): Promise<UploadFileChunksResult> => {
      if (!storage || !pds) throw new Error('uploadLocalFile: 尚未完全初始化');

      return uploadFileChunks({
        fileSize: params.fileSize,
        chunkSize: params.chunkSize,
        fileId: params.fileId,
        fileKey: params.fileKey,
        readChunk: (offset, readSize) => readFileChunk(params.filePath, offset, readSize),
        // ⚠️ 必须 raw octet-stream；不能用 wx.uploadFile（multipart）。
        //    见 platform/file-transfer.ts 顶部与 IMPROVEMENT-PLAN.md §4.1。
        uploadChunk: (encrypted) => pds.uploadBlob(encrypted, 'application/octet-stream'),
        onProgress: (progress) => {
          void storage
            .updateFileMessageMeta(params.conversationId, params.msgId, { uploadProgress: progress })
            .then(() => setChatListVersion((v) => v + 1))
            .catch((err) => console.warn('uploadLocalFile: 写上传进度失败', err));
        },
      });
    },
    [storage, pds],
  );

  /** 上传成功后的收尾：发 MLS 文件清单 + 用正式消息替换乐观消息。 */
  const finalizeFileMessage = useCallback(
    async (params: {
      conversationId: string;
      tempMsgId: string;
      fileMeta: FileMeta;
      localPath: string;
      upload: UploadFileChunksResult;
    }): Promise<void> => {
      if (!session || !storage || !pds || !poller) {
        throw new Error('finalizeFileMessage: 尚未完全初始化');
      }
      const { conversationId, tempMsgId, fileMeta, localPath, upload } = params;

      const mlsSession = poller.getSession(conversationId);
      if (!mlsSession) throw new Error(`finalizeFileMessage: 无 ${conversationId} 的 MLS 会话`);

      const finalMeta: FileMeta = {
        ...fileMeta,
        sha256: upload.sha256,
        chunkCount: upload.chunkCount,
        blobCids: upload.blobRefs,
        localPath,
        downloadStatus: 'ready',
        uploadStatus: 'uploaded',
        uploadProgress: undefined,
      };
      const manifestJson = JSON.stringify(buildFileManifest(finalMeta));

      const manifestBytes = new TextEncoder().encode(manifestJson);
      const encResult = await mlsSession.encrypt(manifestBytes);
      await storage.putMlsSession(conversationId, mlsSession.serialize());
      await pds.createEnvelope({
        $type: 'dme.queue.envelope',
        queueId: encResult.queueId,
        payload: bytesToBase64url(encResult.ciphertext),
        // blobCids 放在**外层明文**，PDS 才会保留 blob 不被 GC
        blobCids: upload.blobRefs,
        createdAt: new Date().toISOString(),
        messageType: 'application',
      });

      await storage.deleteMessage(conversationId, tempMsgId);
      await storage.putMessage({
        id: encResult.queueId,
        fromDid: session.did,
        toDid: conversationId,
        plaintext: manifestJson,
        createdAt: new Date().toISOString(),
        sent: true,
        kind: 'file',
        conversationId,
        fileMeta: finalMeta,
      });
      setChatListVersion((v) => v + 1);
    },
    [session, storage, pds, poller],
  );

  /**
   * 上传 → 发清单 → 替换消息。`sendFileMessage` 与 `retryUploadFileMessage` 共用。
   *
   * 失败时只把 `uploadStatus` 置为 `failed` 并**不抛错**（与 web 一致：
   * 由气泡显示「上传失败 + 重试」，不打断页面）。
   */
  const runFileUpload = useCallback(
    async (params: {
      conversationId: string;
      tempMsgId: string;
      fileMeta: FileMeta;
      filePath: string;
      fileId: Uint8Array;
      fileKey: Uint8Array;
    }): Promise<void> => {
      if (!storage) throw new Error('runFileUpload: 尚未完全初始化');
      const { conversationId, tempMsgId, fileMeta, filePath, fileId, fileKey } = params;

      let upload: UploadFileChunksResult;
      try {
        upload = await uploadLocalFile({
          conversationId,
          msgId: tempMsgId,
          filePath,
          fileId,
          fileKey,
          fileSize: fileMeta.fileSize,
          chunkSize: fileMeta.chunkSize,
        });
      } catch (err) {
        console.error('runFileUpload: 上传失败', err);
        await storage.updateFileMessageMeta(conversationId, tempMsgId, {
          uploadStatus: 'failed',
          uploadProgress: undefined,
        });
        setChatListVersion((v) => v + 1);
        return;
      }

      await finalizeFileMessage({
        conversationId,
        tempMsgId,
        fileMeta,
        localPath: filePath,
        upload,
      });
    },
    [storage, uploadLocalFile, finalizeFileMessage],
  );

  const sendFileMessage = useCallback(
    async (
      conversationId: string,
      filePath: string,
      fileName: string,
      mimeType: string,
      fileSize: number,
    ): Promise<void> => {
      if (!session || !storage || !pds || !poller) {
        throw new Error('sendFileMessage: 尚未完全初始化');
      }
      if (fileSize > 500 * 1024 * 1024) {
        console.warn('sendFileMessage: 文件超过 500MB，上传可能很慢');
      }
      if (!poller.getSession(conversationId)) {
        throw new Error(`sendFileMessage: 无 ${conversationId} 的 MLS 会话`);
      }

      const fileId = generateFileId();
      const fileKey = generateFileKey();
      const fileIdHex = bytesToHex(fileId);
      const chunkSize = FILE_CHUNK_SIZE;
      const tempId = generateId();

      // 1) 先落一份本地副本：picker 返回的是临时文件，可能被系统回收；
      //    后续重试上传都读这份副本（与 web 的「先落盘再上传」一致）。
      const senderLocalPath = await copyIntoCache(filePath, fileIdHex, fileName);

      // 2) 乐观消息先入列表（uploadStatus=uploading）
      const baseMeta: FileMeta = {
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
      };
      await storage.putMessage({
        id: tempId,
        fromDid: session.did,
        toDid: conversationId,
        plaintext: JSON.stringify(buildFileManifest(baseMeta)),
        createdAt: new Date().toISOString(),
        sent: false,
        kind: 'file',
        conversationId,
        fileMeta: baseMeta,
      });
      setChatListVersion((v) => v + 1);

      // 3) 上传 + 发清单 + 替换消息
      await runFileUpload({
        conversationId,
        tempMsgId: tempId,
        fileMeta: baseMeta,
        filePath: senderLocalPath,
        fileId,
        fileKey,
      });
    },
    [session, storage, pds, poller, runFileUpload],
  );

  const retryUploadFileMessage = useCallback(
    async (conversationId: string, msgId: string): Promise<void> => {
      if (!session || !storage || !pds || !poller) {
        throw new Error('retryUploadFileMessage: 尚未完全初始化');
      }

      const msgs = await storage.getMessages(conversationId);
      const msg = msgs.find((m) => m.id === msgId);
      if (!msg || !msg.fileMeta) {
        throw new Error('retryUploadFileMessage: 消息或 fileMeta 不存在');
      }
      const fileMeta = msg.fileMeta;
      if (!fileMeta.localPath) {
        throw new Error('retryUploadFileMessage: 本地副本已丢失，无法重试');
      }

      const fileId = hexToBytes(fileMeta.fileId);
      const fileKey = base64urlToBytes(fileMeta.fileKey);

      await storage.updateFileMessageMeta(conversationId, msgId, { uploadStatus: 'uploading' });
      setChatListVersion((v) => v + 1);

      await runFileUpload({
        conversationId,
        tempMsgId: msgId,
        fileMeta,
        filePath: fileMeta.localPath,
        fileId,
        fileKey,
      });
    },
    [session, storage, pds, poller, runFileUpload],
  );

  /**
   * 下载 + 解密文件。
   *
   * ⚠️ web 的循环里 `attempts` **从未自增**（`dme-client:987-1103`），
   *    `attempts >= maxAttempts` 恒为 false → 失败会**无限重试**。
   *    这里按注释意图修正为「最多 3 次，间隔 2s/4s/8s」，语义仍是
   *    「网络抖动可自愈，持续失败则置 failed 供用户手动重试」。
   */
  const downloadFile = useCallback(
    async (conversationId: string, msgId: string): Promise<void> => {
      if (!storage || !pds) throw new Error('downloadFile: 尚未完全初始化');

      const msgs = await storage.getMessages(conversationId);
      const msg = msgs.find((m) => m.id === msgId);
      if (!msg || !msg.fileMeta) throw new Error('downloadFile: 消息或 fileMeta 不存在');

      const fileMeta = msg.fileMeta;
      const fileKey = base64urlToBytes(fileMeta.fileKey);
      const fileId = hexToBytes(fileMeta.fileId);
      const blobCids = fileMeta.blobCids;
      if (!blobCids || blobCids.length === 0) {
        throw new Error('downloadFile: fileMeta 缺少 blobCids');
      }

      await storage.updateFileMessageMeta(conversationId, msgId, {
        downloadStatus: 'downloading',
        downloadProgress: 0,
      });
      setChatListVersion((v) => v + 1);

      const maxAttempts = 3;
      const retryDelays = [2000, 4000, 8000];
      let lastError: unknown = null;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          const senderPdsUrl = await resolvePdsUrl(msg.fromDid);
          const totalBlobBytes = blobCids.reduce((sum, b) => sum + b.size, 0) || 1;
          let downloadedBytes = 0;
          let lastProgress = -1;
          const decryptedChunks: Uint8Array[] = [];

          for (let i = 0; i < blobCids.length; i++) {
            const cid = blobCids[i]!.ref.$link;
            const blobUrl = pds.getBlobUrl(senderPdsUrl, msg.fromDid, cid);

            // 逐块下载。`downloadFile` 通道会给字节级进度（等价 web 的
            // response.body.getReader()）；`request` 回退通道只在末尾报一次。
            const { bytes: encryptedBlob } = await downloadBlobBytes(blobUrl, (loaded) => {
              const progress = Math.min(
                99,
                Math.round(((downloadedBytes + loaded) / totalBlobBytes) * 100),
              );
              if (progress === lastProgress) return;
              lastProgress = progress;
              void storage
                .updateFileMessageMeta(conversationId, msgId, { downloadProgress: progress })
                .then(() => setChatListVersion((v) => v + 1))
                .catch(() => {
                  /* 进度落盘失败不影响下载 */
                });
            });

            downloadedBytes += encryptedBlob.byteLength;
            const afterBlob = Math.min(99, Math.round((downloadedBytes / totalBlobBytes) * 100));
            if (afterBlob !== lastProgress) {
              lastProgress = afterBlob;
              await storage.updateFileMessageMeta(conversationId, msgId, {
                downloadProgress: afterBlob,
              });
              setChatListVersion((v) => v + 1);
            }

            decryptedChunks.push(await decryptChunk(encryptedBlob, fileKey, fileId, i));
          }

          const totalLength = decryptedChunks.reduce((sum, c) => sum + c.length, 0);
          const fullData = new Uint8Array(totalLength);
          let offset = 0;
          for (const chunk of decryptedChunks) {
            fullData.set(chunk, offset);
            offset += chunk.length;
          }

          if (computeSha256(fullData) !== fileMeta.sha256) {
            throw new Error('downloadFile: SHA-256 校验不匹配');
          }

          const localPath = await writeBytesToCache(fileMeta.fileId, fileMeta.fileName, fullData);

          await storage.updateFileMessageMeta(conversationId, msgId, {
            localPath,
            downloadStatus: 'ready',
            downloadProgress: undefined,
          });
          setChatListVersion((v) => v + 1);
          return;
        } catch (err) {
          lastError = err;
          console.error(`downloadFile: 第 ${attempt}/${maxAttempts} 次尝试失败`, err);
          if (attempt >= maxAttempts) break;
          await new Promise((resolve) => setTimeout(resolve, retryDelays[attempt - 1]));
        }
      }

      await storage.updateFileMessageMeta(conversationId, msgId, {
        downloadStatus: 'failed',
        downloadProgress: undefined,
      });
      setChatListVersion((v) => v + 1);
      throw lastError instanceof Error ? lastError : new Error('downloadFile: 未知错误');
    },
    [storage, pds],
  );

  // 供 handleIncomingMessage 的「图片自动下载」使用（它定义在本 action 之前）
  downloadFileRef.current = downloadFile;

  const sendReaction = useCallback(
    async (conversationId: string, messageId: string, emoji: string): Promise<void> => {
      if (!session || !storage || !pds || !poller) {
        throw new Error('sendReaction: 尚未完全初始化');
      }

      const mlsSession = poller.getSession(conversationId);
      if (!mlsSession) throw new Error(`sendReaction: 无 ${conversationId} 的 MLS 会话`);

      // 同一 emoji 已回应过 → 本次是「撤销」
      const msgs = await storage.getMessages(conversationId);
      const target = msgs.find((m) => m.id === messageId);
      const alreadyReacted =
        target?.reactions?.some((r) => r.did === session.did && r.emoji === emoji) ?? false;
      const action: 'add' | 'remove' = alreadyReacted ? 'remove' : 'add';

      if (action === 'remove') {
        await storage.removeReaction(conversationId, messageId, session.did, emoji);
      } else {
        const reaction: Reaction = {
          emoji,
          did: session.did,
          createdAt: new Date().toISOString(),
        };
        await storage.addReaction(conversationId, messageId, reaction);
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

      await pds.createEnvelope({
        $type: 'dme.queue.envelope',
        queueId: result.queueId,
        payload: bytesToBase64url(result.ciphertext),
        createdAt: new Date().toISOString(),
        messageType: 'application',
      });

      setChatListVersion((v) => v + 1);
    },
    [session, storage, pds, poller],
  );

  const deleteMessage = useCallback(
    async (conversationId: string, messageId: string): Promise<void> => {
      if (!storage) throw new Error('deleteMessage: 未初始化');
      await storage.deleteMessage(conversationId, messageId);
      setChatListVersion((v) => v + 1);
    },
    [storage],
  );

  const deleteFriend = useCallback(
    async (groupId: string): Promise<void> => {
      if (!storage || !poller) throw new Error('deleteFriend: 未初始化');

      poller.removeSession(groupId);
      await storage.deleteMlsSession(groupId);
      await storage.deleteMessages(groupId);

      setGroups((prev) => prev.filter((g) => g !== groupId));
      setChatListVersion((v) => v + 1);
    },
    [storage, poller],
  );

  const markConversationAsRead = useCallback(
    async (groupId: string): Promise<void> => {
      if (!storage) return;
      await storage.markMessagesAsRead(groupId);
      setChatListVersion((v) => v + 1);
    },
    [storage],
  );

  // -------------------------------------------------------------------------
  // 屏蔽列表
  // -------------------------------------------------------------------------

  const refreshBlockList = useCallback(async (): Promise<void> => {
    if (!storage) return;
    setBlockList(await storage.getBlockList());
  }, [storage]);

  const blockMember = useCallback(
    async (did: string): Promise<void> => {
      if (!storage) throw new Error('blockMember: 未初始化');
      await storage.addBlockedDid(did);
      setBlockList(await storage.getBlockList());
      setChatListVersion((v) => v + 1);
    },
    [storage],
  );

  const unblockMember = useCallback(
    async (did: string): Promise<void> => {
      if (!storage) throw new Error('unblockMember: 未初始化');
      await storage.removeBlockedDid(did);
      setBlockList(await storage.getBlockList());
      setChatListVersion((v) => v + 1);
    },
    [storage],
  );

  // -------------------------------------------------------------------------
  // 群聊（Phase 3；与 dme-client/src/state/AppContext.tsx 同名同语义）
  // -------------------------------------------------------------------------

  /**
   * 用与某个 DID 的 MLS 会话加密 payload 并投递到 PDS 队列。
   *
   * web 端在各 action 里内联了「取会话 → encrypt → putMlsSession → createEnvelope」
   * 四步，小程序集中成这一个 helper（行为完全一致，含会话序列化回写）。
   */
  const sendEncryptedTo = useCallback(
    async (peerDid: string, payload: unknown): Promise<boolean> => {
      if (!storage || !pds || !poller) return false;
      const mlsSession = poller.getSession(peerDid);
      if (!mlsSession) return false;

      const encResult = await mlsSession.encrypt(
        new TextEncoder().encode(JSON.stringify(payload)),
      );
      await storage.putMlsSession(peerDid, mlsSession.serialize());

      await pds.createEnvelope({
        $type: 'dme.queue.envelope',
        queueId: encResult.queueId,
        payload: bytesToBase64url(encResult.ciphertext),
        createdAt: new Date().toISOString(),
        messageType: 'application',
      });
      return true;
    },
    [storage, pds, poller],
  );

  const sendGroupInvites = useCallback(
    async (groupName: string, friendDids: readonly string[]): Promise<string> => {
      if (!session || !storage || !identityKeys || !pds || !poller) {
        throw new Error('sendGroupInvites: 未初始化');
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
          console.error('sendGroupInvites: 缺少与', friendDid, '的 MLS 会话');
          continue;
        }

        const plaintextBytes = new TextEncoder().encode(JSON.stringify(inviteRequest));
        const encResult = await mlsSession.encrypt(plaintextBytes);
        await storage.putMlsSession(friendDid, mlsSession.serialize());

        await pds.createEnvelope({
          $type: 'dme.queue.envelope',
          queueId: encResult.queueId,
          payload: bytesToBase64url(encResult.ciphertext),
          createdAt: new Date().toISOString(),
          messageType: 'application',
        });

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
    },
    [session, storage, identityKeys, pds, poller, language],
  );

  const respondToGroupInvite = useCallback(
    async (inviteId: string, accepted: boolean): Promise<void> => {
      if (!session || !storage || !identityKeys || !pds || !poller) {
        throw new Error('respondToGroupInvite: 未初始化');
      }

      const invite = receivedGroupInvites.find((i) => i.inviteId === inviteId);
      if (!invite) throw new Error('respondToGroupInvite: 邀请不存在');

      if (accepted) {
        // 陈旧邀请防线（与 dme-client 同步，2026-10-14 实测踩坑）：恢复旧
        // 备份/重放复活的老邀请被再次点「接受」时，若本机已有该群的 MLS
        // 会话，说明用户本来就在群中。此时再发 accept_response 是无效重复
        // ——群主端该 inviteId 早已 cancelled/不存在，静默丢弃后用户端卡片
        // 变「已接受」却永远等不到 welcome，静默卡死无法聊天。直接本地收敛。
        if (await storage.getMlsSession(invite.groupId)) {
          console.log(
            'respondToGroupInvite: already in group, converging stale invite without re-accepting',
            invite.groupId,
          );
          const convergedInvite: PendingInvite = { ...invite, status: 'accepted' };
          await storage.putPendingInvite(convergedInvite);
          setReceivedGroupInvites((prev) =>
            prev.map((i) => (i.inviteId === inviteId ? convergedInvite : i)),
          );
          setChatListVersion((v) => v + 1);
          return;
        }

        const inviterEncKey = await getRemoteEncryptionKey(invite.inviterDid);
        if (!inviterEncKey) throw new Error('respondToGroupInvite: 邀请人没有加密公钥');

        // KP 池化（备份点，与 dme-client 同步）：welcome 的解密依赖接受方
        // KP pair 的私钥，pair 必须随备份走，否则恢复后 welcome（TTL 内重放）
        // 数学上永远解不开（实测踩坑：恢复后收到邀请/自己确认/Bob 确认，
        // 唯独进不了群）。从 keyPackagePool 取未消费 pair——池已进 FullBackup
        // Data：welcome 未到达时 pair 完好随备份，恢复后直接 join；join 成功
        // 才标 consumed（KP 一次性）。
        let poolEntry = (await storage.getKeyPackagePool()).find((e) => !e.consumed) ?? null;
        if (!poolEntry) {
          await refreshKeyPackagePool();
          poolEntry = (await storage.getKeyPackagePool()).find((e) => !e.consumed) ?? null;
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
        if (!mlsSession) throw new Error('respondToGroupInvite: 缺少与邀请人的 MLS 会话');

        let encResult: { queueId: string; ciphertext: Uint8Array };
        try {
          encResult = await mlsSession.encrypt(
            new TextEncoder().encode(JSON.stringify(response)),
          );
          await storage.putMlsSession(invite.inviterDid, mlsSession.serialize());

          await pds.createEnvelope({
            $type: 'dme.queue.envelope',
            queueId: encResult.queueId,
            payload: bytesToBase64url(encResult.ciphertext),
            createdAt: new Date().toISOString(),
            messageType: 'application',
          });
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
          prev.map((i) => (i.inviteId === inviteId ? updatedInvite : i)),
        );
      } else {
        const response = createRejectResponse({ inviteId, groupId: invite.groupId });
        const mlsSession = poller.getSession(invite.inviterDid);
        if (!mlsSession) throw new Error('respondToGroupInvite: 缺少与邀请人的 MLS 会话');

        const encResult = await mlsSession.encrypt(
          new TextEncoder().encode(JSON.stringify(response)),
        );
        await storage.putMlsSession(invite.inviterDid, mlsSession.serialize());

        await pds.createEnvelope({
          $type: 'dme.queue.envelope',
          queueId: encResult.queueId,
          payload: bytesToBase64url(encResult.ciphertext),
          createdAt: new Date().toISOString(),
          messageType: 'application',
        });

        await storage.updatePendingInviteStatus(inviteId, 'rejected');
        setReceivedGroupInvites((prev) =>
          prev.map((i) => (i.inviteId === inviteId ? { ...i, status: 'rejected' } : i)),
        );
      }

      setChatListVersion((v) => v + 1);
    },
    [session, storage, identityKeys, pds, poller, receivedGroupInvites, refreshKeyPackagePool, acquireClaimForCommit, releaseClaim],
  );

  const createGroupFromPendingInvites = useCallback(
    async (groupId: string): Promise<void> => {
      if (!session || !storage || !identityKeys || !pds || !poller) {
        throw new Error('createGroupFromPendingInvites: 未初始化');
      }

      const accepted = pendingInvites.filter(
        (i) => i.groupId === groupId && i.status === 'accepted',
      );
      if (accepted.length === 0) throw new Error('createGroupFromPendingInvites: 没有已接受的成员');

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

      let created: Awaited<ReturnType<typeof createGroupWithMembers>>;
      try {
        created = await createGroupWithMembers({
          groupId,
          ownerDid: session.did,
          ownerIdentityKeys: identityKeys,
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

      const memberList: GroupMember[] = [
        { did: session.did, displayName: session.did, role: 'creator' },
        ...accepted.map((i) => ({
          did: i.inviteeDid,
          displayName: i.inviteeDid,
          role: 'member' as const,
        })),
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

      // Welcome 单播给每个被接受的成员
      for (const invite of accepted) {
        const welcomeBytes = welcomes.get(invite.inviteeDid);
        if (!welcomeBytes) continue;

        const welcomeMsg = createGroupWelcome({
          groupId,
          groupName: groupInfo.groupName,
          welcomePayload: bytesToBase64url(welcomeBytes),
          members: memberList,
        });

        await sendEncryptedTo(invite.inviteeDid, welcomeMsg);
        await storage.updatePendingInviteStatus(invite.inviteId, 'cancelled');
      }

      // 群元数据
      const metadataMsg = createMetadataUpdate({
        groupId,
        groupName: groupInfo.groupName,
        members: memberList,
      });
      for (const invite of accepted) {
        await sendEncryptedTo(invite.inviteeDid, metadataMsg);
      }

      // 注：建群阶段的 commit 投递保留成对 1v1 通道——committer 恒为 creator，
      // 而 creator 与每个受邀者的 1v1 会话由邀请流程结构性保证存在。
      // 其余 commit 场景（踢人/拉人/轮换/退群移除）已改走群 queueId 空间。
      // commit 广播
      for (const { commitMessage, memberDids } of commits) {
        const commitMsg = {
          type: 'group_commit' as const,
          groupId,
          commitPayload: bytesToBase64url(commitMessage),
        };
        for (const memberDid of memberDids) {
          await sendEncryptedTo(memberDid, commitMsg);
        }
      }
      } catch (err) {
        // welcome/commit 投递失败：移除新群会话并释放宣言——绝不让
        // 「本地已换代而对端未收到」的状态落盘（否则全员脱钩），上层可重试
        console.warn('createGroupFromPendingInvites: 投递失败，清理新群会话', err);
        poller.removeSession(groupId);
        await storage.deleteMlsSession(groupId);
        await releaseClaim();
        throw err;
      }

      await storage.setCommitSeq(claimSeq);

      // 备份点：新建群会话 + 全部 welcome/commit 投递完成，立即联动备份
      // （群主其他端恢复后才有新群，否则与全群脱钩）
      await triggerBackupAfterAdvance(`createGroup ${groupId}`);

      setGroups((prev) => (prev.includes(groupId) ? prev : [...prev, groupId]));
      setChatListVersion((v) => v + 1);
    },
    [session, storage, identityKeys, pds, poller, pendingInvites, language, sendEncryptedTo, triggerBackupAfterAdvance, acquireClaimForCommit, releaseClaim],
  );

  const cancelGroupInvite = useCallback(
    async (inviteId: string): Promise<void> => {
      if (!storage) throw new Error('cancelGroupInvite: 未初始化');
      await storage.updatePendingInviteStatus(inviteId, 'cancelled');
      setPendingInvites((prev) =>
        prev.map((i) => (i.inviteId === inviteId ? { ...i, status: 'cancelled' as const } : i)),
      );
      setChatListVersion((v) => v + 1);
    },
    [storage],
  );

  const addMemberToGroup = useCallback(
    async (groupId: string, friendDid: string): Promise<void> => {
      if (!session || !storage || !identityKeys || !pds || !poller) {
        throw new Error('addMemberToGroup: 未初始化');
      }

      const friendMlsSession = poller.getSession(friendDid);
      if (!friendMlsSession) throw new Error('addMemberToGroup: 缺少与好友的 MLS 会话');

      const friendEncKey = await getRemoteEncryptionKey(friendDid);
      if (!friendEncKey) throw new Error('addMemberToGroup: 好友没有加密公钥');

      const keyPackageSerialized = await generateEncryptedKeyPackageForInvite({
        ownDid: friendDid,
        ownIdentityKeys: identityKeys,
        inviterEncryptionPublicKey: friendEncKey,
      });

      const groupInfo = await storage.getGroupInfo(groupId);
      if (!groupInfo) throw new Error('addMemberToGroup: 群信息不存在');

      const inviteId = generateId();
      const inviteRequest = createInviteRequest({
        inviteId,
        groupId,
        groupName: groupInfo.groupName,
        members: [...groupInfo.members],
      });

      await sendEncryptedTo(friendDid, inviteRequest);

      const friendHandle = await resolveHandleCached(friendDid);
      await storage.putMessage({
        id: `sys_invite_${inviteId}`,
        fromDid: session.did,
        toDid: friendDid,
        plaintext: t(language, 'group.youInvited', {
          handle: friendHandle,
          group: groupInfo.groupName,
        }),
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

      // keyPackageSerialized 由被邀请方在响应里带回，此处仅用于日志
      void keyPackageSerialized;
    },
    [session, storage, identityKeys, pds, poller, language, sendEncryptedTo],
  );

  const addAcceptedMembersToGroup = useCallback(
    async (groupId: string): Promise<void> => {
      if (!session || !storage || !identityKeys || !pds || !poller) {
        throw new Error('addAcceptedMembersToGroup: 未初始化');
      }

      const groupInfo = await storage.getGroupInfo(groupId);
      if (!groupInfo) throw new Error('addAcceptedMembersToGroup: 群信息不存在');

      const mlsSession = poller.getSession(groupId);
      if (!mlsSession) throw new Error('addAcceptedMembersToGroup: 缺少群的 MLS 会话');

      const accepted = pendingInvites.filter(
        (i) => i.groupId === groupId && i.status === 'accepted',
      );
      if (accepted.length === 0) throw new Error('addAcceptedMembersToGroup: 没有已接受的成员');

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
          members: [
            ...groupInfo.members,
            ...newMembers,
            { did: invite.inviteeDid, displayName: invite.inviteeDid, role: 'member' as const },
          ],
        });
        await sendEncryptedTo(invite.inviteeDid, welcomeMsg);

        commitsWithTargets.push({
          commitMessage,
          preCommitState,
          targetDids: [...existingDids].filter((d) => d !== session.did),
        });

        newMembers.push({
          did: invite.inviteeDid,
          displayName: invite.inviteeDid,
          role: 'member' as const,
        });
        existingDids.add(invite.inviteeDid);
      }

      await storage.putMlsSession(groupId, mlsSession.serialize());

      for (const { commitMessage, preCommitState } of commitsWithTargets) {
        await deliverCommitViaGroupSpace({
          preCommitStateSerialized: preCommitState,
          groupId,
          commitMessage,
          createEnvelope: (envelope) => pds.createEnvelope(envelope),
        });
      }
      } catch (err) {
        // addMember/投递失败：从动作前快照回滚内存态与存储态、释放宣言，
        // 绝不让「本地已换代而 commit 未投出」落盘
        console.warn('addAcceptedMembersToGroup: commit 失败，回滚', err);
        const impl = await getNobleMlsImpl();
        const rolledBack = await MlsSession.deserialize(stateBeforeAdds, impl);
        poller.addSession(groupId, rolledBack);
        await storage.putMlsSession(groupId, stateBeforeAdds);
        await releaseClaim();
        throw err;
      }

      await storage.setCommitSeq(claimSeq);

      // 先落盘新成员列表再备份（与 dme-client 同步，2026-10-21）：备份快照
      // 包含 groupInfos，若备份先于 putGroupInfo 执行，云端快照里的成员
      // 列表不含新成员，兄弟端恢复备份后群管理页看不到拉进来的人
      const updatedInfo: GroupInfo = {
        ...groupInfo,
        members: [...groupInfo.members, ...newMembers],
      };
      await storage.putGroupInfo(updatedInfo);

      // 成员列表收敛广播（与 dme-client 同步，2026-10-21，同 removeMember）：
      // commit wrapper 只推进 MLS 状态，兄弟端/其他成员的本地
      // GroupInfo.members 不会更新。广播 group_metadata_update，best-effort。
      try {
        const metaMsg = createMetadataUpdate({
          groupId,
          groupName: groupInfo.groupName,
          members: updatedInfo.members,
        });
        await sendEncryptedTo(groupId, metaMsg);
      } catch (err) {
        console.warn('addAcceptedMembersToGroup: metadata 广播失败（best-effort）', err);
      }

      // 备份点：拉人 commit 全部投递成功，群会话状态推进，立即联动备份
      await triggerBackupAfterAdvance(`addAcceptedMembers ${groupId}`);

      for (const invite of accepted) {
        await storage.updatePendingInviteStatus(invite.inviteId, 'cancelled');
      }

      setGroupInfos((prev) => prev.map((g) => (g.groupId === groupId ? updatedInfo : g)));
      setPendingInvites((prev) => prev.filter((i) => i.groupId !== groupId));
      setChatListVersion((v) => v + 1);
    },
    [session, storage, identityKeys, pds, poller, pendingInvites, sendEncryptedTo, triggerBackupAfterAdvance, acquireClaimForCommit, releaseClaim],
  );

  const dissolveGroup = useCallback(
    async (groupId: string): Promise<void> => {
      if (!session || !storage || !pds || !poller) {
        throw new Error('dissolveGroup: 未初始化');
      }

      const groupInfo = await storage.getGroupInfo(groupId);
      if (!groupInfo) throw new Error('dissolveGroup: 群信息不存在');

      const dissolveMsg: GroupDissolved = {
        type: 'group_dissolved',
        groupId,
        groupName: groupInfo.groupName,
      };

      // Phase 1.0：解散通知改走群 queueId 空间（无 MLS commit、epoch 不变，
      // 当前 epoch 全员可达，不再依赖成对 1v1 会话）
      const groupSession = poller.getSession(groupId);
      if (groupSession) {
        const encResult = await groupSession.encrypt(
          new TextEncoder().encode(JSON.stringify(dissolveMsg)),
        );
        await storage.putMlsSession(groupId, groupSession.serialize());
        await pds.createEnvelope({
          $type: 'dme.queue.envelope',
          queueId: encResult.queueId,
          payload: bytesToBase64url(encResult.ciphertext),
          createdAt: new Date().toISOString(),
          messageType: 'application',
        });
      }

      const dissolvedInfo: GroupInfo = { ...groupInfo, dissolved: true };
      await storage.putGroupInfo(dissolvedInfo);
      poller.removeSession(groupId);
      await storage.deleteMlsSession(groupId);

      setGroupInfos((prev) => prev.map((g) => (g.groupId === groupId ? dissolvedInfo : g)));
      setChatListVersion((v) => v + 1);
    },
    [session, storage, pds, poller, sendEncryptedTo],
  );

  const removeMemberFromGroup = useCallback(
    async (groupId: string, memberDid: string): Promise<void> => {
      if (!session || !storage || !pds || !poller) {
        throw new Error('removeMemberFromGroup: 未初始化');
      }

      const groupInfo = await storage.getGroupInfo(groupId);
      if (!groupInfo) throw new Error('removeMemberFromGroup: 群信息不存在');

      const mlsSession = poller.getSession(groupId);
      if (!mlsSession) throw new Error('removeMemberFromGroup: 缺少群的 MLS 会话');

      const leafIndex = mlsSession.getMemberDids().indexOf(memberDid);
      if (leafIndex < 0) throw new Error('removeMemberFromGroup: 该成员不在群里');

      // Phase 1.0：先快照「提交前状态」，commit 投群 queueId 空间（见 commit-delivery.ts）
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
          // 定向标记（与 dme-client 同步）：接收端防线 1 依赖此字段做
          // 定向校验，防止重放的陈旧 removed 误删重新入群后的新会话
          memberDid,
        };
        await sendEncryptedTo(memberDid, removedMsg);

        await deliverCommitViaGroupSpace({
          preCommitStateSerialized: preCommitState,
          groupId,
          commitMessage,
          createEnvelope: (envelope) => pds.createEnvelope(envelope),
        });
      } catch (err) {
        // commit/投递失败：从提交前快照回滚内存态与存储态、释放宣言，
        // 绝不让「本地已换代而 commit 未投出」落盘
        console.warn('removeMemberFromGroup: commit 失败，回滚', err);
        const impl = await getNobleMlsImpl();
        const rolledBack = await MlsSession.deserialize(preCommitState, impl);
        poller.addSession(groupId, rolledBack);
        await storage.putMlsSession(groupId, preCommitState);
        await releaseClaim();
        throw err;
      }

      await storage.setCommitSeq(claimSeq);

      // 先落盘新成员列表再备份（与 dme-client 同步，2026-10-21）：备份快照
      // 包含 groupInfos，若备份先于 putGroupInfo 执行，云端快照里的成员
      // 列表仍是旧的（含被踢者），兄弟端按 sibling-rotated 提示恢复备份
      // 后照样显示已移除的成员
      const updatedInfo: GroupInfo = {
        ...groupInfo,
        members: groupInfo.members.filter((m) => m.did !== memberDid),
      };
      await storage.putGroupInfo(updatedInfo);
      setGroupInfos((prev) => prev.map((g) => (g.groupId === groupId ? updatedInfo : g)));
      setChatListVersion((v) => v + 1);

      // 成员列表收敛广播（与 dme-client 同步，2026-10-21）：commit wrapper
      // 只推进各端 MLS 加密状态，从不更新各端本地 GroupInfo.members（群
      // 管理页据此渲染）——被踢者一直留在兄弟端/其他成员的群管理列表里。
      // 复用现成的 group_metadata_update 协议消息广播新成员列表，经群
      // queueId 空间投递：其他成员与同账号兄弟端（自叶扫描）收到后走现成
      // handler 更新 GroupInfo；本机凭 own-leaf gen 游标跳过；被踢者已不在
      // 树中解不开此消息，其通知走上面的 1v1 group_member_removed。
      // best-effort：广播失败不回滚已成功的踢人。
      try {
        const metaMsg = createMetadataUpdate({
          groupId,
          groupName: groupInfo.groupName,
          members: updatedInfo.members,
        });
        await sendEncryptedTo(groupId, metaMsg);
      } catch (err) {
        console.warn('removeMemberFromGroup: metadata 广播失败（best-effort）', err);
      }

      // 备份点：踢人 commit 投递成功，群会话状态推进，立即联动备份
      await triggerBackupAfterAdvance(`removeMember ${groupId}`);
    },
    [session, storage, pds, poller, sendEncryptedTo, triggerBackupAfterAdvance, acquireClaimForCommit, releaseClaim],
  );

  const leaveGroup = useCallback(
    async (groupId: string): Promise<void> => {
      if (!session || !storage || !pds || !poller) {
        throw new Error('leaveGroup: 未初始化');
      }

      const groupInfo = await storage.getGroupInfo(groupId);
      if (!groupInfo) throw new Error('leaveGroup: 群信息不存在');

      const leftMsg = {
        type: 'group_member_left' as const,
        groupId,
        memberDid: session.did,
        groupName: groupInfo.groupName,
      };
      for (const member of groupInfo.members) {
        if (member.did === session.did) continue;
        await sendEncryptedTo(member.did, leftMsg);
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

      setGroupInfos((prev) => prev.map((g) => (g.groupId === groupId ? leftInfo : g)));
      setChatListVersion((v) => v + 1);
    },
    [session, storage, pds, poller, language, sendEncryptedTo],
  );

  // -------------------------------------------------------------------------
  // 手动轮询（小程序无后台推送）
  // -------------------------------------------------------------------------

  const pollNow = useCallback(async (): Promise<void> => {
    if (!poller) return;
    await poller.pollOnce();
  }, [poller]);

  // -------------------------------------------------------------------------
  // 清理
  // -------------------------------------------------------------------------

  useEffect(() => {
    return () => {
      poller?.stop();
    };
  }, [poller]);

  // -------------------------------------------------------------------------
  // App Show → 恢复轮询（修复「等待握手卡住，重启才收到消息」）
  //
  // chat-list 在 onAppHide 时会 poller.stop()；但此前**没有任何地方**
  // 在 onAppShow 里把它恢复 —— 小程序切后台再回来（加好友时去看帖子/
  // 扫码是高频操作），间隔轮询就永远死了，只剩 useDidShow 的单次
  // pollNow。对方晚一点才完成握手时，welcome 再也收不到，
  // 直到冷启动重新 bootstrapForDid。这里在 Provider 层全局恢复，
  // 覆盖所有页面（热启动可能直接恢复到任意页面）。
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!poller) return;
    const show = (): void => {
      poller.resume();
    };
    Taro.onAppShow?.(show);
    return () => {
      Taro.offAppShow?.(show);
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
      // 同步镜像：await 链里立即读到刚装配好的实例（storage state 此刻可能还是旧值）
      storageSync: storageRef.current,
      identityKeysSync: identityKeysRef.current,
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
      blockList,
      soundEnabled,
      sessionExpired,
      loginStep,
      loginFormSnapshot,
      login,
      cancel2FA,
      logout,
      clearSession,
      restoreSession,
      ensureValidSession,
      setupIdentity,
      declareKeys: declareKeysAction,
      backupIdentity,
      backupIdentityGuarded,
      peekBackupConflict,
      backupIdentityForced,
      restoreIdentityFromBackup,
      hasIdentityBackup,
      sendMessage,
      deleteMessage,
      sendFileMessage,
      retryUploadFileMessage,
      downloadFile,
      sendReaction,
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
      refreshBlockList,
      blockMember,
      unblockMember,
      setActiveConversation,
      setSoundEnabled,
      sendGroupInvites,
      respondToGroupInvite,
      createGroupFromPendingInvites,
      cancelGroupInvite,
      addMemberToGroup,
      addAcceptedMembersToGroup,
      dissolveGroup,
      removeMemberFromGroup,
      leaveGroup,
      pollNow,
    }),
    [
      session,
      storage,
      identityKeys,
      // 注意：ref.current 不是响应式依赖，但 value 会在其它 state 变化时重建，
      // 而这里每次 render 都会重新读取最新 ref，因此语义上总是拿到最新值。
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
      blockList,
      soundEnabled,
      sessionExpired,
      loginStep,
      loginFormSnapshot,
      login,
      cancel2FA,
      logout,
      clearSession,
      restoreSession,
      ensureValidSession,
      setupIdentity,
      declareKeysAction,
      backupIdentity,
      backupIdentityGuarded,
      backupIdentityForced,
      restoreIdentityFromBackup,
      hasIdentityBackup,
      sendMessage,
      deleteMessage,
      sendFileMessage,
      retryUploadFileMessage,
      downloadFile,
      sendReaction,
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
      refreshBlockList,
      blockMember,
      unblockMember,
      setActiveConversation,
      setSoundEnabled,
      sendGroupInvites,
      respondToGroupInvite,
      createGroupFromPendingInvites,
      cancelGroupInvite,
      addMemberToGroup,
      addAcceptedMembersToGroup,
      dissolveGroup,
      removeMemberFromGroup,
      leaveGroup,
      pollNow,
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
