/**
 * state/AppContext.tsx - Global app state + actions for DME.
 *
 * Manages session, identity, encryption keys, handshake, and poller.
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

import { DmeSession } from '../atproto/session';
import { DmePds } from '../atproto/pds';
import { DmeDidManager } from '../atproto/did';
import { DmeHandshake } from '../handshake/handshake';
import { DmePoller } from '../poll/poller';
import { DmeStorage } from '../storage/db';
import type { PendingInvite } from '../storage/db';
import { generateIdentityKey } from '../crypto/identity';
import { encryptMessage, decryptMessage } from '../crypto/envelope';
import { DoubleRatchet } from '../crypto/ratchet';
import { DME_SERVER_URL, PDS_URL } from '../config';

import type { IdentityKey } from '../crypto/identity';
import type { HandshakePayload } from '../handshake/handshake';

interface AppState {
  session: DmeSession | null;
  storage: DmeStorage | null;
  identityKey: IdentityKey | null;
  poller: DmePoller | null;
  pds: DmePds | null;
  didManager: DmeDidManager | null;
  handshake: DmeHandshake | null;
  loading: boolean;
  error: string | null;
  pendingInvites: PendingInvite[];
  chatListVersion: number;
}

interface AppActions {
  login: (identifier: string, password: string, pdsUrl?: string) => Promise<void>;
  logout: () => Promise<void>;
  restoreSession: () => Promise<boolean>;
  ensureIdentityKey: () => Promise<void>;
  declareKey: (plcToken: string) => Promise<void>;
  sendMessage: (friendDid: string, plaintext: string) => Promise<void>;
  deleteFriend: (friendDid: string) => Promise<void>;
  startHandshake: (remoteDid: string) => Promise<HandshakePayload>;
  acceptHandshake: (payload: HandshakePayload) => Promise<{ ratchet: DoubleRatchet; sharedSecret: Uint8Array }>;
  addPendingInvite: (invite: PendingInvite) => Promise<void>;
  deletePendingInvite: (bobDid: string) => Promise<void>;
  checkPendingInvite: (bobDid: string) => Promise<void>;
  checkAllPendingInvites: () => Promise<void>;
}

interface AppContextValue extends AppState, AppActions {}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [session, setSession] = useState<DmeSession | null>(null);
  const [storage, setStorage] = useState<DmeStorage | null>(null);
  const [identityKey, setIdentityKey] = useState<IdentityKey | null>(null);
  const [poller, setPoller] = useState<DmePoller | null>(null);
  const [pds, setPds] = useState<DmePds | null>(null);
  const [didManager, setDidManager] = useState<DmeDidManager | null>(null);
  const [handshake, setHandshake] = useState<DmeHandshake | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingInvites, setPendingInvites] = useState<PendingInvite[]>([]);
  const [chatListVersion, setChatListVersion] = useState(0);
  const inviteCheckTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const checkAllPendingInvitesRef = useRef<() => Promise<void>>(async () => {});

  const refreshPendingInvites = useCallback(async (s: DmeStorage | null) => {
    if (!s) return;
    const invites = await s.getPendingInvites();
    setPendingInvites(invites);
  }, []);

  const stopInviteChecker = useCallback(() => {
    if (inviteCheckTimer.current) {
      clearInterval(inviteCheckTimer.current);
      inviteCheckTimer.current = null;
    }
  }, []);

  const startInviteChecker = useCallback(() => {
    stopInviteChecker();
    inviteCheckTimer.current = setInterval(() => {
      checkAllPendingInvitesRef.current();
    }, 30_000);
  }, [stopInviteChecker]);

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

      // CredentialSession 的 persistSession 回调在 login 成功时已经把数据写入了
      // placeholder storage，需要把所有 placeholder 数据迁移到以真实 DID 为前缀的 storage。
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
      const newDidManager = new DmeDidManager();
      const storedKey = await correctStorage.getIdentityKey();
      const key = storedKey ?? generateIdentityKey();
      if (!storedKey) {
        await correctStorage.putIdentityKey(key);
      }

      const newHandshake = new DmeHandshake(key, newDidManager, correctStorage);
      const newPoller = new DmePoller(newPds, correctStorage);

      newPoller.start(async (friendDid, plaintext, envelope) => {
        await correctStorage.putMessage({
          id: envelope.queueId,
          fromDid: friendDid,
          toDid: userDid,
          plaintext,
          createdAt: envelope.createdAt,
          sent: false,
        });
        setChatListVersion((v) => v + 1);
      });

      const restoreFriends = await correctStorage.listFriends();
      for (const friendDid of restoreFriends) {
        const ratchetJson = await correctStorage.getRatchet(friendDid);
        if (!ratchetJson) continue;
        try {
          const ratchet = DoubleRatchet.deserialize(ratchetJson);
          const activationQueueId = await correctStorage.getActivationQueueId(friendDid);
          newPoller.addConversation(friendDid, ratchet, activationQueueId ?? undefined);
        } catch (err) {
          console.error('Failed to restore ratchet for', friendDid, err);
        }
      }

      setSession(newSession);
      setStorage(correctStorage);
      setIdentityKey(key);
      setPds(newPds);
      setDidManager(newDidManager);
      setHandshake(newHandshake);
      setPoller(newPoller);

      await refreshPendingInvites(correctStorage);
      startInviteChecker();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
      throw err;
    } finally {
      setLoading(false);
    }
  }, [refreshPendingInvites, startInviteChecker]);

  const logout = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      stopInviteChecker();
      poller?.stop();
      if (session) {
        await session.logout(storage ?? undefined);
      }
    } catch (err) {
      console.error('Logout error:', err);
    } finally {
      setSession(null);
      setStorage(null);
      setIdentityKey(null);
      setPds(null);
      setDidManager(null);
      setHandshake(null);
      setPoller(null);
      setError(null);
      setPendingInvites([]);
      setLoading(false);
    }
  }, [session, storage, poller, stopInviteChecker]);

  const restoreSession = useCallback(async (): Promise<boolean> => {
    setLoading(true);
    setError(null);
    try {
      const keys = await AsyncStorage.getAllKeys();
      const sessionKeys = keys.filter(
        (k) => k.startsWith('dme:') && k.endsWith(':session'),
      );
      if (sessionKeys.length === 0) return false;

      // 优先恢复非 placeholder 的 session，避免恢复 did:plc:unknown 导致 userDid 和 session.did 不一致
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
        const newDidManager = new DmeDidManager();
        const storedKey = await tempStorage.getIdentityKey();
        const keyValue = storedKey ?? generateIdentityKey();
        if (!storedKey) {
          await tempStorage.putIdentityKey(keyValue);
        }

        const newHandshake = new DmeHandshake(keyValue, newDidManager, tempStorage);
        const newPoller = new DmePoller(newPds, tempStorage);

        newPoller.start(async (friendDid, plaintext, envelope) => {
          await tempStorage.putMessage({
            id: envelope.queueId,
            fromDid: friendDid,
            toDid: did,
            plaintext,
            createdAt: envelope.createdAt,
            sent: false,
          });
          setChatListVersion((v) => v + 1);
        });

        const restoreFriends = await tempStorage.listFriends();
        for (const friendDid of restoreFriends) {
          const ratchetJson = await tempStorage.getRatchet(friendDid);
          if (!ratchetJson) continue;
          try {
            const ratchet = DoubleRatchet.deserialize(ratchetJson);
            const activationQueueId = await tempStorage.getActivationQueueId(friendDid);
            newPoller.addConversation(friendDid, ratchet, activationQueueId ?? undefined);
          } catch (err) {
            console.error('Failed to restore ratchet for', friendDid, err);
          }
        }

        setSession(tempSession);
        setStorage(tempStorage);
        setIdentityKey(keyValue);
        setPds(newPds);
        setDidManager(newDidManager);
        setHandshake(newHandshake);
        setPoller(newPoller);

        await refreshPendingInvites(tempStorage);
        startInviteChecker();
        return true;
      }

      return false;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Session restore failed');
      return false;
    } finally {
      setLoading(false);
    }
  }, [refreshPendingInvites, startInviteChecker]);

  const ensureIdentityKey = useCallback(async (): Promise<void> => {
    if (identityKey) return;
    if (!storage) throw new Error('Storage not initialized');

    const storedKey = await storage.getIdentityKey();
    if (storedKey) {
      setIdentityKey(storedKey);
      return;
    }

    const key = generateIdentityKey();
    await storage.putIdentityKey(key);
    setIdentityKey(key);
  }, [identityKey, storage]);

  const declareKey = useCallback(
    async (plcToken: string): Promise<void> => {
      if (!identityKey) throw new Error('Identity key not available');
      if (!session) throw new Error('Session not initialized');
      if (!didManager) throw new Error('DID manager not initialized');

      await didManager.declareEncryptionKey(identityKey.publicKey, session.agent, plcToken);
    },
    [identityKey, session, didManager],
  );

  const sendMessage = useCallback(
    async (friendDid: string, plaintext: string): Promise<void> => {
      if (!session) throw new Error('Not authenticated');
      if (!storage) throw new Error('Storage not initialized');
      if (!pds) throw new Error('PDS not initialized');

      let ratchet = poller?.getRatchet(friendDid);
      if (!ratchet) {
        const ratchetJson = await storage.getRatchet(friendDid);
        if (!ratchetJson) {
          throw new Error(`No ratchet found for ${friendDid}. Complete handshake first.`);
        }
        ratchet = DoubleRatchet.deserialize(ratchetJson);
        poller?.addConversation(friendDid, ratchet);
      }

      const plaintextBytes = new TextEncoder().encode(plaintext);
      const envelope = encryptMessage(ratchet, plaintextBytes);

      await pds.createEnvelope(envelope);
      await storage.putRatchet(friendDid, ratchet.serialize());
      await storage.putMessage({
        id: envelope.queueId,
        fromDid: session.did,
        toDid: friendDid,
        plaintext,
        createdAt: envelope.createdAt,
        sent: true,
      });
    },
    [session, storage, pds, poller],
  );

  const deleteFriend = useCallback(
    async (friendDid: string): Promise<void> => {
      if (!storage) throw new Error('Storage not initialized');
      await storage.deleteRatchet(friendDid);
      await storage.deleteMessages(friendDid);
      await storage.deleteActivationQueueId(friendDid);
      poller?.removeConversation(friendDid);
      setChatListVersion((v) => v + 1);
    },
    [storage, poller],
  );

  const startHandshake = useCallback(
    async (remoteDid: string): Promise<HandshakePayload> => {
      await ensureIdentityKey();
      if (!handshake) throw new Error('Handshake not initialized');
      if (!session) throw new Error('Session not initialized');
      return handshake.initiate(remoteDid, session.did);
    },
    [ensureIdentityKey, handshake, session],
  );

  const acceptHandshake = useCallback(
    async (payload: HandshakePayload): Promise<{ ratchet: DoubleRatchet; sharedSecret: Uint8Array }> => {
      await ensureIdentityKey();
      if (!handshake) throw new Error('Handshake not initialized');
      if (!storage) throw new Error('Storage not initialized');
      if (!poller) throw new Error('Poller not initialized');

      const result = await handshake.accept(payload);
      await storage.putRatchet(payload.aliceDid, result.ratchet.serialize());
      await storage.putActivationQueueId(payload.aliceDid, result.initialQueueId);
      poller.addConversation(payload.aliceDid, result.ratchet, result.initialQueueId);
      poller.pollOnce().catch((err) => console.error('pollOnce after acceptHandshake failed:', err));
      return { ratchet: result.ratchet, sharedSecret: result.sharedSecret };
    },
    [ensureIdentityKey, handshake, storage, poller],
  );

  const addPendingInvite = useCallback(async (invite: PendingInvite): Promise<void> => {
    if (!storage) return;
    await storage.putPendingInvite(invite);
    await refreshPendingInvites(storage);
  }, [storage, refreshPendingInvites]);

  const deletePendingInvite = useCallback(async (bobDid: string): Promise<void> => {
    if (!storage) return;
    await storage.deletePendingInvite(bobDid);
    await refreshPendingInvites(storage);
  }, [storage, refreshPendingInvites]);

  const checkPendingInvite = useCallback(async (bobDid: string): Promise<void> => {
    if (!storage || !pds || !handshake) return;
    const invites = await storage.getPendingInvites();
    const invite = invites.find((i) => i.bobDid === bobDid);
    if (!invite || invite.status !== 'pending') return;

    try {
      const envelopes = await pds.batchGetEnvelopes([invite.queueId1]);
      if (envelopes.length === 0) return;

      const ratchet = await handshake.initReceiverRatchet(bobDid);

      let decrypted = false;
      for (const env of envelopes) {
        try {
          decryptMessage(ratchet, env);
          decrypted = true;
          break;
        } catch (err) {
          console.warn('checkPendingInvite: decrypt attempt failed for', bobDid, err);
        }
      }
      if (!decrypted) return;

      await handshake.deletePendingHandshake(bobDid);
      await storage.putRatchet(bobDid, ratchet.serialize());
      if (poller) {
        poller.addConversation(bobDid, ratchet);
      }

      await storage.deletePendingInvite(bobDid);
      await refreshPendingInvites(storage);
      setChatListVersion((v) => v + 1);
    } catch (err) {
      console.error('checkPendingInvite failed for', bobDid, err);
    }
  }, [storage, pds, handshake, poller, refreshPendingInvites]);

  const checkAllPendingInvites = useCallback(async (): Promise<void> => {
    if (!storage) return;
    const invites = await storage.getPendingInvites();
    const pending = invites.filter((i) => i.status === 'pending');
    await Promise.all(pending.map((i) => checkPendingInvite(i.bobDid)));
  }, [storage, checkPendingInvite]);

  checkAllPendingInvitesRef.current = checkAllPendingInvites;

  useEffect(() => {
    return () => stopInviteChecker();
  }, [stopInviteChecker]);

  const value = useMemo<AppContextValue>(
    () => ({
      session,
      storage,
      identityKey,
      poller,
      pds,
      didManager,
      handshake,
      loading,
      error,
      pendingInvites,
      chatListVersion,
      login,
      logout,
      restoreSession,
      ensureIdentityKey,
      declareKey,
      sendMessage,
      deleteFriend,
      startHandshake,
      acceptHandshake,
      addPendingInvite,
      deletePendingInvite,
      checkPendingInvite,
      checkAllPendingInvites,
    }),
    [
      session,
      storage,
      identityKey,
      poller,
      pds,
      didManager,
      handshake,
      loading,
      error,
      pendingInvites,
      chatListVersion,
      login,
      logout,
      restoreSession,
      ensureIdentityKey,
      declareKey,
      sendMessage,
      deleteFriend,
      startHandshake,
      acceptHandshake,
      addPendingInvite,
      deletePendingInvite,
      checkPendingInvite,
      checkAllPendingInvites,
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
