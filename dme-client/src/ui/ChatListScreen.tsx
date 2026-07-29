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
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Image } from 'expo-image';
import { Canvas, Fill } from '@shopify/react-native-skia';
import { useNavigation, useFocusEffect, useRoute } from '@react-navigation/native';
import type { NativeStackNavigationProp, NativeStackScreenProps } from '@react-navigation/native-stack';
import { Swipeable } from 'react-native-gesture-handler';

import { theme } from './theme';
import { Button } from './Button';
import { useApp } from '../state/AppContext';
import { sharedDidResolver } from '../atproto/did';
import type { StoredMessage } from '../storage/db';
import type { PendingWelcome } from '../storage/db';
import type { PendingInvite, GroupInfo } from '../protocol/group-message';
import type { RootStackParamList, DidDocWithHandle } from '../types/navigation';

type Navigation = NativeStackNavigationProp<RootStackParamList>;
type ChatListRouteProp = NativeStackScreenProps<RootStackParamList, 'ChatList'>['route'];

interface ConversationRow {
  groupId: string;
  displayName: string;
  lastMessage: StoredMessage | null;
  isGroup: boolean;
  unreadCount: number;
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

export function ChatListScreen(): React.JSX.Element {
  const app = useApp();
  const navigation = useNavigation<Navigation>();
  const route = useRoute<ChatListRouteProp>();
  const forwardText = route.params?.forwardText;

  const [conversations, setConversations] = useState<ConversationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [inviterHandles, setInviterHandles] = useState<Record<string, string>>({});
  const [menuVisible, setMenuVisible] = useState(false);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [avatarError, setAvatarError] = useState(false);
  const handleCacheRef = useRef<Record<string, string>>({});

  const resolveHandle = useCallback(async (did: string): Promise<string> => {
    const cached = handleCacheRef.current[did];
    if (cached) return cached;
    try {
      const doc = (await sharedDidResolver.resolve(did)) as DidDocWithHandle | null;
      const aka = doc?.alsoKnownAs;
      if (Array.isArray(aka) && aka.length > 0) {
        const handle = aka[0].replace(/^at:\/\//, '');
        handleCacheRef.current[did] = handle;
        return handle;
      }
    } catch (err) {
      console.error('resolveHandle failed for', did, err);
    }
    handleCacheRef.current[did] = did;
    return did;
  }, []);

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
    const session = app.session;
    if (!session) return;
    let cancelled = false;
    (async () => {
      try {
        const profile = await session.agent.app.bsky.actor.getProfile({ actor: session.did });
        if (!cancelled && profile.data.avatar) {
          setAvatarUrl(profile.data.avatar);
        }
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
    const groups = await storage.listGroups();
    const groupInfos = await storage.listGroupInfos();
    const groupInfoMap = new Map(groupInfos.map((g) => [g.groupId, g]));

    const rows = await Promise.all(
      groups.map(async (groupId) => {
        const messages = await storage.getMessages(groupId);
        const lastMessage = messages.length > 0 ? messages[messages.length - 1] : null;
        const unreadCount = messages.filter(
          (m) => m.fromDid !== myDid && !m.readAt,
        ).length;

        const info = groupInfoMap.get(groupId);
        const displayName = info ? info.groupName : await resolveHandle(groupId);
        return { groupId, displayName, lastMessage, isGroup: !!info, unreadCount };
      }),
    );
    setConversations(rows);
    setLoading(false);
  }, [app.storage, resolveHandle, app.chatListVersion, app.session?.did]);

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

  const onDeleteWelcome = useCallback((queueId: string) => {
    if (!app.storage) return;
    app.storage.deletePendingWelcome(queueId).catch((err: unknown) => console.error('deletePendingWelcome failed:', err));
  }, [app]);

  const renderWelcomeRow = useCallback(
    (welcome: PendingWelcome): React.JSX.Element => (
      <View style={styles.inviteRow}>
        <View style={styles.inviteInfo}>
          <Text style={styles.inviteHandle} numberOfLines={1}>{welcome.groupId}</Text>
          <Text style={styles.inviteStatus}>
            Waiting for welcome…
          </Text>
        </View>
        <TouchableOpacity onPress={() => onDeleteWelcome(welcome.queueId)} style={styles.inviteBtn}>
          <Text style={[styles.inviteBtnText, { color: theme.colors.error }]}>Delete</Text>
        </TouchableOpacity>
      </View>
    ),
    [onDeleteWelcome],
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
            <Text style={styles.deleteBtnText}>删除</Text>
          </TouchableOpacity>
        </RNAnimated.View>
      );
    },
    [],
  );

  const renderItem = useCallback(
    ({ item }: { item: ConversationRow }): React.JSX.Element => {
      const preview = item.lastMessage
        ? item.lastMessage.plaintext.slice(0, 40) +
          (item.lastMessage.plaintext.length > 40 ? '…' : '')
        : 'No messages yet';
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
            <View style={styles.rowHeader}>
              <Text style={styles.rowTitle} numberOfLines={1}>
                {item.isGroup ? '[Group] ' : ''}{item.displayName}
              </Text>
              {item.unreadCount > 0 && (
                <View style={styles.unreadBadge}>
                  <Text style={styles.unreadBadgeText}>
                    {item.unreadCount > 99 ? '99+' : item.unreadCount}
                  </Text>
                </View>
              )}
            </View>
            <Text
              style={styles.rowSubtitle}
              numberOfLines={1}
            >
              {preview}
            </Text>
          </View>
        </SwipeableRow>
      );
    },
    [navigateToChat, openGroupId, app.deleteFriend, renderRightActions],
  );

