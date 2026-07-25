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
import type { PendingInvite } from '../storage/db';

type RootStackParamList = {
  Login: undefined;
  Setup: undefined;
  ChatList: undefined;
  ChatView: { friendDid: string };
  QrDisplay: undefined;
  QrScan: undefined;
};

interface ConversationRow {
  friendDid: string;
  friendHandle: string;
  lastMessage: StoredMessage | null;
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
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();

  const [conversations, setConversations] = useState<ConversationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const handleCacheRef = useRef<Record<string, string>>({});

  const resolveHandle = useCallback(async (did: string): Promise<string> => {
    const cached = handleCacheRef.current[did];
    if (cached) return cached;
    try {
      const resolver = new DidResolver({});
      const doc = await resolver.resolve(did) as any;
      const aka = doc?.alsoKnownAs;
      if (Array.isArray(aka) && aka.length > 0) {
        const handle = aka[0].replace(/^at:\/\//, '');
        handleCacheRef.current[did] = handle;
        return handle;
      }
    } catch {}
    handleCacheRef.current[did] = did;
    return did;
  }, []);

  const loadConversations = useCallback(async (): Promise<void> => {
    if (!app.storage) {
      setConversations([]);
      setLoading(false);
      return;
    }

    const friends = await app.storage.listFriends();
    const rows: ConversationRow[] = [];
    for (const friendDid of friends) {
      const messages = await app.storage.getMessages(friendDid);
      const lastMessage = messages.length > 0 ? messages[messages.length - 1] : null;
      const friendHandle = await resolveHandle(friendDid);

      rows.push({ friendDid, friendHandle, lastMessage });
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
    (friendDid: string): void => {
      navigation.navigate('ChatView', { friendDid });
    },
    [navigation],
  );

  const navigateToQrDisplay = useCallback((): void => {
    navigation.navigate('QrDisplay');
  }, [navigation]);

  const navigateToQrScan = useCallback((): void => {
    navigation.navigate('QrScan');
  }, [navigation]);

  const onCheckInvite = useCallback((bobDid: string) => {
    app.checkPendingInvite(bobDid).catch(console.error);
  }, [app]);

  const onDeleteInvite = useCallback((bobDid: string) => {
    app.deletePendingInvite(bobDid).catch(console.error);
  }, [app]);

  const renderInviteRow = useCallback(
    (invite: PendingInvite): React.JSX.Element => (
      <View style={styles.inviteRow}>
        <View style={styles.inviteInfo}>
          <Text style={styles.inviteHandle} numberOfLines={1}>{invite.bobHandle}</Text>
          <Text style={styles.inviteStatus}>
            {invite.status === 'pending' ? 'Waiting for scan...' :
             invite.status === 'accepted' ? 'Accepted' : 'Failed'}
          </Text>
        </View>
        {invite.status === 'pending' && (
          <TouchableOpacity onPress={() => onCheckInvite(invite.bobDid)} style={styles.inviteBtn}>
            <Text style={styles.inviteBtnText}>Check</Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity onPress={() => onDeleteInvite(invite.bobDid)} style={styles.inviteBtn}>
          <Text style={[styles.inviteBtnText, { color: theme.colors.error }]}>Delete</Text>
        </TouchableOpacity>
      </View>
    ),
    [onCheckInvite, onDeleteInvite],
  );

  const [openDid, setOpenDid] = useState<string | null>(null);

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
          isOpen={openDid === item.friendDid}
          onOpen={() => setOpenDid(item.friendDid)}
          onClose={() => setOpenDid((prev) => (prev === item.friendDid ? null : prev))}
          onDelete={() => app.deleteFriend(item.friendDid)}
          onTap={() => navigateToChat(item.friendDid)}
          renderRightActions={renderRightActions}
        >
          <View style={styles.row}>
            <View style={styles.rowHeader}>
              <Text style={styles.rowTitle} numberOfLines={1}>
                {item.friendHandle}
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
    [navigateToChat, openDid, app.deleteFriend, renderRightActions],
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
            label="Logout"
            onPress={() => app.logout().catch(console.error)}
            variant="secondary"
            style={styles.iconBtn}
          />
        </View>
      </View>

      <FlatList
        style={styles.list}
        contentContainerStyle={styles.listContent}
        data={conversations}
        keyExtractor={(item) => item.friendDid}
        renderItem={renderItem}
        ListHeaderComponent={
          app.pendingInvites.length > 0 ? (
            <View style={styles.inviteSection}>
              <Text style={styles.sectionTitle}>Pending Invites ({app.pendingInvites.length})</Text>
              {app.pendingInvites.map((invite) => (
                <View key={invite.bobDid}>{renderInviteRow(invite)}</View>
              ))}
            </View>
          ) : null
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
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
  },
  inviteBtnText: {
    color: theme.colors.accent,
    fontSize: theme.typography.caption,
  },
});
