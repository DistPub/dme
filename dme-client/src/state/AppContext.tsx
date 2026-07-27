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
import type { KeyPackage, PrivateKeyPackage } from 'ts-mls';

import { DmeSession } from '../atproto/session';
import { DmePds } from '../atproto/pds';
import { declareKeys, getRemoteEncryptionKey } from '../atproto/did';
import { acceptInvite, processWelcome } from '../handshake/handshake';
import { encodeQrPayload } from '../handshake/qr-encode';
import { DmePoller } from '../poll/poller';
import type { IncomingMessage, IncomingWelcome } from '../poll/poller';
import { DmeStorage } from '../storage/db';
import type { PendingWelcome, KeyPackagePoolEntry, StoredMessage } from '../storage/db';
import { generateIdentityKeys } from '../crypto/identity';
import type { IdentityKeys } from '../crypto/identity';
import { MlsSession } from '../crypto/mls-session';
import { getMlsImpl, KEYPACKAGE_POOL_SIZE } from '../crypto/mls-config';
import {
  generateKeyPackageForUser,
  encryptKeyPackage,
  serializeEncryptedKeyPackage,
} from '../crypto/keypackage';
import type { KeyPackagePair } from '../crypto/keypackage';
import { deriveWelcomeQueueId } from '../crypto/mls-queue-id';
import { bytesToBase64url } from '../crypto/utils';
import { DME_SERVER_URL, PDS_URL } from '../config';
import type { DmeEnvelope } from '../protocol/types';

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
}

interface AppActions {
  login: (identifier: string, password: string, pdsUrl?: string) => Promise<void>;
  logout: () => Promise<void>;
  restoreSession: () => Promise<boolean>;
  setupIdentity: () => Promise<void>;
  declareKeys: (plcToken: string) => Promise<void>;
  sendMessage: (groupId: string, text: string) => Promise<void>;
  deleteFriend: (groupId: string) => Promise<void>;
  generateInviteQr: (bobDid: string) => Promise<{ qrString: string; keyPackageInitKey: Uint8Array }>;
  acceptInviteQr: (qrString: string) => Promise<void>;
  refreshKeyPackagePool: () => Promise<void>;
  setPollBatchSize: (size: number) => Promise<void>;
}

interface AppContextValue extends AppState, AppActions {}

const AppContext = createContext<AppContextValue | null>(null);

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function AppProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
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

  const processWelcomeRef = useRef<(welcome: IncomingWelcome) => Promise<void>>(async () => {});

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
        await AsyncStorage.multiRemove(placeholderKeys);
      }

      const newPds = new DmePds(newSession.agent, DME_SERVER_URL);

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
          await correctStorage.putMessage({
            id: msg.envelope.queueId,
            fromDid: msg.senderDid,
            toDid: userDid,
            plaintext: msg.plaintext,
            createdAt: msg.envelope.createdAt,
            sent: false,
          });
          setChatListVersion((v) => v + 1);
        },
        async (welcome: IncomingWelcome) => {
          await processWelcomeRef.current(welcome);
        },
      );

      // Restore MLS sessions
      const groupIds = await correctStorage.listGroups();
      const impl = await getMlsImpl();
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

      setSession(newSession);
      setStorage(correctStorage);
      setIdentityKeys(keys);
      setPds(newPds);
      setPoller(newPoller);
      setGroups(groupIds);
      setPendingWelcomes(welcomes);
      setKeyPackagePool(pool);
      setPollBatchSizeState(batchSize);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  const logout = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      poller?.stop();
      if (session) {
        await session.logout(storage ?? undefined);
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
      setPollBatchSizeState(3);
      setLoading(false);
    }
  }, [session, storage, poller]);

  const restoreSession = useCallback(async (): Promise<boolean> => {
    setLoading(true);
    setError(null);
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

        const newPds = new DmePds(tempSession.agent, DME_SERVER_URL);
        const storedKeys = await tempStorage.getIdentityKeys();
        const idKeys = storedKeys ?? generateIdentityKeys();
        if (!storedKeys) {
          await tempStorage.putIdentityKeys(idKeys);
        }

        const batchSize = await tempStorage.getPollBatchSize();
        const newPoller = new DmePoller(newPds, tempStorage, batchSize);

        newPoller.start(
          async (msg: IncomingMessage) => {
            await tempStorage.putMessage({
              id: msg.envelope.queueId,
              fromDid: msg.senderDid,
              toDid: did,
              plaintext: msg.plaintext,
              createdAt: msg.envelope.createdAt,
              sent: false,
            });
            setChatListVersion((v) => v + 1);
          },
          async (welcome: IncomingWelcome) => {
            await processWelcomeRef.current(welcome);
          },
        );

        // Restore MLS sessions
        const groupIds = await tempStorage.listGroups();
        const impl = await getMlsImpl();
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

        setSession(tempSession);
        setStorage(tempStorage);
        setIdentityKeys(idKeys);
        setPds(newPds);
        setPoller(newPoller);
        setGroups(groupIds);
        setPendingWelcomes(welcomes);
        setKeyPackagePool(pool);
        setPollBatchSizeState(batchSize);
        return true;
      }

      return false;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Session restore failed');
      return false;
    } finally {
      setLoading(false);
    }
  }, []);

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
  // Invite / Accept
  // -------------------------------------------------------------------------

  const generateInviteQr = useCallback(async (
    bobDid: string,
  ): Promise<{ qrString: string; keyPackageInitKey: Uint8Array }> => {
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

    // Track pending welcome
    const welcomeQueueId = deriveWelcomeQueueId(keyPackageInitKey);
    const entry: PendingWelcome = {
      queueId: welcomeQueueId,
      groupId: bobDid,
      keyPackageSerialized: serializeWithUint8Array(pair),
      createdAt: new Date().toISOString(),
    };
    await storage.putPendingWelcome(entry);
    poller.addPendingWelcome(entry);
    setPendingWelcomes((prev) => [...prev, entry]);

    // Mark pool entry as consumed
    await storage.markKeyPackageConsumed(available.id);
    setKeyPackagePool(await storage.getKeyPackagePool());

    return { qrString, keyPackageInitKey };
  }, [storage, identityKeys, session, poller, refreshKeyPackagePool]);

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

  const deleteFriend = useCallback(async (groupId: string): Promise<void> => {
    if (!storage || !poller) throw new Error('deleteFriend: not initialized');

    poller.removeSession(groupId);
    await storage.deleteMlsSession(groupId);
    await storage.deleteMessages(groupId);

    setGroups((prev) => prev.filter((g) => g !== groupId));
    setChatListVersion((v) => v + 1);
  }, [storage, poller]);

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
      login,
      logout,
      restoreSession,
      setupIdentity,
      declareKeys: declareKeysAction,
      sendMessage,
      deleteFriend,
      generateInviteQr,
      acceptInviteQr,
      refreshKeyPackagePool,
      setPollBatchSize,
    }),
    [
      session, storage, identityKeys, poller, pds, loading, error,
      groups, pendingWelcomes, keyPackagePool, chatListVersion, pollBatchSize,
      login, logout, restoreSession, setupIdentity, declareKeysAction,
      sendMessage, deleteFriend, generateInviteQr, acceptInviteQr,
      refreshKeyPackagePool, setPollBatchSize,
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