  return (
    <View style={styles.container}>
      <Canvas style={StyleSheet.absoluteFill}>
        <Fill color={theme.colors.background} />
      </Canvas>

      <View style={styles.topBar}>
        {forwardText ? (
          <>
            <Button
              label="取消"
              onPress={() => navigation.goBack()}
              variant="secondary"
              style={styles.iconBtn}
            />
            <Text style={styles.title}>选择转发目标</Text>
            <View style={styles.topButtons} />
          </>
        ) : (
          <>
            <Text style={styles.title}>隐世</Text>
            <View style={styles.topButtons}>
              <Button
                label="+ Group"
                onPress={navigateToCreateGroup}
                variant="secondary"
                style={styles.iconBtn}
              />
              <Button
                label="+ Friend"
                onPress={navigateToQrDisplay}
                variant="secondary"
                style={styles.iconBtn}
              />
              <TouchableOpacity
                onPress={() => setMenuVisible((v) => !v)}
                activeOpacity={0.8}
                style={styles.avatarBtn}
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
                <Text style={styles.sectionTitle}>Group Invitations</Text>
                {app.receivedGroupInvites
                  .filter((i) => i.status === 'pending')
                  .map((invite) => (
                    <View key={invite.inviteId} style={styles.inviteRow}>
                      <View style={styles.inviteInfo}>
                        <Text style={styles.inviteHandle} numberOfLines={1}>{invite.groupName}</Text>
                        <Text style={styles.inviteStatus}>From {inviterHandles[invite.inviterDid] ?? invite.inviterDid}</Text>
                      </View>
                      <Button
                        label="Accept"
                        onPress={() => app.respondToGroupInvite(invite.inviteId, true)}
                        variant="primary"
                        style={styles.inviteBtn}
                      />
                      <Button
                        label="Decline"
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
                  Pending Group Invites
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
                            {acceptedCount} accepted, {pendingCount} pending
                          </Text>
                        </View>
                        {acceptedCount > 0 && (
                          <Button
                            label={isExistingGroup ? 'Add' : 'Create'}
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
                          label="Cancel"
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
                <Text style={styles.sectionTitle}>Pending Welcomes ({app.pendingWelcomes.length})</Text>
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
              <Text style={styles.emptyText}>No conversations yet</Text>
              <Text style={styles.emptySubtext}>
                Tap +Friend to add a friend, or open the profile menu to Scan
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
              <Text style={styles.menuItemText}>Scan</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => {
                setMenuVisible(false);
                navigateToSettings();
              }}
              style={styles.menuItem}
              activeOpacity={0.7}
            >
              <Text style={styles.menuItemText}>Settings</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => {
                setMenuVisible(false);
                app.logout().catch((err: unknown) => console.error('Logout failed:', err));
              }}
              style={styles.menuItem}
              activeOpacity={0.7}
            >
              <Text style={[styles.menuItemText, { color: theme.colors.error }]}>Logout</Text>
            </TouchableOpacity>
          </View>
        </>
      )}
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
  menuPopup: {
    position: 'absolute',
    top: 60,
    right: theme.spacing.md,
    backgroundColor: theme.colors.surface,
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    paddingVertical: theme.spacing.xs,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
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
});
