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
import AsyncStorage from '@react-native-async-storage/async-storage';
import { sha256 } from '@noble/hashes/sha256';
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
import type { PendingWelcome, KeyPackagePoolEntry, StoredMessage } from '../storage/db';
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
import { type DmeBlobRef, type DmeEnvelope, type FileManifestMessage, FILE_MANIFEST_TYPE } from '../protocol/types';
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
} from '../protocol/group-message';
import {
  createInviteRequest,
  createAcceptResponse,
  createRejectResponse,
  createGroupWelcome,
  createMetadataUpdate,
  generateEncryptedKeyPackageForInvite,
  deserializeAcceptedKeyPackage,
} from '../handshake/group-invite';
import { playMessageSound } from '../utils/sound';
import { useI18n } from '../i18n/I18nContext';
import { t } from '../i18n/format';

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
  appViewProxy: string;
  serverUrl: string;
  gatewayUrl: string;
  pendingInvites: PendingInvite[];
  groupInfos: GroupInfo[];
  receivedGroupInvites: PendingInvite[];
  blockList: string[];
  soundEnabled: boolean;
}

interface AppActions {
  login: (identifier: string, password: string, pdsUrl?: string) => Promise<void>;
  logout: () => Promise<void>;
  restoreSession: () => Promise<boolean>;
  setupIdentity: () => Promise<void>;
  declareKeys: (plcToken: string) => Promise<void>;
  backupIdentity: (password: string) => Promise<void>;
  restoreIdentityFromBackup: (password: string) => Promise<boolean>;
  hasIdentityBackup: () => Promise<boolean>;
  sendMessage: (groupId: string, text: string) => Promise<void>;
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
  setAppViewProxy: (proxy: string) => Promise<void>;
  setServerUrl: (url: string) => Promise<void>;
  setGatewayUrl: (url: string) => Promise<void>;
  sendGroupInvites: (groupName: string, friendDids: readonly string[]) => Promise<string>;
  respondToGroupInvite: (inviteId: string, accepted: boolean) => Promise<void>;
  createGroupFromPendingInvites: (groupId: string) => Promise<void>;
  cancelGroupInvite: (inviteId: string) => Promise<void>;
  addMemberToGroup: (groupId: string, friendDid: string) => Promise<void>;
  addAcceptedMembersToGroup: (groupId: string) => Promise<void>;
  dissolveGroup: (groupId: string) => Promise<void>;
  removeMemberFromGroup: (groupId: string, memberDid: string) => Promise<void>;
  leaveGroup: (groupId: string) => Promise<void>;
  refreshBlockList: () => Promise<void>;
  blockMember: (did: string) => Promise<void>;
  unblockMember: (did: string) => Promise<void>;
  setActiveConversation: (conversationId: string | null) => void;
  setSoundEnabled: (enabled: boolean) => Promise<void>;
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
  const [appViewProxy, setAppViewProxyState] = useState<string>(DEFAULT_APPVIEW_PROXY);
  const [serverUrl, setServerUrlState] = useState<string>(DME_SERVER_URL);
  const [gatewayUrl, setGatewayUrlState] = useState<string>(DEFAULT_DME_GATEWAY_URL);
  const [pendingInvites, setPendingInvites] = useState<PendingInvite[]>([]);
  const [groupInfos, setGroupInfos] = useState<GroupInfo[]>([]);
  const [receivedGroupInvites, setReceivedGroupInvites] = useState<PendingInvite[]>([]);
  const [blockList, setBlockList] = useState<string[]>([]);
  const [soundEnabled, setSoundEnabledState] = useState(true);

  const processWelcomeRef = useRef<(welcome: IncomingWelcome) => Promise<void>>(async () => {});
  const handleIncomingMessageRef = useRef<(msg: IncomingMessage, userDid: string, storage: DmeStorage) => Promise<void>>(async () => {});

  const activeConversationRef = useRef<string | null>(null);

  const setActiveConversation = useCallback((conversationId: string | null): void => {
    activeConversationRef.current = conversationId;
  }, []);

  const setSoundEnabled = useCallback(async (enabled: boolean): Promise<void> => {
    if (!storage) return;
    await storage.setSoundEnabled(enabled);
    setSoundEnabledState(enabled);
  }, [storage]);

  // -------------------------------------------------------------------------
  // KeyPackage pool
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

