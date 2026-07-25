/**
 * ui/ChatViewScreen.tsx - Scrollable chat view with native FlatList.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  FlatList,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useRoute, useNavigation, useFocusEffect } from '@react-navigation/native';
import type { NativeStackNavigationProp, NativeStackScreenProps } from '@react-navigation/native-stack';

import { theme } from './theme';
import { SkiaButton } from './SkiaButton';
import { MessageBubble } from './MessageBubble';
import { useApp } from '../state/AppContext';
import type { StoredMessage } from '../storage/db';

type RootStackParamList = {
  Login: undefined;
  Setup: undefined;
  ChatList: undefined;
  ChatView: { friendDid: string };
  QrDisplay: undefined;
  QrScan: undefined;
};

type ChatViewRouteProp = NativeStackScreenProps<RootStackParamList, 'ChatView'>['route'];

export function ChatViewScreen(): React.JSX.Element {
  const app = useApp();
  const route = useRoute<ChatViewRouteProp>();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { friendDid } = route.params;

  const [messages, setMessages] = useState<StoredMessage[]>([]);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [friendHandle, setFriendHandle] = useState(friendDid);
  const listRef = useRef<FlatList<StoredMessage>>(null);

  const loadMessages = useCallback(async (): Promise<void> => {
    if (!app.storage) return;
    const msgs = await app.storage.getMessages(friendDid);
    setMessages(msgs);
  }, [app.storage, friendDid]);

  useFocusEffect(
    useCallback(() => {
      loadMessages();
    }, [loadMessages]),
  );

  useEffect(() => {
    loadMessages();
  }, [app.chatListVersion, loadMessages]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { DidResolver } = await import('@atproto/identity');
        const resolver = new DidResolver({});
        const doc = await resolver.resolve(friendDid) as any;
        if (!cancelled && doc?.alsoKnownAs?.[0]) {
          setFriendHandle(doc.alsoKnownAs[0].replace(/^at:\/\//, ''));
        }
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [friendDid]);

  const onSend = useCallback(async (): Promise<void> => {
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    setSending(true);
    try {
      await app.sendMessage(friendDid, trimmed);
      setText('');
      await loadMessages();
    } catch (err) {
      console.error('Send failed:', err);
    } finally {
      setSending(false);
    }
  }, [text, sending, app, friendDid, loadMessages]);

  const renderItem = useCallback(
    ({ item }: { item: StoredMessage }): React.JSX.Element => (
      <MessageBubble
        text={item.plaintext}
        isOutgoing={item.fromDid === app.session?.did}
      />
    ),
    [app.session?.did],
  );

  const keyExtractor = useCallback(
    (item: StoredMessage, index: number): string => `${item.id}-${index}`,
    [],
  );

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <SkiaButton
          label="Back"
          onPress={() => navigation.goBack()}
          variant="secondary"
          style={styles.backBtn}
        />
        <Text style={styles.headerTitle} numberOfLines={1}>
          {friendHandle}
        </Text>
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

      <View style={styles.inputBar}>
        <TextInput
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
        <SkiaButton
          label={sending ? '…' : 'Send'}
          onPress={onSend}
          variant="primary"
          style={styles.sendBtn}
        />
      </View>
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
});
