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
} from 'react-native';
import { useRoute, useNavigation, useFocusEffect } from '@react-navigation/native';
import type { NativeStackNavigationProp, NativeStackScreenProps } from '@react-navigation/native-stack';

import { theme } from './theme';
import { Button } from './Button';
import { MessageBubble } from './MessageBubble';
import { EmojiPicker } from './EmojiPicker';
import { useApp } from '../state/AppContext';
import { sharedDidResolver } from '../atproto/did';
import type { StoredMessage } from '../storage/db';
import type { GroupInviteRequest } from '../protocol/group-message';
import type { RootStackParamList, DidDocWithHandle } from '../types/navigation';

type ChatViewRouteProp = NativeStackScreenProps<RootStackParamList, 'ChatView'>['route'];
type Navigation = NativeStackNavigationProp<RootStackParamList>;

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
    sendReaction,
    receivedGroupInvites,
    respondToGroupInvite,
    markConversationAsRead,
    chatListVersion,
  } = app;

  const [messages, setMessages] = useState<StoredMessage[]>([]);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [displayName, setDisplayName] = useState(isGroup ? 'Loading...' : conversationId);
  const [senderHandles, setSenderHandles] = useState<Record<string, string>>({});
  const [dissolved, setDissolved] = useState(false);
  const [removed, setRemoved] = useState(false);
  const [left, setLeft] = useState(false);
  const [pickerTarget, setPickerTarget] = useState<StoredMessage | null>(null);
  const [pickerLayout, setPickerLayout] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const listRef = useRef<FlatList<StoredMessage>>(null);
  const inputRef = useRef<TextInput>(null);
  const resolvedDidsRef = useRef<Set<string>>(new Set());

  const loadMessages = useCallback(async (): Promise<void> => {
    if (!storage) return;
    const msgs = await storage.getMessages(conversationId);
    setMessages(msgs);
  }, [storage, conversationId]);

  useFocusEffect(
    useCallback(() => {
      loadMessages();
      markConversationAsRead(conversationId).catch((err: unknown) => {
        console.error('markConversationAsRead failed:', err);
      });
    }, [loadMessages, markConversationAsRead, conversationId]),
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
    if (!isGroup || !storage) return;
    const unresolvedDids = [...new Set(messages.map((m) => m.fromDid))]
      .filter((did) => did !== session?.did && !resolvedDidsRef.current.has(did));
    if (unresolvedDids.length === 0) return;

    let cancelled = false;
    (async () => {
      const results = await Promise.all(
        unresolvedDids.map(async (did) => {
          resolvedDidsRef.current.add(did);
          try {
            const doc = (await sharedDidResolver.resolve(did)) as DidDocWithHandle | null;
            return {
              did,
              handle: doc?.alsoKnownAs?.[0]
                ? doc.alsoKnownAs[0].replace(/^at:\/\//, '')
                : did,
            };
          } catch {
            return { did, handle: did };
          }
        }),
      );
      if (!cancelled) {
        const resolved: Record<string, string> = {};
        for (const { did, handle } of results) {
          resolved[did] = handle;
        }
        setSenderHandles((prev) => ({ ...prev, ...resolved }));
      }
    })();
    return () => { cancelled = true; };
  }, [messages, isGroup, storage, session?.did]);

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
        }
      };
      loadGroupName().catch((err: unknown) => console.error('loadGroupName failed:', err));
    } else {
      let cancelled = false;
      (async () => {
        try {
          const doc = (await sharedDidResolver.resolve(conversationId)) as DidDocWithHandle | null;
          if (!cancelled && doc?.alsoKnownAs?.[0]) {
            setDisplayName(doc.alsoKnownAs[0].replace(/^at:\/\//, ''));
          }
        } catch (err) {
          console.error('Failed to resolve handle for', conversationId, err);
        }
      })();
      return () => { cancelled = true; };
    }
  }, [conversationId, isGroup, storage, chatListVersion]);

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
            <Text style={styles.inviteTitle}>{groupName}</Text>
            <Text style={styles.inviteSubtitle}>Group invitation</Text>
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

      return (
        <MessageBubble
          text={item.plaintext}
          isOutgoing={item.fromDid === session?.did}
          senderName={isGroup ? (senderHandles[item.fromDid] ?? item.fromDid) : undefined}
          reactions={item.reactions}
          currentDid={session?.did}
          onReactionPress={canReact ? (emoji) => { void handleReact(item, emoji); } : undefined}
          onOpenPicker={canReact ? (layout) => handleOpenPicker(item, layout) : undefined}
        />
      );
    },
    [session?.did, receivedGroupInvites, respondToGroupInvite, isGroup, senderHandles, canReact, handleReact, handleOpenPicker],
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
        <Text style={styles.headerTitle} numberOfLines={1}>
          {displayName}
        </Text>
        {isGroup && (
          <TouchableOpacity
            onPress={() => navigation.navigate('GroupSettings', { groupId: conversationId })}
            style={styles.settingsBtn}
            activeOpacity={0.7}
          >
            <Text style={styles.settingsIcon}>⋮</Text>
          </TouchableOpacity>
        )}
      </View>

      <FlatList
        ref={listRef}
        style={styles.list}
        contentContainerStyle={styles.listContent}
        data={messages}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
        onLayout={() => listRef.current?.scrollToEnd({ animated: false })}
      />

      {dissolved || removed || left ? (
        <View style={styles.inputBar}>
          <Text style={styles.dissolvedText}>
            {dissolved ? '群聊已解散，无法发送消息' : removed ? '你已被移出群聊，无法发送消息' : '你已离开群聊，无法发送消息'}
          </Text>
        </View>
      ) : (
        <View style={styles.inputBar}>
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
  },
  inviteTitle: {
    color: theme.colors.textPrimary,
    fontSize: theme.typography.body,
    fontWeight: '700',
  },
  inviteSubtitle: {
    color: theme.colors.textSecondary,
    fontSize: theme.typography.caption,
    marginTop: 2,
    marginBottom: theme.spacing.sm,
  },
  inviteResponded: {
    color: theme.colors.textSecondary,
    fontSize: theme.typography.caption,
    textAlign: 'center',
    paddingVertical: theme.spacing.sm,
  },
  inviteButtons: {
    flexDirection: 'row',
    gap: theme.spacing.sm,
  },
  inviteBtn: {
    flex: 1,
    height: 40,
  },
  dissolvedText: {
    color: theme.colors.textSecondary,
    fontSize: theme.typography.caption,
    textAlign: 'center',
    paddingVertical: theme.spacing.md,
  },
});