  const setPollBatchSize = useCallback(async (size: number): Promise<void> => {
    if (!storage || !poller) return;
    await storage.setPollBatchSize(size);
    poller.setBatchSize(size);
    setPollBatchSizeState(size);
  }, [storage, poller]);

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

  const login = useCallback(async (identifier: string, password: string, pdsUrl?: string): Promise<void> => {
    setLoading(true);
    setError(null);

    try {
      const resolvedPds = pdsUrl?.trim() || PDS_URL;
      const userDidPlaceholder = 'did:plc:unknown';
      const newSession = new DmeSession();
      const tempStorage = new DmeStorage(userDidPlaceholder);
      newSession.setStorage(tempStorage);
      await newSession.login(identifier, password, tempStorage, resolvedPds);

      const userDid = newSession.did;
      const correctStorage = new DmeStorage(userDid);
      newSession.setStorage(correctStorage);

      // Migrate placeholder data
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
      const newPoller = new DmePoller(newPds, correctStorage, batchSize);

      newPoller.start(
        async (msg: IncomingMessage) => {
          await handleIncomingMessageRef.current(msg, userDid, correctStorage);
        },
        async (welcome: IncomingWelcome) => {
          await processWelcomeRef.current(welcome);
        },
      );

      // Restore MLS sessions
      const groupIds = await correctStorage.listGroups();
      const impl = await getNobleMlsImpl();
      for (const gid of groupIds) {
        const serialized = await correctStorage.getMlsSession(gid);
        if (serialized) {
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
      const allInvites = await correctStorage.getPendingInvites();
      const sentInvites = allInvites.filter((i) => i.inviterDid === userDid);
      const recvInvites = allInvites.filter((i) => i.inviteeDid === userDid);
      const storedGroupInfos = await correctStorage.listGroupInfos();

      setSession(newSession);
      setStorage(correctStorage);
      setIdentityKeys(keys);
      setPds(newPds);
      setPoller(newPoller);
      setGroups(groupIds);
      setPendingWelcomes(welcomes);
      setKeyPackagePool(pool);
      setPollBatchSizeState(batchSize);
      setAppViewProxyState(appViewProxyValue);
      setServerUrlState(serverUrlValue);
      setGatewayUrlState(gatewayUrlValue);
      setPendingInvites(sentInvites);
      setReceivedGroupInvites(recvInvites);
      setGroupInfos(storedGroupInfos);
      setBlockList(await correctStorage.getBlockList());
      setSoundEnabledState(await correctStorage.getSoundEnabled());
    } catch (err) {
      setError(err instanceof Error ? err.message : t(language, 'login.failed'));
      throw err;
    } finally {
      setLoading(false);
    }
  }, [language]);

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
      setGroupInfos([]);
      setPollBatchSizeState(3);
      setAppViewProxyState(DEFAULT_APPVIEW_PROXY);
      setServerUrlState(DME_SERVER_URL);
      setGatewayUrlState(DEFAULT_DME_GATEWAY_URL);
      setLoading(false);
    }
  }, [session, storage, poller]);

  const restoreSession = useCallback(async (): Promise<boolean> => {
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
      const keys = await AsyncStorage.getAllKeys();
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

        const appViewProxyValue = await tempStorage.getAppViewProxy();
        const serverUrlValue = await tempStorage.getDmeServerUrl();
        const gatewayUrlValue = await tempStorage.getDmeGatewayUrl();
        const newPds = new DmePds(tempSession.agent, serverUrlValue, gatewayUrlValue, appViewProxyValue);
        const storedKeys = await tempStorage.getIdentityKeys();
        const idKeys = storedKeys ?? generateIdentityKeys();
        if (!storedKeys) {
          await tempStorage.putIdentityKeys(idKeys);
        }

        const batchSize = await tempStorage.getPollBatchSize();
        const newPoller = new DmePoller(newPds, tempStorage, batchSize);

        newPoller.start(
          async (msg: IncomingMessage) => {
            await handleIncomingMessageRef.current(msg, did, tempStorage);
          },
          async (welcome: IncomingWelcome) => {
            await processWelcomeRef.current(welcome);
          },
        );

        // Restore MLS sessions
        const groupIds = await tempStorage.listGroups();
        const impl = await getNobleMlsImpl();
        for (const gid of groupIds) {
          const serialized = await tempStorage.getMlsSession(gid);
          if (serialized) {
            try {
              const mlsSession = await MlsSession.deserialize(serialized, impl);
              newPoller.addSession(gid, mlsSession);
            } catch (err) {
              console.error('AppContext: failed to restore MLS session for', gid, err);
            }
          }
        }

        const welcomes = await tempStorage.getPendingWelcomes();
        for (const w of welcomes) {
          newPoller.addPendingWelcome(w);
        }

        const pool = await tempStorage.getKeyPackagePool();

        const allInvites = await tempStorage.getPendingInvites();
        const sentInvites = allInvites.filter((i) => i.inviterDid === did);
        const recvInvites = allInvites.filter((i) => i.inviteeDid === did);
        const storedGroupInfos = await tempStorage.listGroupInfos();

        setSession(tempSession);
        setStorage(tempStorage);
        setIdentityKeys(idKeys);
        setPds(newPds);
        setPoller(newPoller);
        setGroups(groupIds);
        setPendingWelcomes(welcomes);
        setKeyPackagePool(pool);
        setPollBatchSizeState(batchSize);
        setAppViewProxyState(appViewProxyValue);
        setServerUrlState(serverUrlValue);
        setGatewayUrlState(gatewayUrlValue);
        setPendingInvites(sentInvites);
        setReceivedGroupInvites(recvInvites);
        setGroupInfos(storedGroupInfos);
        setBlockList(await tempStorage.getBlockList());
        setSoundEnabledState(await tempStorage.getSoundEnabled());

        try {
          const transferGroupIds = await tempStorage.listGroups();
          for (const groupId of transferGroupIds) {
            const msgs = await tempStorage.getMessages(groupId);
            for (const msg of msgs) {
              if (msg.kind !== 'file' || !msg.fileMeta) continue;
              if (msg.fileMeta.downloadStatus === 'downloading') {
                await tempStorage.updateFileMessageMeta(groupId, msg.id, { downloadStatus: 'pending', downloadProgress: undefined });
              }
              if (msg.fileMeta.uploadStatus === 'uploading') {
                await tempStorage.updateFileMessageMeta(groupId, msg.id, { uploadStatus: 'failed' });
              }
            }
          }
        } catch (err) {
          console.error('AppContext: failed to reset interrupted file transfers', err);
        }

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

    const groupIds = await storage.listGroups();
    const mlsSessions: Record<string, string> = {};
    for (const gid of groupIds) {
      const serialized = await storage.getMlsSession(gid);
      if (serialized) {
        mlsSessions[gid] = serialized;
      }
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
    };

    const encryptedData = encryptBackup(data, password);
    await pds.putIdentityBackup(encryptedData);
  }, [identityKeys, pds, storage]);

  const restoreIdentityFromBackup = useCallback(async (password: string): Promise<boolean> => {
    if (!pds) throw new Error('restoreIdentityFromBackup: pds not initialized');
    if (!storage) throw new Error('restoreIdentityFromBackup: storage not initialized');
    if (!poller) throw new Error('restoreIdentityFromBackup: poller not initialized');

    const encryptedData = await pds.getIdentityBackup();
    if (!encryptedData) return false;

    const data = decryptBackup(encryptedData, password);

    // 恢复身份密钥
    await storage.putIdentityKeys(data.identity);
    setIdentityKeys(data.identity);

    // 恢复 MLS sessions 并加载到 poller
    for (const [groupId, serialized] of Object.entries(data.mlsSessions)) {
      await storage.putMlsSession(groupId, serialized);
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

    // 恢复群聊元数据
    for (const info of data.groupInfos) {
      await storage.putGroupInfo(info);
    }
    setGroupInfos(data.groupInfos);

    await storage.setBlockList(data.blockList);
    setBlockList(data.blockList);

    // 更新会话列表
    setGroups(Object.keys(data.mlsSessions));
    setChatListVersion((v) => v + 1);

    return true;
  }, [pds, storage, poller]);

  const hasIdentityBackup = useCallback(async (): Promise<boolean> => {
    if (!pds) return false;
    const data = await pds.getIdentityBackup();
    return data !== null;
  }, [pds]);

  // -------------------------------------------------------------------------
  // Invite / Accept
  // -------------------------------------------------------------------------

  const generateInviteQr = useCallback(async (
    bobDid: string,
  ): Promise<{ qrString: string; keyPackageInitKey: Uint8Array; keyPackageSerialized: string; welcomeQueueId: string }> => {
    if (!storage || !identityKeys || !session || !poller) {
      throw new Error('generateInviteQr: not fully initialized');
    }

    // Ensure pool has entries
    await refreshKeyPackagePool();
    const pool = await storage.getKeyPackagePool();
    const available = pool.find((e) => !e.consumed);
    if (!available) throw new Error('generateInviteQr: no KeyPackage available in pool');

    // Deserialize KeyPackage pair from pool
    const pair: KeyPackagePair = {
      publicPackage: deserializeWithUint8Array<KeyPackage>(available.publicPackageSerialized),
      privatePackage: deserializeWithUint8Array<PrivateKeyPackage>(available.privatePackageSerialized),
    };

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

    // Mark pool entry as consumed (QR is generated for this specific invitation)
    await storage.markKeyPackageConsumed(available.id);
    setKeyPackagePool(await storage.getKeyPackagePool());

    // Pending welcome is NOT tracked here; caller should track it only after
    // the invite post is actually published (see trackInvitePendingWelcome).
    return { qrString, keyPackageInitKey, keyPackageSerialized, welcomeQueueId };
  }, [storage, identityKeys, session, poller, refreshKeyPackagePool]);

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

  const acceptInviteQr = useCallback(async (qrString: string): Promise<void> => {
    if (!storage || !identityKeys || !session || !pds || !poller) {
      throw new Error('acceptInviteQr: not fully initialized');
    }

    const result = await acceptInvite(session.did, identityKeys, qrString);

    // Store MLS session
    await storage.putMlsSession(result.groupId, result.mlsSession.serialize());
    poller.addSession(result.groupId, result.mlsSession);

    // Store Welcome as PDS envelope so Alice can poll for it
    const envelope: DmeEnvelope = {
      $type: 'dme.queue.envelope',
      queueId: result.welcomeQueueId,
      payload: result.welcomePayload,
      createdAt: new Date().toISOString(),
      messageType: 'welcome',
    };
    await pds.createEnvelope(envelope);

    setGroups((prev) => [...prev, result.groupId]);
    setChatListVersion((v) => v + 1);
  }, [storage, identityKeys, session, pds, poller]);

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
      console.error('processReceivedWelcome: no pending welcome for', welcome.queueId);
      return;
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

    await storage.deletePendingWelcome(welcome.queueId);
    poller.removePendingWelcome(welcome.queueId);

    setGroups((prev) => [...prev, result.groupId]);
    setPendingWelcomes((prev) => prev.filter((w) => w.queueId !== welcome.queueId));
    setChatListVersion((v) => v + 1);
  }, [storage, identityKeys, session, poller]);

  processWelcomeRef.current = processReceivedWelcome;

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
          const shouldPlay = soundEnabled && (activeConversationRef.current === null || activeConversationRef.current === msg.groupId);
          if (shouldPlay) {
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
              prev.map((i) => i.inviteId === resp.inviteId ? updated : i),
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
              const matchingInvites = allInvites.filter(
                (i) => i.groupId === welcome.groupId && i.inviteeDid === userDid && i.ownKeyPackagePairSerialized,
              );
              const ownInvite = matchingInvites.length > 0
                ? matchingInvites[matchingInvites.length - 1]
                : null;

              if (ownInvite?.ownKeyPackagePairSerialized) {
                const { deserializeOwnKeyPackagePair } = await import('../handshake/group-invite');
                const pair = deserializeOwnKeyPackagePair(ownInvite.ownKeyPackagePairSerialized);

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
                // Keep invite in storage (status stays 'accepted'): the group_invite message
                // persists in the 1:1 conversation, so receivedGroupInvites must survive
                // restart to keep the card showing "Responded" instead of Accept/Decline.
              }
            } catch (err) {
              console.error('handleIncomingMessage: failed to join group via welcome:', err);
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
          setGroupInfos((prev) => prev.some((g) => g.groupId === welcome.groupId) ? prev : [...prev, groupInfo]);
          setGroups((prev) => prev.includes(welcome.groupId) ? prev : [...prev, welcome.groupId]);
          break;
        }
        case 'group_metadata_update': {
          const update = parsed as unknown as GroupMetadataUpdate;
          const existing = await msgStorage.getGroupInfo(update.groupId);
          if (existing) {
            const updated: GroupInfo = { ...existing, members: update.members, groupName: update.groupName };
            await msgStorage.putGroupInfo(updated);
            setGroupInfos((prev) =>
              prev.map((g) => g.groupId === update.groupId ? updated : g),
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
          const commit = parsed as unknown as { type: string; groupId: string; commitPayload: string };

          if (poller) {
            const groupSession = poller.getSession(commit.groupId);
            if (groupSession) {
              try {
                const commitBytes = base64urlToBytes(commit.commitPayload);
                await groupSession.decrypt(commitBytes);
                await msgStorage.putMlsSession(commit.groupId, groupSession.serialize());
              } catch (err) {
                console.error('handleIncomingMessage: failed to process group commit:', err);
              }
            }
          }
          break;
        }
        case 'group_dissolved': {
          const dissolved = parsed as unknown as GroupDissolved;

          if (poller) {
            poller.removeSession(dissolved.groupId);
          }
          await msgStorage.deleteMlsSession(dissolved.groupId);

          const existing = await msgStorage.getGroupInfo(dissolved.groupId);
          if (existing) {
            const dissolvedInfo: GroupInfo = { ...existing, dissolved: true };
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

          if (poller) {
            poller.removeSession(removed.groupId);
          }
          await msgStorage.deleteMlsSession(removed.groupId);

          const existing = await msgStorage.getGroupInfo(removed.groupId);
          if (existing) {
            const removedInfo: GroupInfo = { ...existing, removed: true };
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

                    const plaintextBytes = new TextEncoder().encode(JSON.stringify(commitMsg));
                    const encResult = await memberSession.encrypt(plaintextBytes);
                    await msgStorage.putMlsSession(member.did, memberSession.serialize());

                    const envelope: DmeEnvelope = {
                      $type: 'dme.queue.envelope',
                      queueId: encResult.queueId,
                      payload: bytesToBase64url(encResult.ciphertext),
                      createdAt: new Date().toISOString(),
                      messageType: 'application',
                    };
                    await pds.createEnvelope(envelope);
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
        sent: false,
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
    } else {
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
const shouldPlayText = soundEnabled && (activeConversationRef.current === null || activeConversationRef.current === msg.groupId);
          if (shouldPlayText) {
        void playMessageSound();
      }
    }
    setChatListVersion((v) => v + 1);
  }, [identityKeys, poller, pds, soundEnabled, downloadFile, language]);

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
    await pds.createEnvelope(envelope);

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
    await pds.createEnvelope({
      $type: 'dme.queue.envelope',
      queueId: encResult.queueId,
      payload: bytesToBase64url(encResult.ciphertext),
      blobCids: uploadResult.blobRefs,
      createdAt: new Date().toISOString(),
      messageType: 'application',
    });

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
    await pds.createEnvelope({
      $type: 'dme.queue.envelope',
      queueId: encResult.queueId,
      payload: bytesToBase64url(encResult.ciphertext),
      blobCids: uploadResult.blobRefs,
      createdAt: new Date().toISOString(),
      messageType: 'application',
    });

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
      const inviterEncKey = await getRemoteEncryptionKey(invite.inviterDid);
      if (!inviterEncKey) throw new Error('respondToGroupInvite: inviter has no encryption key');

      const { encryptedKeyPackage, keyPackagePairSerialized } = await generateEncryptedKeyPackageForInvite({
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

      const updatedInvite: PendingInvite = {
        ...invite,
        status: 'accepted',
        ownKeyPackagePairSerialized: keyPackagePairSerialized,
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
  }, [session, storage, identityKeys, pds, poller, receivedGroupInvites]);

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

    const { mlsSession: newSession, welcomes, commits } = await createGroupWithMembers({
      groupId,
      ownerDid: session.did,
      ownerIdentityKeys: identityKeys,
      acceptedMembers,
    });

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

    for (const { commitMessage, memberDids } of commits) {
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
        };
        await pds.createEnvelope(envelope);
      }
    }

    setGroups((prev) => [...prev, groupId]);
    setChatListVersion((v) => v + 1);
  }, [session, storage, identityKeys, pds, poller, pendingInvites, language]);

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

    const keyPackageSerialized = await generateEncryptedKeyPackageForInvite({
      ownDid: friendDid,
      ownIdentityKeys: identityKeys,
      inviterEncryptionPublicKey: inviterEncKey,
    });

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

    for (const member of groupInfo.members) {
      if (member.did === session.did) continue;
      const mlsSession = poller.getSession(member.did);
      if (!mlsSession) continue;

      const plaintextBytes = new TextEncoder().encode(JSON.stringify(dissolveMsg));
      const encResult = await mlsSession.encrypt(plaintextBytes);
      await storage.putMlsSession(member.did, mlsSession.serialize());

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

    const { commitMessage } = await mlsSession.removeMember(leafIndex);
    await storage.putMlsSession(groupId, mlsSession.serialize());

    const removedMsg: GroupMemberRemoved = {
      type: 'group_member_removed',
      groupId,
      groupName: groupInfo.groupName,
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

    const commitMsg = {
      type: 'group_commit' as const,
      groupId,
      commitPayload: bytesToBase64url(commitMessage),
    };

    for (const member of groupInfo.members) {
      if (member.did === session.did || member.did === memberDid) continue;
      const memberSession = poller.getSession(member.did);
      if (!memberSession) continue;

      const plaintextBytes = new TextEncoder().encode(JSON.stringify(commitMsg));
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

    const updatedMembers = groupInfo.members.filter((m) => m.did !== memberDid);
    const updatedInfo: GroupInfo = { ...groupInfo, members: updatedMembers };
    await storage.putGroupInfo(updatedInfo);
    setGroupInfos((prev) => prev.map((g) => g.groupId === groupId ? updatedInfo : g));
    setChatListVersion((v) => v + 1);
  }, [session, storage, pds, poller]);

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
        targetDids: [...existingDids].filter((d) => d !== session.did),
      });

      newMembers.push({ did: invite.inviteeDid, displayName: invite.inviteeDid, role: 'member' as const });
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
        const memberSession = poller.getSession(targetDid);
        if (!memberSession) continue;

        const plaintextBytes = new TextEncoder().encode(JSON.stringify(commitMsg));
        const encResult = await memberSession.encrypt(plaintextBytes);
        await storage.putMlsSession(targetDid, memberSession.serialize());

        const envelope: DmeEnvelope = {
          $type: 'dme.queue.envelope',
          queueId: encResult.queueId,
          payload: bytesToBase64url(encResult.ciphertext),
          createdAt: new Date().toISOString(),
          messageType: 'application',
        };
        await pds.createEnvelope(envelope);
      }
    }

    const updatedInfo: GroupInfo = { ...groupInfo, members: [...groupInfo.members, ...newMembers] };
    await storage.putGroupInfo(updatedInfo);

    for (const invite of accepted) {
      await storage.updatePendingInviteStatus(invite.inviteId, 'cancelled');
    }

    setGroupInfos((prev) => prev.map((g) => g.groupId === groupId ? updatedInfo : g));
    setPendingInvites((prev) => prev.filter((i) => i.groupId !== groupId));
    setChatListVersion((v) => v + 1);
  }, [session, storage, identityKeys, pds, poller, pendingInvites]);

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
      appViewProxy,
      serverUrl,
      gatewayUrl,
      pendingInvites,
      groupInfos,
      receivedGroupInvites,
