/**
 * ui/ChatListScreen.tsx - Conversation list with QR/Scan actions.
 *
 * Displays all friend DIDs that have message history. Tap a row to open
 * ChatView. Top bar has QR (show my QR) and Scan (scan someone else's QR)
 * buttons. Uses flexbox layout throughout.
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
import { Canvas, Fill } from '@shopify/react-native-skia';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { DidResolver } from '@atproto/identity';
import { Swipeable } from 'react-native-gesture-handler';

import { theme } from './theme';
import { SkiaButton } from './SkiaButton';
import { useApp } from '../state/AppContext';
import type { StoredMessage } from '../storage/db';
import type { PendingWelcome } from '../storage/db';
import type { PendingInvite, GroupInfo } from '../protocol/group-message';
import type { RootStackParamList, DidDocWithHandle } from '../types/navigation';

type Navigation = NativeStackNavigationProp<RootStackParamList>;

interface ConversationRow {
  groupId: string;
  displayName: string;
  lastMessage: StoredMessage | null;
  isGroup: boolean;
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

  const [conversations, setConversations] = useState<ConversationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [inviterHandles, setInviterHandles] = useState<Record<string, string>>({});
  const handleCacheRef = useRef<Record<string, string>>({});

  const resolveHandle = useCallback(async (did: string): Promise<string> => {
    const cached = handleCacheRef.current[did];
    if (cached) return cached;
    try {
      const resolver = new DidResolver({});
      const doc = (await resolver.resolve(did)) as DidDocWithHandle | null;
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
      const resolved: Record<string, string> = {};
      for (const did of uniqueDids) {
        resolved[did] = await resolveHandle(did);
      }
      if (!cancelled) {
        setInviterHandles((prev) => ({ ...prev, ...resolved }));
      }
    })();
    return () => { cancelled = true; };
  }, [app.receivedGroupInvites, inviterHandles, resolveHandle]);

  const loadConversations = useCallback(async (): Promise<void> => {
    if (!app.storage) {
      setConversations([]);
      setLoading(false);
      return;
    }

    const groups = await app.storage.listGroups();
    const groupInfos = await app.storage.listGroupInfos();
    const groupInfoMap = new Map(groupInfos.map((g) => [g.groupId, g]));

    const rows: ConversationRow[] = [];
    for (const groupId of groups) {
      const messages = await app.storage.getMessages(groupId);
      const lastMessage = messages.length > 0 ? messages[messages.length - 1] : null;

      const info = groupInfoMap.get(groupId);
      let displayName: string;
      let isGroup = false;

      if (info) {
        displayName = info.groupName;
        isGroup = true;
      } else {
        displayName = await resolveHandle(groupId);
      }

      rows.push({ groupId, displayName, lastMessage, isGroup });
    }
    setConversations(rows);
    setLoading(false);
  }, [app.storage, resolveHandle, app.chatListVersion]);

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      loadConversations();
      const interval = setInterval(loadConversations, 30_000);
      return () => clearInterval(interval);
    }, [loadConversations]),
  );

  useEffect(() => {
    loadConversations();
  }, [loadConversations]);

  const navigateToChat = useCallback(
    (groupId: string, isGroup: boolean): void => {
      if (isGroup) {
        navigation.navigate('ChatView', { groupId });
      } else {
        navigation.navigate('ChatView', { friendDid: groupId });
      }
    },
    [navigation],
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
        <Text style={styles.title}>Chats</Text>
        <View style={styles.topButtons}>
          <SkiaButton
            label="+ Group"
            onPress={navigateToCreateGroup}
            variant="secondary"
            style={styles.iconBtn}
          />
          <SkiaButton
            label="QR"
            onPress={navigateToQrDisplay}
            variant="secondary"
            style={styles.iconBtn}
          />
          <SkiaButton
            label="Scan"
            onPress={navigateToQrScan}
            variant="secondary"
            style={styles.iconBtn}
          />
          <SkiaButton
            label="Settings"
            onPress={navigateToSettings}
            variant="secondary"
            style={styles.iconBtn}
          />
          <SkiaButton
            label="Logout"
            onPress={() => app.logout().catch((err) => console.error('Logout failed:', err))}
            variant="secondary"
            style={styles.iconBtn}
          />
        </View>
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
                      <SkiaButton
                        label="Accept"
                        onPress={() => app.respondToGroupInvite(invite.inviteId, true)}
                        variant="primary"
                        style={styles.inviteBtn}
                      />
                      <SkiaButton
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
                          <SkiaButton
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
                        <SkiaButton
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
                Tap QR to start a chat or Scan to accept one
              </Text>
            </View>
          ) : null
        }
      />
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
    width: 60,
    height: 40,
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
    justifyContent: 'space-between',
  },
  rowTitle: {
    color: theme.colors.textPrimary,
    fontSize: theme.typography.body,
    fontWeight: '600',
    flex: 1,
  },
  rowSubtitle: {
    color: theme.colors.textSecondary,
    fontSize: theme.typography.caption,
    marginTop: theme.spacing.xs,
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
