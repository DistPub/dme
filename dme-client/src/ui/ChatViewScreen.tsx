/**
 * ui/ChatViewScreen.tsx - Scrollable chat view with native FlatList.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  FlatList,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type LayoutChangeEvent,
} from 'react-native';
import { useRoute, useNavigation, useFocusEffect } from '@react-navigation/native';
import type { NativeStackNavigationProp, NativeStackScreenProps } from '@react-navigation/native-stack';

import { theme } from './theme';
import { Button } from './Button';
import { MessageBubble } from './MessageBubble';
import { EmojiPicker } from './EmojiPicker';
import { MessageActionMenu } from './MessageActionMenu';
import { FileMessageBubble } from './FileMessageBubble';
import { useApp } from '../state/AppContext';
import { sharedDidResolver } from '../atproto/did';
import type { StoredMessage } from '../storage/db';
import type { GroupInviteRequest } from '../protocol/group-message';
import type { RootStackParamList, DidDocWithHandle } from '../types/navigation';
import * as Clipboard from 'expo-clipboard';
import * as DocumentPicker from 'expo-document-picker';
import { Image } from 'expo-image';

type ChatViewRouteProp = NativeStackScreenProps<RootStackParamList, 'ChatView'>['route'];
type Navigation = NativeStackNavigationProp<RootStackParamList>;
const savedScrollOffsets = new Map<string, number>();

export function ChatViewScreen(): React.JSX.Element {
  const app = useApp();
  const route = useRoute<ChatViewRouteProp>();
  const navigation = useNavigation<Navigation>();

  const conversationId = 'groupId' in route.params ? route.params.groupId : route.params.friendDid;
  const isGroup = 'groupId' in route.params;
  const {
    storage,
    session,
    sendMessage,
    sendFileMessage,
    sendReaction,
    deleteMessage,
    downloadFile,
    receivedGroupInvites,
    respondToGroupInvite,
    markConversationAsRead,
    chatListVersion,
    blockList,
    setActiveConversation,
  } = app;

  const [messages, setMessages] = useState<StoredMessage[]>([]);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [displayName, setDisplayName] = useState(isGroup ? 'Loading...' : conversationId);
  const [groupCreatorHandle, setGroupCreatorHandle] = useState('');
  const [friendAvatarUrl, setFriendAvatarUrl] = useState<string | null>(null);
  const [friendAvatarError, setFriendAvatarError] = useState(false);
  const [friendHandle, setFriendHandle] = useState('');
  const [senderProfiles, setSenderProfiles] = useState<Record<string, { displayName: string; handle: string; avatarUrl: string | null }>>({});
  const senderProfileCacheRef = useRef<Record<string, { displayName: string; handle: string; avatarUrl: string | null }>>({});
  const [ownProfile, setOwnProfile] = useState<{ displayName: string; handle: string; avatarUrl: string | null } | null>(null);
  const [dissolved, setDissolved] = useState(false);
  const [removed, setRemoved] = useState(false);
  const [left, setLeft] = useState(false);
  const [pickerTarget, setPickerTarget] = useState<StoredMessage | null>(null);
  const [pickerLayout, setPickerLayout] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const [actionMenuTarget, setActionMenuTarget] = useState<StoredMessage | null>(null);
  const [actionMenuLayout, setActionMenuLayout] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const listRef = useRef<FlatList<StoredMessage>>(null);
  const inputRef = useRef<TextInput>(null);
  const scrollMetricsRef = useRef({ offset: 0, contentHeight: 0, layoutHeight: 0, isAtBottom: true });
  const isRestoringScrollRef = useRef(false);

  const messageEqual = useCallback((a: StoredMessage, b: StoredMessage): boolean => {
    if (a.id !== b.id) return false;
    if (a.kind !== b.kind) return false;
    if (a.plaintext !== b.plaintext) return false;
    if (a.readAt !== b.readAt) return false;
    if (a.reactions?.length !== b.reactions?.length) return false;
    if (a.reactions && b.reactions) {
      for (let i = 0; i < a.reactions.length; i++) {
        if (
          a.reactions[i]!.did !== b.reactions[i]!.did ||
          a.reactions[i]!.emoji !== b.reactions[i]!.emoji
        ) {
          return false;
        }
      }
    }
    if (a.fileMeta?.downloadStatus !== b.fileMeta?.downloadStatus) return false;
    if (a.fileMeta?.localPath !== b.fileMeta?.localPath) return false;
    return true;
  }, []);

  const loadMessages = useCallback(async (): Promise<void> => {
    if (!storage) return;
    const msgs = await storage.getMessages(conversationId);
    const blockedSet = new Set(blockList);
    const next = msgs.filter((m) => !blockedSet.has(m.fromDid));
    setMessages((prev) => {
      if (prev.length !== next.length) return next;
      for (let i = 0; i < prev.length; i++) {
        if (!messageEqual(prev[i]!, next[i]!)) return next;
      }
      return prev;
    });
  }, [storage, conversationId, blockList, messageEqual]);

  useFocusEffect(
    useCallback(() => {
      setActiveConversation(conversationId);
      loadMessages();
      markConversationAsRead(conversationId).catch((err: unknown) => {
        console.error('markConversationAsRead failed:', err);
      });

      const savedOffset = savedScrollOffsets.get(conversationId);
      if (savedOffset !== undefined && savedOffset > 0) {
        isRestoringScrollRef.current = true;
        requestAnimationFrame(() => {
          listRef.current?.scrollToOffset({ offset: savedOffset, animated: false });
          setTimeout(() => {
            isRestoringScrollRef.current = false;
          }, 150);
        });
      }

      return () => {
        setActiveConversation(null);
      };
    }, [loadMessages, markConversationAsRead, conversationId, setActiveConversation]),
  );

  useEffect(() => {
    loadMessages();
    if (storage) {
      storage.markMessagesAsRead(conversationId).catch((err: unknown) => {
        console.error('markMessagesAsRead failed:', err);
      });
    }
  }, [chatListVersion, loadMessages]);

  useEffect(() => {
    if (!isGroup || !storage || !session) return;
    const unresolvedDids = [...new Set(messages.map((m) => m.fromDid))]
      .filter((did) => did !== session?.did && !senderProfileCacheRef.current[did]);
    if (unresolvedDids.length === 0) return;

    let cancelled = false;
    (async () => {
      const missing = unresolvedDids.filter((did) => !senderProfileCacheRef.current[did]);
      if (missing.length > 0) {
        try {
          const response = await session.agent.app.bsky.actor.getProfiles({ actors: missing });
          for (const profile of response.data.profiles) {
            senderProfileCacheRef.current[profile.did] = {
              displayName: profile.displayName ?? '',
              handle: profile.handle ?? profile.did,
              avatarUrl: profile.avatar ?? null,
            };
          }
        } catch (err) {
          console.error('Failed to batch resolve sender profiles', missing, err);
        }
      }

      const stillMissing = unresolvedDids.filter((did) => !senderProfileCacheRef.current[did]);
      if (stillMissing.length > 0) {
        await Promise.all(
          stillMissing.map(async (did) => {
            try {
              const doc = (await sharedDidResolver.resolve(did)) as DidDocWithHandle | null;
              const handle = doc?.alsoKnownAs?.[0]?.replace(/^at:\/\//, '') ?? did;
              senderProfileCacheRef.current[did] = { displayName: '', handle, avatarUrl: null };
            } catch {
              senderProfileCacheRef.current[did] = { displayName: '', handle: did, avatarUrl: null };
            }
          }),
        );
      }

      if (!cancelled) {
        const resolved: Record<string, { displayName: string; handle: string; avatarUrl: string | null }> = {};
        for (const did of unresolvedDids) {
          const p = senderProfileCacheRef.current[did];
          resolved[did] = { displayName: p.displayName, handle: p.handle, avatarUrl: p.avatarUrl };
        }
        setSenderProfiles((prev) => ({ ...prev, ...resolved }));
      }
    })();
    return () => { cancelled = true; };
  }, [messages, isGroup, storage, session]);

  useEffect(() => {
    if (!isGroup || !session?.did) return;
    let cancelled = false;
    (async () => {
      try {
        const profile = await session.agent.app.bsky.actor.getProfile({ actor: session.did });
        if (cancelled) return;
        setOwnProfile({
          displayName: profile.data.displayName ?? '',
          handle: profile.data.handle ?? '',
          avatarUrl: profile.data.avatar ?? null,
        });
      } catch (err) {
        console.error('Failed to fetch own profile for avatar:', err);
      }
    })();
    return () => { cancelled = true; };
  }, [session?.did, isGroup, chatListVersion]);

  useEffect(() => {
    if (isGroup) {
      const loadGroupName = async (): Promise<void> => {
        if (!storage) return;
        const info = await storage.getGroupInfo(conversationId);
        if (info) {
          setDisplayName(info.groupName);
          setDissolved(info.dissolved ?? false);
          setRemoved(info.removed ?? false);
          setLeft(info.left ?? false);
          try {
            const creatorDoc = (await sharedDidResolver.resolve(info.creatorDid)) as DidDocWithHandle | null;
            if (creatorDoc?.alsoKnownAs?.[0]) {
              setGroupCreatorHandle(creatorDoc.alsoKnownAs[0].replace(/^at:\/\//, ''));
            }
          } catch (err) {
            console.error('Failed to resolve creator handle for', info.creatorDid, err);
          }
        }
      };
      loadGroupName().catch((err: unknown) => console.error('loadGroupName failed:', err));
    } else {
      let cancelled = false;
      (async () => {
        try {
          const doc = (await sharedDidResolver.resolve(conversationId)) as DidDocWithHandle | null;
          if (cancelled) return;
          if (doc?.alsoKnownAs?.[0]) {
            const handle = doc.alsoKnownAs[0].replace(/^at:\/\//, '');
            setDisplayName(handle);
            setFriendHandle(handle);
          }
        } catch (err) {
          console.error('Failed to resolve handle for', conversationId, err);
        }
        if (!cancelled && session) {
          try {
            const profile = await session.agent.app.bsky.actor.getProfile({ actor: conversationId });
            if (cancelled) return;
            if (profile.data.displayName) {
              setDisplayName(profile.data.displayName);
            }
            if (profile.data.handle) {
              setFriendHandle(profile.data.handle);
            }
            if (profile.data.avatar) {
              setFriendAvatarUrl(profile.data.avatar);
            }
          } catch (err) {
            console.error('Failed to fetch friend profile for', conversationId, err);
          }
        }
      })();
      return () => { cancelled = true; };
    }
  }, [conversationId, isGroup, storage, chatListVersion, session]);

  const onSend = useCallback(async (): Promise<void> => {
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    setSending(true);
    try {
      await sendMessage(conversationId, trimmed);
      setText('');
      await loadMessages();
      inputRef.current?.focus();
    } catch (err) {
      console.error('Send failed:', err);
    } finally {
      setSending(false);
    }
  }, [text, sending, app, conversationId, loadMessages]);

  const handleReact = useCallback(async (msg: StoredMessage, emoji: string): Promise<void> => {
    setPickerTarget(null);
    setPickerLayout(null);
    try {
      await sendReaction(conversationId, msg.id, emoji);
    } catch (err) {
      console.error('sendReaction failed:', err);
    }
  }, [sendReaction, conversationId]);

  const handleOpenPicker = useCallback((msg: StoredMessage, layout: { x: number; y: number; width: number; height: number }): void => {
    setPickerTarget(msg);
    setPickerLayout(layout);
  }, []);

  const handleShowActionMenu = useCallback((msg: StoredMessage, layout: { x: number; y: number; width: number; height: number }): void => {
    setActionMenuTarget(msg);
    setActionMenuLayout(layout);
  }, []);

  const closeActionMenu = useCallback((): void => {
    setActionMenuTarget(null);
    setActionMenuLayout(null);
  }, []);

  const handleCopy = useCallback(async (msg: StoredMessage): Promise<void> => {
    await Clipboard.setStringAsync(msg.plaintext);
  }, []);

  const handleForward = useCallback((msg: StoredMessage): void => {
    navigation.navigate('ChatList', { forwardText: msg.plaintext });
  }, [navigation]);

  const handleDeleteMessage = useCallback(async (msg: StoredMessage): Promise<void> => {
    try {
      await deleteMessage(conversationId, msg.id);
      await loadMessages();
    } catch (err) {
      console.error('deleteMessage failed:', err);
    }
  }, [deleteMessage, conversationId, loadMessages]);

  const handleAttach = useCallback(async (): Promise<void> => {
    try {
      const result = await DocumentPicker.getDocumentAsync({ type: '*/*' });
      if (!result.canceled && result.assets && result.assets.length > 0) {
        const asset = result.assets[0]!;
        await sendFileMessage(conversationId, asset.uri, asset.name, asset.mimeType ?? 'application/octet-stream', asset.size ?? 0);
        await loadMessages();
      }
    } catch (err) {
      console.error('File pick failed:', err);
    }
  }, [conversationId, sendFileMessage, loadMessages]);

  const handleScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>): void => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    scrollMetricsRef.current = {
      offset: contentOffset.y,
      contentHeight: contentSize.height,
      layoutHeight: layoutMeasurement.height,
      isAtBottom: contentSize.height - contentOffset.y - layoutMeasurement.height < 50,
    };
    savedScrollOffsets.set(conversationId, contentOffset.y);
  }, [conversationId]);

  const handleLayout = useCallback((event: LayoutChangeEvent): void => {
    scrollMetricsRef.current.layoutHeight = event.nativeEvent.layout.height;
  }, []);

  const handleContentSizeChange = useCallback((_: number, height: number): void => {
    scrollMetricsRef.current.contentHeight = height;
    if (isRestoringScrollRef.current) return;
    const { isAtBottom, layoutHeight } = scrollMetricsRef.current;
    if (isAtBottom || height <= layoutHeight) {
      listRef.current?.scrollToEnd({ animated: true });
    }
  }, []);

  const canReact = !dissolved && !removed && !left;

  const renderItem = useCallback(
    ({ item }: { item: StoredMessage }): React.JSX.Element => {
      if (item.kind === 'group_system') {
        return (
          <View style={styles.systemMsgWrap}>
            <Text style={styles.systemMsgText}>{item.plaintext}</Text>
          </View>
        );
      }

      if (item.kind === 'group_invite') {
        let groupName = 'Group';
        let inviteId = '';
        try {
          const parsed = JSON.parse(item.plaintext) as GroupInviteRequest;
          groupName = parsed.groupName;
          inviteId = parsed.inviteId;
        } catch {
        }

        const alreadyResponded = receivedGroupInvites.some(
          (i) => i.inviteId === inviteId && i.status !== 'pending',
        );

        return (
          <View style={styles.inviteCard}>
            <Text style={styles.inviteTitle} numberOfLines={1}>群聊邀请：{groupName}</Text>
            {alreadyResponded ? (
              <Text style={styles.inviteResponded}>Responded</Text>
            ) : (
              <View style={styles.inviteButtons}>
                <Button
                  label="Accept"
                  onPress={() => respondToGroupInvite(inviteId, true)}
                  variant="primary"
                  style={styles.inviteBtn}
                />
                <Button
                  label="Decline"
                  onPress={() => respondToGroupInvite(inviteId, false)}
                  variant="secondary"
                  style={styles.inviteBtn}
                />
              </View>
            )}
          </View>
        );
      }

      if (item.kind === 'file' && item.fileMeta) {
        const fileMeta = item.fileMeta;
        const localPath = fileMeta.localPath;
        return (
          <FileMessageBubble
            fileMeta={fileMeta}
            isOutgoing={item.fromDid === session?.did}
            reactions={item.reactions}
            currentDid={session?.did}
            onRetry={fileMeta.downloadStatus === 'failed' ? () => {
              void downloadFile(conversationId, item.id).catch((err: unknown) => {
                console.error('Retry download failed:', err);
              });
            } : undefined}
            onImagePress={localPath ? () => {
              navigation.navigate('ImageViewer', {
                uri: localPath,
                fileName: fileMeta.fileName,
              });
            } : undefined}
            onReactionPress={canReact ? (emoji) => { void handleReact(item, emoji); } : undefined}
            onOpenPicker={canReact ? (layout) => handleOpenPicker(item, layout) : undefined}
          />
        );
      }

      return (
        <MessageBubble
          text={item.plaintext}
          isOutgoing={item.fromDid === session?.did}
          reactions={item.reactions}
          currentDid={session?.did}
          senderDisplayName={isGroup ? (item.fromDid === session?.did ? (ownProfile?.displayName || ownProfile?.handle || session?.did) : (senderProfiles[item.fromDid]?.displayName || senderProfiles[item.fromDid]?.handle || item.fromDid)) : undefined}
          senderHandle={isGroup && item.fromDid !== session?.did ? senderProfiles[item.fromDid]?.handle : undefined}
          senderAvatarUrl={isGroup ? (item.fromDid === session?.did ? (ownProfile?.avatarUrl ?? null) : (senderProfiles[item.fromDid]?.avatarUrl ?? null)) : undefined}
          onReactionPress={canReact ? (emoji) => { void handleReact(item, emoji); } : undefined}
          onOpenPicker={canReact ? (layout) => handleOpenPicker(item, layout) : undefined}
          onShowActionMenu={(layout) => handleShowActionMenu(item, layout)}
        />
      );
    },
    [session?.did, receivedGroupInvites, respondToGroupInvite, isGroup, senderProfiles, ownProfile, canReact, handleReact, handleOpenPicker, handleShowActionMenu, conversationId, downloadFile],
  );

  const keyExtractor = useCallback(
    (item: StoredMessage, index: number): string => `${item.id}-${index}`,
    [],
  );

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Button
          label="Back"
          onPress={() => navigation.goBack()}
          variant="secondary"
          style={styles.backBtn}
        />
        {isGroup ? (
          <View style={styles.friendInfo}>
            <View style={[styles.friendAvatar, styles.friendAvatarFallback]}>
              <Text style={styles.friendAvatarFallbackText}>
                {(displayName[0] ?? '?').toUpperCase()}
              </Text>
            </View>
            <View style={styles.friendInfoText}>
              <Text style={styles.friendDisplayName} numberOfLines={1}>
                [Group] {displayName}
              </Text>
              {groupCreatorHandle ? (
                <Text style={styles.friendHandle} numberOfLines={1}>
                  @{groupCreatorHandle}
                </Text>
              ) : null}
            </View>
            <TouchableOpacity
              onPress={() => navigation.navigate('GroupSettings', { groupId: conversationId })}
              style={styles.settingsBtn}
              activeOpacity={0.7}
            >
              <Text style={styles.settingsIcon}>⋮</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <View style={styles.friendInfo}>
            {friendAvatarUrl && !friendAvatarError ? (
              <Image
                source={{ uri: friendAvatarUrl }}
                style={styles.friendAvatar}
                contentFit="cover"
                transition={300}
                onError={() => setFriendAvatarError(true)}
              />
            ) : (
              <View style={[styles.friendAvatar, styles.friendAvatarFallback]}>
                <Text style={styles.friendAvatarFallbackText}>
                  {(displayName[0] ?? '?').toUpperCase()}
                </Text>
              </View>
            )}
            <View style={styles.friendInfoText}>
              <Text style={styles.friendDisplayName} numberOfLines={1}>
                {displayName}
              </Text>
              {friendHandle ? (
                <Text style={styles.friendHandle} numberOfLines={1}>
                  @{friendHandle}
                </Text>
              ) : null}
            </View>
            <TouchableOpacity
              onPress={() => navigation.navigate('DmSettings', { friendDid: conversationId })}
              style={styles.settingsBtn}
              activeOpacity={0.7}
            >
              <Text style={styles.settingsIcon}>⋮</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>

      <FlatList
        ref={listRef}
        style={styles.list}
        contentContainerStyle={styles.listContent}
        data={messages}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        onScroll={handleScroll}
        onLayout={handleLayout}
        onContentSizeChange={handleContentSizeChange}
      />

      {dissolved || removed || left ? (
        <View style={styles.inputBar}>
          <Text style={styles.dissolvedText}>
            {dissolved ? '群聊已解散，无法发送消息' : removed ? '你已被移出群聊，无法发送消息' : '你已离开群聊，无法发送消息'}
          </Text>
        </View>
      ) : (
        <View style={styles.inputBar}>
          <TouchableOpacity onPress={handleAttach} style={styles.attachBtn} activeOpacity={0.7}>
            <Text style={styles.attachBtnText}>📄</Text>
          </TouchableOpacity>
          <TextInput
            ref={inputRef}
            style={styles.input}
            value={text}
            onChangeText={setText}
            placeholder="Type a message..."
            placeholderTextColor={theme.colors.placeholder}
            autoCapitalize="none"
            autoCorrect={false}
            onSubmitEditing={onSend}
            returnKeyType="send"
          />
          <Button
            label={sending ? '…' : 'Send'}
            onPress={onSend}
            variant="primary"
            style={styles.sendBtn}
          />
        </View>
      )}
      <EmojiPicker
        visible={pickerTarget !== null}
        layout={pickerLayout}
        onSelect={(emoji) => { if (pickerTarget) void handleReact(pickerTarget, emoji); }}
        onClose={() => { setPickerTarget(null); setPickerLayout(null); }}
      />
      <MessageActionMenu
        visible={actionMenuTarget !== null}
        layout={actionMenuLayout}
        isOutgoing={actionMenuTarget ? actionMenuTarget.fromDid === session?.did : false}
        onCopy={() => { if (actionMenuTarget) void handleCopy(actionMenuTarget); }}
        onForward={() => { if (actionMenuTarget) void handleForward(actionMenuTarget); }}
        onDelete={() => { if (actionMenuTarget) void handleDeleteMessage(actionMenuTarget); }}
        onClose={closeActionMenu}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: theme.spacing.md,
    paddingTop: theme.spacing.sm,
    height: 56,
  },
  backBtn: {
    width: 60,
    height: 40,
  },
  settingsBtn: {
    width: 40,
    height: 40,
    justifyContent: 'center',
    alignItems: 'center',
  },
  settingsIcon: {
    color: theme.colors.textPrimary,
    fontSize: 24,
    fontWeight: '700',
  },
  headerTitle: {
    flex: 1,
    color: theme.colors.textPrimary,
    fontSize: theme.typography.body,
    fontWeight: '600',
    marginLeft: theme.spacing.sm,
  },
  friendInfo: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    marginLeft: theme.spacing.sm,
    gap: theme.spacing.sm,
  },
  friendAvatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    overflow: 'hidden',
  },
  friendAvatarFallback: {
    backgroundColor: theme.colors.accent,
    justifyContent: 'center',
    alignItems: 'center',
  },
  friendAvatarFallbackText: {
    color: '#FFFFFF',
    fontSize: theme.typography.body,
    fontWeight: '700',
  },
  friendInfoText: {
    flex: 1,
    justifyContent: 'center',
  },
  friendDisplayName: {
    color: theme.colors.textPrimary,
    fontSize: theme.typography.body,
    fontWeight: '600',
    includeFontPadding: false,
  },
  friendHandle: {
    color: theme.colors.textSecondary,
    fontSize: 12,
    marginTop: 1,
    includeFontPadding: false,
  },
  list: {
    flex: 1,
  },
  listContent: {
    paddingVertical: 8,
  },
  inputBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    gap: theme.spacing.sm,
  },
  input: {
    flex: 1,
    height: 48,
    backgroundColor: theme.colors.inputBackground,
    borderRadius: theme.borderRadius.sm,
    borderWidth: 1,
    borderColor: theme.colors.border,
    color: theme.colors.textPrimary,
    fontSize: theme.typography.body,
    paddingHorizontal: theme.spacing.md,
  },
  sendBtn: {
    width: 72,
    height: 48,
  },
  systemMsgWrap: {
    alignItems: 'center',
    paddingVertical: theme.spacing.md,
    marginHorizontal: theme.spacing.xl,
  },
  systemMsgText: {
    color: theme.colors.textSecondary,
    fontSize: theme.typography.caption,
    textAlign: 'center',
  },
  inviteCard: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.borderRadius.md,
    padding: theme.spacing.md,
    marginVertical: theme.spacing.sm,
    marginHorizontal: theme.spacing.md,
    alignSelf: 'center',
    width: '90%',
    maxWidth: 360,
  },
  inviteTitle: {
    color: theme.colors.textPrimary,
    fontSize: theme.typography.caption,
    fontWeight: '600',
  },
  inviteResponded: {
    color: theme.colors.textSecondary,
    fontSize: theme.typography.small,
    textAlign: 'center',
    paddingVertical: theme.spacing.xs,
  },
  inviteButtons: {
    flexDirection: 'row',
    gap: theme.spacing.sm,
    marginTop: theme.spacing.xs,
  },
  inviteBtn: {
    flex: 1,
    height: 36,
  },
  attachBtn: {
    width: 40,
    height: 40,
    justifyContent: 'center',
    alignItems: 'center',
  },
  attachBtnText: {
    fontSize: 20,
  },
  dissolvedText: {
    color: theme.colors.textSecondary,
    fontSize: theme.typography.caption,
    textAlign: 'center',
    paddingVertical: theme.spacing.md,
  },
});
