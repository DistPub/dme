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
import { encodeQrPayload } from '../handshake/qr-encode';
import { DmePoller } from '../poll/poller';
import type { IncomingMessage, IncomingWelcome } from '../poll/poller';
import { DmeStorage } from '../storage/db';
import type { PendingWelcome, KeyPackagePoolEntry, StoredMessage, Reaction } from '../storage/db';
import { generateIdentityKeys } from '../crypto/identity';
import type { IdentityKeys } from '../crypto/identity';
import { MlsSession } from '../crypto/mls-session';
import { getNobleMlsImpl } from '../crypto/mls-noble-kdf';
import { KEYPACKAGE_POOL_SIZE } from '../crypto/mls-config';
import {
  generateKeyPackageForUser,
  encryptKeyPackage,
  serializeEncryptedKeyPackage,
} from '../crypto/keypackage';
import type { KeyPackagePair } from '../crypto/keypackage';
import { deriveWelcomeQueueId } from '../crypto/mls-queue-id';
import { encryptBackup, decryptBackup, type FullBackupData } from '../crypto/backup';
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
      for (const gid of groupIds) {
        const serialized = await correctStorage.getMlsSession(gid);
        if (serialized) {
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
      const allInvites = await correctStorage.getPendingInvites();
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
      setGroups(groupIds);
      setPendingWelcomes(welcomes);
      setKeyPackagePool(pool);
      setPollBatchSizeState(batchSize);
      setAppViewProxyState(appViewProxyValue);
      setServerUrlState(serverUrlValue);
      setGatewayUrlState(gatewayUrlValue);
      setGroupInfos(storedGroupInfos);
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

      const groupIds = await activeStorage.listGroups();
      const mlsSessions: Record<string, string> = {};
      for (const gid of groupIds) {
        const serialized = await activeStorage.getMlsSession(gid);
        if (serialized) mlsSessions[gid] = serialized;
      }

      const data: FullBackupData = {
        identity: activeKeys,
        mlsSessions,
        keyPackagePool: await activeStorage.getKeyPackagePool(),
        groupInfos: await activeStorage.listGroupInfos(),
        blockList: await activeStorage.getBlockList(),
      };

      const encryptedData = encryptBackup(data, password);
      await activePds.putIdentityBackup(encryptedData);
    },
    [identityKeys, pds, storage],
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

      await activeStorage.putIdentityKeys(data.identity);
      putIdentityKeys(data.identity);

      for (const [groupId, serialized] of Object.entries(data.mlsSessions)) {
        await activeStorage.putMlsSession(groupId, serialized);
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

      setGroups(Object.keys(data.mlsSessions));
      setChatListVersion((v) => v + 1);

      return true;
    },
    [pds, storage, poller, putIdentityKeys],
  );

  const hasIdentityBackup = useCallback(async (): Promise<boolean> => {
    const activePds = pdsRef.current ?? pds;
    if (!activePds) return false;
    const data = await activePds.getIdentityBackup();
    return data !== null;
  }, [pds]);

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

      const result = await acceptInvite(session.did, identityKeys, qrString);

      await storage.putMlsSession(result.groupId, result.mlsSession.serialize());
      poller.addSession(result.groupId, result.mlsSession);

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
    [storage, identityKeys, session, pds, poller],
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

      await activeStorage.deletePendingWelcome(welcome.queueId);
      activePoller.removePendingWelcome(welcome.queueId);

      setGroups((prev) => (prev.includes(result.groupId) ? prev : [...prev, result.groupId]));
      setPendingWelcomes((prev) => prev.filter((w) => w.queueId !== welcome.queueId));
      setChatListVersion((v) => v + 1);

      console.log('processReceivedWelcome: 配对成功，已加入 MLS 群', result.groupId);
    },
    [storage, identityKeys, session, poller, putStorage, putIdentityKeys],
  );

  processWelcomeRef.current = processReceivedWelcome;

  // -------------------------------------------------------------------------
  // 入站消息处理（MVP：文本 + reaction）
  // -------------------------------------------------------------------------

  const handleIncomingMessage = useCallback(
    async (msg: IncomingMessage, userDid: string, msgStorage: DmeStorage): Promise<void> => {
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
            const invite: PendingInvite = {
              inviteId: req.inviteId,
              groupId: req.groupId,
              groupName: req.groupName,
              inviterDid: msg.senderDid,
              inviteeDid: userDid,
              status: 'pending',
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
              (activeConversationRef.current === null || activeConversationRef.current === msg.groupId)
            ) {
              void playMessageSound();
            }
            break;
          }

          case 'group_invite_response': {
            const resp = parsed as unknown as GroupInviteResponse;
            const existing = await msgStorage.getPendingInvite(resp.inviteId);
            if (existing) {
              const updated: PendingInvite = resp.accepted
                ? { ...existing, status: 'accepted', keyPackageSerialized: resp.keyPackageSerialized }
                : { ...existing, status: 'rejected' };
              await msgStorage.putPendingInvite(updated);
              setPendingInvites((prev) =>
                prev.map((i) => (i.inviteId === resp.inviteId ? updated : i)),
              );
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

            if (identityKeys && poller) {
              try {
                const allInvites = await msgStorage.getPendingInvites();
                const matching = allInvites.filter(
                  (i) =>
                    i.groupId === welcome.groupId &&
                    i.inviteeDid === userDid &&
                    i.ownKeyPackagePairSerialized,
                );
                const ownInvite = matching.length > 0 ? matching[matching.length - 1] : null;

                if (ownInvite?.ownKeyPackagePairSerialized) {
                  const pair = deserializeOwnKeyPackagePair(ownInvite.ownKeyPackagePairSerialized);
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
                  // 保留 invite（status 仍为 accepted）：group_invite 消息会留在 1:1 会话里，
                  // receivedGroupInvites 必须跨重启存活，卡片才能一直显示"已响应"。
                }
              } catch (err) {
                console.error('handleIncomingMessage: 通过 welcome 入群失败', err);
              }
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
            if (existing) {
              const updated: GroupInfo = {
                ...existing,
                members: update.members,
                groupName: update.groupName,
              };
              await msgStorage.putGroupInfo(updated);
              setGroupInfos((prev) =>
                prev.map((g) => (g.groupId === update.groupId ? updated : g)),
              );
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
                }
              }
            }
            break;
          }

          case 'group_dissolved': {
            const dissolved = parsed as unknown as GroupDissolved;
            poller?.removeSession(dissolved.groupId);
            await msgStorage.deleteMlsSession(dissolved.groupId);

            const existing = await msgStorage.getGroupInfo(dissolved.groupId);
            if (existing) {
              const dissolvedInfo: GroupInfo = { ...existing, dissolved: true };
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
            poller?.removeSession(removed.groupId);
            await msgStorage.deleteMlsSession(removed.groupId);

            const existing = await msgStorage.getGroupInfo(removed.groupId);
            if (existing) {
              const removedInfo: GroupInfo = { ...existing, removed: true };
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
                    const { commitMessage } = await groupSession.removeMember(leafIndex);
                    await msgStorage.putMlsSession(left.groupId, groupSession.serialize());

                    const commitMsg = {
                      type: 'group_commit' as const,
                      groupId: left.groupId,
                      commitPayload: bytesToBase64url(commitMessage),
                    };
                    for (const member of existing.members) {
                      if (member.did === userDid || member.did === left.memberDid) continue;
                      const memberSession = poller.getSession(member.did);
                      if (!memberSession) continue;

                      const encResult = await memberSession.encrypt(
                        new TextEncoder().encode(JSON.stringify(commitMsg)),
                      );
                      await msgStorage.putMlsSession(member.did, memberSession.serialize());
                      await pds.createEnvelope({
                        $type: 'dme.queue.envelope',
                        queueId: encResult.queueId,
                        payload: bytesToBase64url(encResult.ciphertext),
                        createdAt: new Date().toISOString(),
                        messageType: 'application',
                      });
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
        const inviterEncKey = await getRemoteEncryptionKey(invite.inviterDid);
        if (!inviterEncKey) throw new Error('respondToGroupInvite: 邀请人没有加密公钥');

        const { encryptedKeyPackage, keyPackagePairSerialized } =
          await generateEncryptedKeyPackageForInvite({
            ownDid: session.did,
            ownIdentityKeys: identityKeys,
            inviterEncryptionPublicKey: inviterEncKey,
          });

        const response = createAcceptResponse({
          inviteId,
          groupId: invite.groupId,
          encryptedKeyPackage,
        });

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

        const updatedInvite: PendingInvite = {
          ...invite,
          status: 'accepted',
          ownKeyPackagePairSerialized: keyPackagePairSerialized,
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
    [session, storage, identityKeys, pds, poller, receivedGroupInvites],
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

      const { mlsSession: newSession, welcomes, commits } = await createGroupWithMembers({
        groupId,
        ownerDid: session.did,
        ownerIdentityKeys: identityKeys,
        acceptedMembers,
      });

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

      setGroups((prev) => (prev.includes(groupId) ? prev : [...prev, groupId]));
      setChatListVersion((v) => v + 1);
    },
    [session, storage, identityKeys, pds, poller, pendingInvites, language, sendEncryptedTo],
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

      const newMembers: GroupMember[] = [];
      const commitsWithTargets: { commitMessage: Uint8Array; targetDids: string[] }[] = [];
      const existingDids = new Set(groupInfo.members.map((m) => m.did));

      for (const invite of accepted) {
        if (!invite.keyPackageSerialized) continue;
        const keyPackage = await deserializeAcceptedKeyPackage({
          keyPackageSerialized: invite.keyPackageSerialized,
          ownEncryptionPrivateKey: identityKeys.encryption.privateKey,
        });

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

      for (const { commitMessage, targetDids } of commitsWithTargets) {
        const commitMsg = {
          type: 'group_commit' as const,
          groupId,
          commitPayload: bytesToBase64url(commitMessage),
        };
        for (const targetDid of targetDids) {
          await sendEncryptedTo(targetDid, commitMsg);
        }
      }

      const updatedInfo: GroupInfo = {
        ...groupInfo,
        members: [...groupInfo.members, ...newMembers],
      };
      await storage.putGroupInfo(updatedInfo);

      for (const invite of accepted) {
        await storage.updatePendingInviteStatus(invite.inviteId, 'cancelled');
      }

      setGroupInfos((prev) => prev.map((g) => (g.groupId === groupId ? updatedInfo : g)));
      setPendingInvites((prev) => prev.filter((i) => i.groupId !== groupId));
      setChatListVersion((v) => v + 1);
    },
    [session, storage, identityKeys, pds, poller, pendingInvites, sendEncryptedTo],
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

      for (const member of groupInfo.members) {
        if (member.did === session.did) continue;
        await sendEncryptedTo(member.did, dissolveMsg);
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

      const { commitMessage } = await mlsSession.removeMember(leafIndex);
      await storage.putMlsSession(groupId, mlsSession.serialize());

      const removedMsg: GroupMemberRemoved = {
        type: 'group_member_removed',
        groupId,
        groupName: groupInfo.groupName,
      };
      await sendEncryptedTo(memberDid, removedMsg);

      const commitMsg = {
        type: 'group_commit' as const,
        groupId,
        commitPayload: bytesToBase64url(commitMessage),
      };
      for (const member of groupInfo.members) {
        if (member.did === session.did || member.did === memberDid) continue;
        await sendEncryptedTo(member.did, commitMsg);
      }

      const updatedInfo: GroupInfo = {
        ...groupInfo,
        members: groupInfo.members.filter((m) => m.did !== memberDid),
      };
      await storage.putGroupInfo(updatedInfo);
      setGroupInfos((prev) => prev.map((g) => (g.groupId === groupId ? updatedInfo : g)));
      setChatListVersion((v) => v + 1);
    },
    [session, storage, pds, poller, sendEncryptedTo],
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
