/**
 * ui/ChatListScreen.tsx - Conversation list with group/friend actions.
 *
 * Displays all friend DIDs that have message history. Tap a row to open
 * ChatView. Top bar keeps Group and +Friend buttons, plus a user avatar that
 * opens a popup menu for Scan, Settings and Logout. Uses flexbox layout
 * throughout.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated as RNAnimated,
  FlatList,
  Modal,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Image } from 'expo-image';
import { useNavigation, useFocusEffect, useRoute } from '@react-navigation/native';
import type { NativeStackNavigationProp, NativeStackScreenProps } from '@react-navigation/native-stack';
import { Swipeable } from 'react-native-gesture-handler';

import { theme } from './theme';
import { Button } from './Button';
import { ScreenBackground } from './ScreenBackground';
import { useApp } from '../state/AppContext';
import { useI18n } from '../i18n/I18nContext';
import {
  getProfileCached,
  getProfilesCached,
  resolveHandleCached,
} from '../atproto/profile-cache';
import type { StoredMessage } from '../storage/db';
import type { PendingWelcome } from '../storage/db';
import type { PendingInvite, GroupInfo } from '../protocol/group-message';
import type { RootStackParamList } from '../types/navigation';

type Navigation = NativeStackNavigationProp<RootStackParamList>;
type ChatListRouteProp = NativeStackScreenProps<RootStackParamList, 'ChatList'>['route'];

interface ConversationRow {
  groupId: string;
  displayName: string;
  lastMessage: StoredMessage | null;
  isGroup: boolean;
  unreadCount: number;
  avatarUrl: string | null;
  handle: string;
}

interface SwipeableRowProps {
  isOpen: boolean;
  onOpen: () => void;
  onClose: () => void;
  onDelete: () => void;
  onTap: () => void;
  children: React.ReactNode;
  renderRightActions: (
    progress: RNAnimated.AnimatedInterpolation<number>,
    dragX: RNAnimated.AnimatedInterpolation<number>,
    onDelete: () => void,
  ) => React.JSX.Element;
}

const SwipeableRow = React.memo(function SwipeableRow({
  isOpen,
  onOpen,
  onClose,
  onDelete,
  onTap,
  children,
  renderRightActions,
}: SwipeableRowProps): React.JSX.Element {
  const swipeableRef = useRef<Swipeable | null>(null);

  useEffect(() => {
    if (!isOpen && swipeableRef.current) {
      swipeableRef.current.close();
    }
  }, [isOpen]);

  return (
    <Swipeable
      ref={swipeableRef}
      friction={2}
      rightThreshold={40}
      renderRightActions={(progress, dragX) => renderRightActions(progress, dragX, onDelete)}
      onSwipeableOpen={onOpen}
      onSwipeableClose={onClose}
      overshootRight={false}
    >
      <TouchableOpacity onPress={onTap} activeOpacity={0.7}>
        {children}
      </TouchableOpacity>
    </Swipeable>
  );
});

type Translate = (key: string, params?: Record<string, string | number>) => string;

function formatTimeAgo(isoString: string | undefined, t: Translate): string {
  if (!isoString) return '';
  const now = Date.now();
  const then = new Date(isoString).getTime();
  const diffMs = now - then;
  if (diffMs < 0) return '';
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return t('chatlist.timeJustNow');
  if (diffMin < 60) return t('chatlist.timeMinutes', { n: diffMin });
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return t('chatlist.timeHours', { n: diffHour });
  const diffDay = Math.floor(diffHour / 24);
  if (diffDay < 7) return t('chatlist.timeDays', { n: diffDay });
  const d = new Date(isoString);
  return t('chatlist.timeDate', { M: d.getMonth() + 1, D: d.getDate() });
}

export function ChatListScreen(): React.JSX.Element {
  const app = useApp();
  const { t } = useI18n();
  const navigation = useNavigation<Navigation>();
  const route = useRoute<ChatListRouteProp>();
  const forwardText = route.params?.forwardText;

  const [conversations, setConversations] = useState<ConversationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [inviterHandles, setInviterHandles] = useState<Record<string, string>>({});
  const [welcomeHandles, setWelcomeHandles] = useState<Record<string, string>>({});
  const [menuVisible, setMenuVisible] = useState(false);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [avatarError, setAvatarError] = useState(false);
  const [displayName, setDisplayName] = useState('');
  const [userHandle, setUserHandle] = useState('');
  const [logoutModalVisible, setLogoutModalVisible] = useState(false);
  const [backupPwd, setBackupPwd] = useState('');
  const [backupPwdConfirm, setBackupPwdConfirm] = useState('');
  const [logoutStatus, setLogoutStatus] = useState<'idle' | 'backing_up' | 'error'>('idle');
  const [logoutError, setLogoutError] = useState<string | null>(null);
interface ProfileEntry {
  handle: string;
  displayName: string;
  avatar: string | null;
}

const handleCacheRef = useRef<Record<string, string>>({});
const profileCacheRef = useRef<Record<string, ProfileEntry>>({});

const resolveHandle = useCallback(async (did: string): Promise<string> => {
  const cached = handleCacheRef.current[did];
  if (cached) return cached;
  try {
    const handle = await resolveHandleCached(did);
    handleCacheRef.current[did] = handle;
    return handle;
  } catch (err) {
    console.error('resolveHandle failed for', did, err);
  }
  handleCacheRef.current[did] = did;
  return did;
}, []);

const resolveProfiles = useCallback(async (
  dids: string[],
): Promise<Record<string, ProfileEntry>> => {
  const result: Record<string, ProfileEntry> = {};
  const missing = dids.filter((did) => !profileCacheRef.current[did]);

    if (missing.length > 0 && app.session) {
      try {
        const profiles = await getProfilesCached(app.session.agent, missing);
        for (const [did, profile] of Object.entries(profiles)) {
          const entry: ProfileEntry = {
            handle: profile.handle ?? did,
            displayName: profile.displayName ?? '',
            avatar: profile.avatar ?? null,
          };
          profileCacheRef.current[did] = entry;
        }
      } catch (err) {
        console.error('resolveProfiles: getProfilesCached failed', missing, err);
      }
    }

  const stillMissing = dids.filter((did) => !profileCacheRef.current[did]);
  if (stillMissing.length > 0) {
    const handles = await Promise.all(stillMissing.map((did) => resolveHandle(did)));
    stillMissing.forEach((did, index) => {
      profileCacheRef.current[did] = {
        handle: handles[index] ?? did,
        displayName: '',
        avatar: null,
      };
    });
  }

  for (const did of dids) {
    result[did] = profileCacheRef.current[did];
  }
  return result;
}, [app.session, resolveHandle]);

  useEffect(() => {
    const pendingInviters = app.receivedGroupInvites
      .filter((i) => i.status === 'pending' && !inviterHandles[i.inviterDid])
      .map((i) => i.inviterDid);
    const uniqueDids = [...new Set(pendingInviters)];
    if (uniqueDids.length === 0) return;

    let cancelled = false;
    (async () => {
      const results = await Promise.all(
        uniqueDids.map(async (did) => ({ did, handle: await resolveHandle(did) })),
      );
      if (!cancelled) {
        const resolved: Record<string, string> = {};
        for (const { did, handle } of results) {
          resolved[did] = handle;
        }
        setInviterHandles((prev) => ({ ...prev, ...resolved }));
      }
    })();
    return () => { cancelled = true; };
  }, [app.receivedGroupInvites, inviterHandles, resolveHandle]);

  useEffect(() => {
    const dids = app.pendingWelcomes
      .map((w) => w.groupId)
      .filter((did) => !welcomeHandles[did]);
    const uniqueDids = [...new Set(dids)];
    if (uniqueDids.length === 0) return;

    let cancelled = false;
    (async () => {
      const results = await Promise.all(
        uniqueDids.map(async (did) => ({ did, handle: await resolveHandle(did) })),
      );
      if (!cancelled) {
        const resolved: Record<string, string> = {};
        for (const { did, handle } of results) {
          resolved[did] = handle;
        }
        setWelcomeHandles((prev) => ({ ...prev, ...resolved }));
      }
    })();
    return () => { cancelled = true; };
  }, [app.pendingWelcomes, welcomeHandles, resolveHandle]);

  useEffect(() => {
    const session = app.session;
    if (!session) return;
    let cancelled = false;
    (async () => {
      try {
        const profile = await getProfileCached(session.agent, session.did);
        if (cancelled || !profile) return;
        if (profile.avatar) {
          setAvatarUrl(profile.avatar);
        }
        setDisplayName(profile.displayName ?? '');
        setUserHandle(profile.handle ?? '');
      } catch (err) {
        console.error('Failed to fetch profile avatar:', err);
      }
    })();
    return () => { cancelled = true; };
  }, [app.session]);

  const loadConversations = useCallback(async (): Promise<void> => {
    if (!app.storage) {
      setConversations([]);
      setLoading(false);
      return;
    }

    const storage = app.storage;
    const myDid = app.session?.did;
    const blockedSet = new Set(app.blockList);
    const groups = await storage.listGroups();
    const groupInfos = await storage.listGroupInfos();
    const groupInfoMap = new Map(groupInfos.map((g) => [g.groupId, g]));

    const creatorDids = groupInfos.map((g) => g.creatorDid);
    const messagesByGroup = await Promise.all(
      groups.map(async (groupId) => ({ groupId, messages: await storage.getMessages(groupId) })),
    );
    const messagesMap = Object.fromEntries(messagesByGroup.map((x) => [x.groupId, x.messages]));

    const friendDids = groups.filter((gid) => !groupInfoMap.has(gid));

    const rows: ConversationRow[] = groups.map((groupId) => {
      const messages = messagesMap[groupId] ?? [];
      const lastMessage = messages.length > 0 ? messages[messages.length - 1] : null;
      const unreadCount = messages.filter(
        (m) => m.fromDid !== myDid && !m.readAt && !blockedSet.has(m.fromDid),
      ).length;

      const info = groupInfoMap.get(groupId);
      if (info) {
        return {
          groupId,
          displayName: info.groupName,
          lastMessage,
          isGroup: true,
          unreadCount,
          avatarUrl: null,
          handle: handleCacheRef.current[info.creatorDid] ?? '',
        };
      }
      const cachedProfile = profileCacheRef.current[groupId];
      return {
        groupId,
        displayName:
          cachedProfile?.displayName || cachedProfile?.handle || (handleCacheRef.current[groupId] ?? groupId),
        lastMessage,
        isGroup: false,
        unreadCount,
        avatarUrl: cachedProfile?.avatar ?? null,
        handle: cachedProfile?.handle ?? (handleCacheRef.current[groupId] ?? groupId),
      };
    });
    const sortedRows = rows.slice().sort((a, b) => {
      const ta = a.lastMessage?.createdAt;
      const tb = b.lastMessage?.createdAt;
      if (!ta && !tb) return 0;
      if (!ta) return 1;
      if (!tb) return -1;
      return tb.localeCompare(ta);
    });
    setConversations(sortedRows);
    setLoading(false);

    const needsRefresh =
      friendDids.some((did) => !profileCacheRef.current[did]) ||
      creatorDids.some((did) => !handleCacheRef.current[did]);
    if (!needsRefresh) return;

    void (async () => {
      const refreshedProfiles = friendDids.length > 0 ? await resolveProfiles(friendDids) : {};
      const refreshedCreatorHandles = creatorDids.length > 0
        ? await Promise.all(creatorDids.map((did) => resolveHandle(did)))
        : [];
      const creatorHandleMap = new Map(
        creatorDids.map((did, i) => [did, refreshedCreatorHandles[i] ?? '']),
      );

      setConversations((prev) =>
        prev.map((row) => {
          if (row.isGroup) {
            const info = groupInfoMap.get(row.groupId);
            if (!info) return row;
            const handle = creatorHandleMap.get(info.creatorDid) ?? row.handle;
            return handle !== row.handle ? { ...row, handle } : row;
          }
          const profile = refreshedProfiles[row.groupId];
          if (!profile) return row;
          const newDisplayName = profile.displayName || profile.handle || row.displayName;
          const newAvatar = profile.avatar ?? row.avatarUrl;
          const newHandle = profile.handle ?? row.handle;
          if (
            newDisplayName === row.displayName &&
            newAvatar === row.avatarUrl &&
            newHandle === row.handle
          ) {
            return row;
          }
          return { ...row, displayName: newDisplayName, avatarUrl: newAvatar, handle: newHandle };
        }),
      );
    })();
  }, [app.storage, resolveHandle, resolveProfiles, app.chatListVersion, app.session?.did, app.blockList]);

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      loadConversations();
      const interval = setInterval(loadConversations, 30_000);
      return () => clearInterval(interval);
    }, [loadConversations]),
  );



  const navigateToChat = useCallback(
    async (groupId: string, isGroup: boolean): Promise<void> => {
      if (forwardText) {
        try {
          await app.sendMessage(groupId, forwardText);
        } catch (err) {
          console.error('Forward sendMessage failed:', err);
        }
        if (isGroup) {
          navigation.replace('ChatView', { groupId });
        } else {
          navigation.replace('ChatView', { friendDid: groupId });
        }
        return;
      }
      if (isGroup) {
        navigation.navigate('ChatView', { groupId });
      } else {
        navigation.navigate('ChatView', { friendDid: groupId });
      }
    },
    [navigation, forwardText, app],
  );

  const navigateToQrDisplay = useCallback((): void => {
    navigation.navigate('QrDisplay');
  }, [navigation]);

  const navigateToQrScan = useCallback((): void => {
    navigation.navigate('QrScan');
  }, [navigation]);

  const navigateToSettings = useCallback((): void => {
    navigation.navigate('Settings');
  }, [navigation]);

  const navigateToCreateGroup = useCallback((): void => {
    navigation.navigate('CreateGroup');
  }, [navigation]);

  const handleLogoutPress = useCallback((): void => {
    setMenuVisible(false);
    setBackupPwd('');
    setBackupPwdConfirm('');
    setLogoutError(null);
    setLogoutStatus('idle');
    setLogoutModalVisible(true);
  }, []);

  const handleLogoutConfirm = useCallback(async (): Promise<void> => {
    if (!backupPwd) {
      setLogoutError(t('chatlist.enterPassword'));
      setLogoutStatus('error');
      return;
    }
    if (backupPwd !== backupPwdConfirm) {
      setLogoutError(t('chatlist.passwordMismatch'));
      setLogoutStatus('error');
      return;
    }
    setLogoutStatus('backing_up');
    setLogoutError(null);
    try {
      await app.backupIdentity(backupPwd);
      setLogoutModalVisible(false);
      await app.logout();
    } catch (err) {
      setLogoutError(err instanceof Error ? err.message : t('chatlist.backupFailed'));
      setLogoutStatus('error');
    }
  }, [app, backupPwd, backupPwdConfirm, t]);

  const onDeleteWelcome = useCallback((queueId: string) => {
    app.deletePendingWelcome(queueId).catch((err: unknown) => console.error('deletePendingWelcome failed:', err));
  }, [app.deletePendingWelcome]);

  const renderWelcomeRow = useCallback(
    (welcome: PendingWelcome): React.JSX.Element => {
      const handle = welcomeHandles[welcome.groupId];
      const label = handle && handle !== welcome.groupId ? `@${handle}` : welcome.groupId;
      return (
        <View style={styles.inviteRow}>
          <View style={styles.inviteInfo}>
            <Text style={styles.inviteHandle} numberOfLines={1}>{label}</Text>
            <Text style={styles.inviteStatus}>
              {t('chatlist.waitingWelcome', { time: formatTimeAgo(welcome.createdAt, t) })}
            </Text>
          </View>
          <TouchableOpacity onPress={() => onDeleteWelcome(welcome.queueId)} style={styles.inviteBtn}>
            <Text style={[styles.inviteBtnText, { color: theme.colors.error }]}>{t('common.delete')}</Text>
          </TouchableOpacity>
        </View>
      );
    },
    [onDeleteWelcome, welcomeHandles, t],
  );

  const [openGroupId, setOpenGroupId] = useState<string | null>(null);

  const renderRightActions = useCallback(
    (
      progress: RNAnimated.AnimatedInterpolation<number>,
      dragX: RNAnimated.AnimatedInterpolation<number>,
      onDelete: () => void,
    ): React.JSX.Element => {
      const trans = dragX.interpolate({
        inputRange: [-80, 0],
        outputRange: [0, 80],
        extrapolate: 'clamp',
      });
      return (
        <RNAnimated.View style={[styles.deleteBtnContainer, { transform: [{ translateX: trans }] }]}>
          <TouchableOpacity style={styles.deleteBtn} onPress={onDelete} activeOpacity={0.8}>
            <Text style={styles.deleteBtnText}>{t('common.delete')}</Text>
          </TouchableOpacity>
        </RNAnimated.View>
      );
    },
    [t],
  );

  const renderItem = useCallback(
    ({ item }: { item: ConversationRow }): React.JSX.Element => {
      const lastFromBlocked = item.lastMessage
        ? app.blockList.includes(item.lastMessage.fromDid)
        : false;

      const inviteGroupName =
        item.lastMessage?.kind === 'group_invite'
          ? (() => {
              try {
                const parsed = JSON.parse(item.lastMessage.plaintext) as {
                  type?: string;
                  groupName?: string;
                };
                if (parsed.type === 'group_invite_request' && parsed.groupName) {
                  return parsed.groupName;
                }
              } catch {
              }
              return null;
            })()
          : null;

      const preview = lastFromBlocked
        ? t('chatlist.blocked')
        : item.lastMessage
          ? inviteGroupName
            ? t('chatlist.invitePreview', { handle: item.handle, group: inviteGroupName })
            : item.lastMessage.kind === 'file' && item.lastMessage.fileMeta
              ? t('chatlist.filePreview', { name: item.lastMessage.fileMeta.fileName })
              : item.lastMessage.plaintext.slice(0, 40) +
                (item.lastMessage.plaintext.length > 40 ? '…' : '')
          : t('chatlist.noMessages');
      return (
        <SwipeableRow
          isOpen={openGroupId === item.groupId}
          onOpen={() => setOpenGroupId(item.groupId)}
          onClose={() => setOpenGroupId((prev) => (prev === item.groupId ? null : prev))}
          onDelete={() => app.deleteFriend(item.groupId)}
          onTap={() => navigateToChat(item.groupId, item.isGroup)}
          renderRightActions={renderRightActions}
        >
          <View style={styles.row}>
            <View style={styles.dmRow}>
              <View style={styles.dmAvatarWrap}>
                {item.avatarUrl ? (
                  <Image
                    source={{ uri: item.avatarUrl }}
                    style={styles.dmAvatar}
                    contentFit="cover"
                    transition={300}
                  />
                ) : (
                  <View style={[styles.dmAvatar, styles.dmAvatarFallback]}>
                    <Text style={styles.dmAvatarFallbackText}>
                      {(item.displayName[0] ?? '?').toUpperCase()}
                    </Text>
                  </View>
                )}
                {item.unreadCount > 0 && (
                  <View style={styles.dmBadge}>
                    <Text style={styles.unreadBadgeText}>
                      {item.unreadCount > 99 ? '99+' : item.unreadCount}
                    </Text>
                  </View>
                )}
              </View>
              <View style={styles.dmTextStack}>
                <View style={styles.dmHeader}>
                  <Text style={styles.dmName} numberOfLines={1}>
                    {item.isGroup ? t('common.groupPrefix') : ''}{item.displayName}
                  </Text>
                  {item.lastMessage ? (
                    <Text style={styles.dmTime} numberOfLines={1}>
                      {formatTimeAgo(item.lastMessage.createdAt, t)}
                    </Text>
                  ) : null}
                </View>
                {item.handle ? (
                  <Text style={styles.dmHandle} numberOfLines={1}>
                    @{item.handle}
                  </Text>
                ) : null}
                <Text style={styles.rowSubtitle} numberOfLines={1}>
                  {preview}
                </Text>
              </View>
            </View>
          </View>
        </SwipeableRow>
      );
    },
    [navigateToChat, openGroupId, app.deleteFriend, renderRightActions, app.blockList, t],
  );

  return (
    <View style={styles.container}>
      <ScreenBackground />

      <View style={styles.topBar}>
        {forwardText ? (
          <>
            <Button
              label={t('common.cancel')}
              onPress={() => navigation.goBack()}
              variant="secondary"
              style={styles.iconBtn}
            />
            <Text style={styles.title}>{t('chatlist.selectForwardTarget')}</Text>
            <View style={styles.topButtons} />
          </>
        ) : (
          <>
            <Text style={styles.title}>{t('chatlist.title')}</Text>
            <View style={styles.topButtons}>
              <Button
                label={t('chatlist.addGroup')}
                onPress={navigateToCreateGroup}
                variant="secondary"
                style={styles.iconBtn}
              />
              <Button
                label={t('chatlist.addFriend')}
                onPress={navigateToQrDisplay}
                variant="secondary"
                style={styles.iconBtn}
              />
              <TouchableOpacity
                onPress={() => setMenuVisible((v) => !v)}
                activeOpacity={0.8}
                style={styles.userInfoBtn}
              >
                {avatarUrl && !avatarError ? (
                  <Image
                    source={{ uri: avatarUrl }}
                    style={styles.avatarImage}
                    contentFit="cover"
                    transition={300}
                    onError={() => setAvatarError(true)}
                  />
                ) : (
                  <View style={[styles.avatarImage, styles.avatarFallback]}>
                    <Text style={styles.avatarFallbackText}>
                      {(app.session?.handle[0] ?? '?').toUpperCase()}
                    </Text>
                  </View>
                )}
                <View style={styles.userInfoText}>
                  <Text style={styles.userDisplayName} numberOfLines={1}>
                    {displayName || userHandle || app.session?.handle || ''}
                  </Text>
                  {userHandle ? (
                    <Text style={styles.userHandle} numberOfLines={1}>
                      @{userHandle}
                    </Text>
                  ) : null}
                </View>
              </TouchableOpacity>
            </View>
          </>
        )}
      </View>

      <FlatList
        style={styles.list}
        contentContainerStyle={styles.listContent}
        data={conversations}
        keyExtractor={(item) => item.groupId}
        renderItem={renderItem}
        ListHeaderComponent={
          <>
            {app.receivedGroupInvites.filter((i) => i.status === 'pending').length > 0 && (
              <View style={styles.inviteSection}>
                <Text style={styles.sectionTitle}>{t('chatlist.groupInvitations')}</Text>
                {app.receivedGroupInvites
                  .filter((i) => i.status === 'pending')
                  .map((invite) => (
                    <View key={invite.inviteId} style={styles.inviteRow}>
                      <View style={styles.inviteInfo}>
                        <Text style={styles.inviteHandle} numberOfLines={1}>{invite.groupName}</Text>
                        <Text style={styles.inviteStatus}>
                          {t('chatlist.fromHandle', { handle: inviterHandles[invite.inviterDid] ?? invite.inviterDid })}
                        </Text>
                      </View>
                      <Button
                        label={t('common.accept')}
                        onPress={() => app.respondToGroupInvite(invite.inviteId, true)}
                        variant="primary"
                        style={styles.inviteBtn}
                      />
                      <Button
                        label={t('common.decline')}
                        onPress={() => app.respondToGroupInvite(invite.inviteId, false)}
                        variant="secondary"
                        style={styles.inviteBtn}
                      />
                    </View>
                  ))}
              </View>
            )}

            {app.pendingInvites.filter((i) => i.status === 'pending' || i.status === 'accepted').length > 0 && (
              <View style={styles.inviteSection}>
                <Text style={styles.sectionTitle}>
                  {t('chatlist.pendingGroupInvites')}
                </Text>
                {(() => {
                  const active = app.pendingInvites.filter((i) => i.status === 'pending' || i.status === 'accepted');
                  const grouped = new Map<string, typeof active>();
                  for (const inv of active) {
                    const arr = grouped.get(inv.groupId) ?? [];
                    arr.push(inv);
                    grouped.set(inv.groupId, arr);
                  }
                  return [...grouped.entries()].map(([gid, invites]) => {
                    const acceptedCount = invites.filter((i) => i.status === 'accepted').length;
                    const pendingCount = invites.filter((i) => i.status === 'pending').length;
                    const isExistingGroup = app.groupInfos.some((g) => g.groupId === gid);
                    return (
                      <View key={gid} style={styles.inviteRow}>
                        <View style={styles.inviteInfo}>
                          <Text style={styles.inviteHandle} numberOfLines={1}>
                            {invites[0]?.groupName}
                          </Text>
                          <Text style={styles.inviteStatus}>
                            {t('chatlist.inviteStatus', { accepted: acceptedCount, pending: pendingCount })}
                          </Text>
                        </View>
                        {acceptedCount > 0 && (
                          <Button
                            label={isExistingGroup ? t('chatlist.add') : t('chatlist.create')}
                            onPress={() =>
                              isExistingGroup
                                ? app.addAcceptedMembersToGroup(gid)
                                : app.createGroupFromPendingInvites(gid)
                            }
                            variant="primary"
                            style={styles.inviteBtn}
                          />
                        )}
                        <Button
                          label={t('common.cancel')}
                          onPress={() => {
                            for (const inv of invites) {
                              app.cancelGroupInvite(inv.inviteId);
                            }
                          }}
                          variant="secondary"
                          style={styles.inviteBtn}
                        />
                      </View>
                    );
                  });
                })()}
              </View>
            )}

            {app.pendingWelcomes.length > 0 ? (
              <View style={styles.inviteSection}>
                <Text style={styles.sectionTitle}>{t('chatlist.pendingWelcomes', { count: app.pendingWelcomes.length })}</Text>
                {app.pendingWelcomes.map((welcome) => (
                  <View key={welcome.queueId}>{renderWelcomeRow(welcome)}</View>
                ))}
              </View>
            ) : null}
          </>
        }
        ListEmptyComponent={
          !loading ? (
            <View style={styles.empty}>
              <Text style={styles.emptyText}>{t('chatlist.noConversations')}</Text>
              <Text style={styles.emptySubtext}>
                {t('chatlist.noConversationsHint')}
              </Text>
            </View>
          ) : null
        }
      />

      {menuVisible && (
        <>
          <TouchableOpacity
            style={StyleSheet.absoluteFill}
            activeOpacity={1}
            onPress={() => setMenuVisible(false)}
          />
          <View style={styles.menuPopup}>
            <TouchableOpacity
              onPress={() => {
                setMenuVisible(false);
                navigateToQrScan();
              }}
              style={styles.menuItem}
              activeOpacity={0.7}
            >
              <Text style={styles.menuItemText}>{t('chatlist.scan')}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => {
                setMenuVisible(false);
                navigateToSettings();
              }}
              style={styles.menuItem}
              activeOpacity={0.7}
            >
              <Text style={styles.menuItemText}>{t('chatlist.settings')}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => {
                setMenuVisible(false);
                navigation.navigate('BlockList');
              }}
              style={styles.menuItem}
              activeOpacity={0.7}
            >
              <Text style={styles.menuItemText}>{t('chatlist.blockList')}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={handleLogoutPress}
              style={styles.menuItem}
              activeOpacity={0.7}
            >
              <Text style={[styles.menuItemText, { color: theme.colors.error }]}>{t('chatlist.logout')}</Text>
            </TouchableOpacity>
          </View>
        </>
      )}

      <Modal
        visible={logoutModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setLogoutModalVisible(false)}
      >
        <View style={styles.logoutOverlay}>
          <TouchableOpacity
            style={StyleSheet.absoluteFill}
            activeOpacity={1}
            onPress={() => setLogoutModalVisible(false)}
          />
          <View style={styles.logoutCard}>
            <Text style={styles.logoutTitle}>{t('chatlist.logoutTitle')}</Text>
            <Text style={styles.logoutMessage}>
              {t('chatlist.logoutMessage')}
            </Text>
            <TextInput
              style={styles.logoutInput}
              value={backupPwd}
              onChangeText={setBackupPwd}
              placeholder={t('chatlist.passwordPlaceholder')}
              placeholderTextColor={theme.colors.textSecondary}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              editable={logoutStatus !== 'backing_up'}
            />
            <TextInput
              style={styles.logoutInput}
              value={backupPwdConfirm}
              onChangeText={setBackupPwdConfirm}
              placeholder={t('chatlist.confirmPasswordPlaceholder')}
              placeholderTextColor={theme.colors.textSecondary}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              editable={logoutStatus !== 'backing_up'}
            />
            {logoutError ? (
              <Text style={styles.logoutError}>{logoutError}</Text>
            ) : null}
            <View style={styles.logoutButtons}>
              <Button
                label={t('common.cancel')}
                onPress={() => setLogoutModalVisible(false)}
                variant="secondary"
                style={styles.logoutBtn}
              />
              <Button
                label={logoutStatus === 'backing_up' ? t('chatlist.backingUp') : t('chatlist.backupAndLogout')}
                onPress={() => { void handleLogoutConfirm(); }}
                variant="primary"
                style={styles.logoutBtn}
                disabled={logoutStatus === 'backing_up'}
              />
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const DELETE_BTN_WIDTH = 80;

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: theme.spacing.md,
    paddingTop: theme.spacing.sm,
    height: 56,
  },
  title: {
    color: theme.colors.textPrimary,
    fontSize: theme.typography.heading,
    fontWeight: '700',
  },
  topButtons: {
    flexDirection: 'row',
    gap: theme.spacing.sm,
  },
  iconBtn: {
    minWidth: 44,
    paddingHorizontal: theme.spacing.sm,
    height: 40,
  },
  avatarBtn: {
    width: 40,
    height: 40,
    justifyContent: 'center',
    alignItems: 'center',
  },
  avatarImage: {
    width: 36,
    height: 36,
    borderRadius: 18,
    overflow: 'hidden',
  },
  avatarFallback: {
    backgroundColor: theme.colors.accent,
    justifyContent: 'center',
    alignItems: 'center',
  },
  avatarFallbackText: {
    color: '#FFFFFF',
    fontSize: theme.typography.body,
    fontWeight: '700',
  },
  userInfoBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 40,
    gap: theme.spacing.xs,
  },
  userInfoText: {
    justifyContent: 'center',
    flexShrink: 1,
    marginLeft: theme.spacing.xs,
  },
  userDisplayName: {
    color: theme.colors.textPrimary,
    fontSize: theme.typography.body,
    fontWeight: '600',
    includeFontPadding: false,
  },
  userHandle: {
    color: theme.colors.textSecondary,
    fontSize: 12,
    marginTop: 1,
    includeFontPadding: false,
  },
  menuPopup: {
    position: 'absolute',
    top: 60,
    right: theme.spacing.md,
    backgroundColor: theme.colors.surface,
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    paddingVertical: theme.spacing.xs,
    boxShadow: '0px 4px 8px rgba(0, 0, 0, 0.3)',
    elevation: 8,
  },
  menuItem: {
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
  },
  menuItemText: {
    color: theme.colors.textPrimary,
    fontSize: theme.typography.body,
  },
  list: {
    flex: 1,
  },
  listContent: {
    paddingHorizontal: theme.spacing.md,
    paddingBottom: theme.spacing.xl,
  },
  row: {
    paddingVertical: theme.spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  rowHeader: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  rowTitle: {
    color: theme.colors.textPrimary,
    fontSize: theme.typography.body,
    fontWeight: '600',
    flexShrink: 1,
  },
  rowSubtitle: {
    color: theme.colors.textSecondary,
    fontSize: theme.typography.caption,
    marginTop: theme.spacing.xs,
  },
  unreadBadge: {
    backgroundColor: theme.colors.accent,
    borderRadius: 10,
    minWidth: 20,
    height: 20,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 6,
    marginLeft: theme.spacing.sm,
  },
  unreadBadgeText: {
    color: '#FFFFFF',
    fontSize: theme.typography.small,
    fontWeight: '700',
  },
  dmRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  dmAvatarWrap: {
    position: 'relative',
  },
  dmBadge: {
    position: 'absolute',
    top: -4,
    right: -4,
    backgroundColor: theme.colors.error,
    borderRadius: 9,
    minWidth: 18,
    height: 18,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 4,
    borderWidth: 2,
    borderColor: theme.colors.background,
  },
  dmAvatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    overflow: 'hidden',
  },
  dmAvatarFallback: {
    backgroundColor: theme.colors.accent,
    justifyContent: 'center',
    alignItems: 'center',
  },
  dmAvatarFallbackText: {
    color: '#FFFFFF',
    fontSize: theme.typography.body,
    fontWeight: '700',
  },
  dmTextStack: {
    flex: 1,
    marginLeft: theme.spacing.sm,
  },
  dmHeader: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  dmName: {
    color: theme.colors.textPrimary,
    fontSize: theme.typography.body,
    fontWeight: '600',
    flexShrink: 1,
  },
  dmTime: {
    color: theme.colors.textSecondary,
    fontSize: theme.typography.small,
    marginLeft: theme.spacing.xs,
    flexShrink: 0,
  },
  dmHandle: {
    color: theme.colors.textSecondary,
    fontSize: theme.typography.small,
    marginTop: 1,
  },
  deleteBtnContainer: {
    width: DELETE_BTN_WIDTH,
    flexDirection: 'row',
  },
  deleteBtn: {
    flex: 1,
    backgroundColor: theme.colors.error,
    justifyContent: 'center',
    alignItems: 'center',
  },
  deleteBtnText: {
    color: '#FFFFFF',
    fontSize: theme.typography.body,
    fontWeight: '600',
  },
  empty: {
    alignItems: 'center',
    paddingTop: 120,
    paddingHorizontal: theme.spacing.lg,
  },
  emptyText: {
    color: theme.colors.textSecondary,
    fontSize: theme.typography.body,
  },
  emptySubtext: {
    color: theme.colors.placeholder,
    fontSize: theme.typography.caption,
    marginTop: theme.spacing.sm,
    textAlign: 'center',
  },
  inviteSection: {
    marginBottom: theme.spacing.md,
    backgroundColor: theme.colors.surface,
    borderRadius: theme.borderRadius.md,
    padding: theme.spacing.md,
  },
  sectionTitle: {
    color: theme.colors.textSecondary,
    fontSize: theme.typography.caption,
    marginBottom: theme.spacing.sm,
  },
  inviteRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: theme.spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  inviteInfo: {
    flex: 1,
  },
  inviteHandle: {
    color: theme.colors.textPrimary,
    fontSize: theme.typography.body,
    fontWeight: '600',
  },
  inviteStatus: {
    color: theme.colors.textSecondary,
    fontSize: theme.typography.small,
    marginTop: 2,
  },
  inviteBtn: {
    width: 70,
    height: 36,
    marginLeft: theme.spacing.xs,
  },
  inviteBtnText: {
    color: theme.colors.accent,
    fontSize: theme.typography.caption,
  },
  logoutOverlay: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
  },
  logoutCard: {
    width: 320,
    backgroundColor: theme.colors.surface,
    borderRadius: theme.borderRadius.md,
    padding: theme.spacing.md,
  },
  logoutTitle: {
    color: theme.colors.textPrimary,
    fontSize: theme.typography.heading,
    fontWeight: '700',
    marginBottom: theme.spacing.sm,
  },
  logoutMessage: {
    color: theme.colors.textSecondary,
    fontSize: theme.typography.body,
    marginBottom: theme.spacing.md,
    lineHeight: 22,
  },
  logoutInput: {
    backgroundColor: theme.colors.inputBackground,
    color: theme.colors.textPrimary,
    borderRadius: theme.borderRadius.sm,
    paddingHorizontal: theme.spacing.md,
    height: 44,
    marginBottom: theme.spacing.sm,
    fontSize: theme.typography.body,
  },
  logoutError: {
    color: theme.colors.error,
    fontSize: theme.typography.small,
    marginBottom: theme.spacing.sm,
  },
  logoutButtons: {
    flexDirection: 'row',
    gap: theme.spacing.sm,
  },
  logoutBtn: {
    flex: 1,
    height: 44,
  },
});