blockList,
      soundEnabled,
      login,
      logout,
      restoreSession,
      setupIdentity,
      declareKeys: declareKeysAction,
      backupIdentity,
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
      setAppViewProxy,
      setServerUrl,
      setGatewayUrl,
      sendGroupInvites,
      respondToGroupInvite,
      createGroupFromPendingInvites,
      cancelGroupInvite,
      addMemberToGroup,
      addAcceptedMembersToGroup,
      dissolveGroup,
      removeMemberFromGroup,
      leaveGroup,
      refreshBlockList,
      blockMember,
      unblockMember,
      setActiveConversation,
      setSoundEnabled,
    }),
    [
      session, storage, identityKeys, poller, pds, loading, error,
      groups, pendingWelcomes, keyPackagePool, chatListVersion, pollBatchSize, appViewProxy, serverUrl, gatewayUrl,
      pendingInvites, groupInfos, receivedGroupInvites, blockList, soundEnabled,
      login, logout, restoreSession, setupIdentity, declareKeysAction,
      backupIdentity, restoreIdentityFromBackup, hasIdentityBackup,
      sendMessage, sendFileMessage, retryUploadFileMessage, sendReaction, downloadFile, deleteFriend, markConversationAsRead, generateInviteQr, trackInvitePendingWelcome, deletePendingWelcome, acceptInviteQr,
      refreshKeyPackagePool, setPollBatchSize, setAppViewProxy, setServerUrl, setGatewayUrl,
      sendGroupInvites, respondToGroupInvite, createGroupFromPendingInvites,
      cancelGroupInvite, addMemberToGroup, addAcceptedMembersToGroup, dissolveGroup, removeMemberFromGroup,
      leaveGroup, refreshBlockList, blockMember, unblockMember, setActiveConversation, setSoundEnabled,
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
