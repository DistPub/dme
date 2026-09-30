/**
 * ui/ChatViewScreen.tsx - Scrollable chat view with native FlatList.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  FlatList,
  KeyboardAvoidingView,
  Platform,
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
import { MessageActionMenu } from './MessageActionMenu';
import { FileMessageBubble } from './FileMessageBubble';
import { exportFileToDevice } from '../utils/file-export';
import { useWebTitle } from '../utils/web-title';
import { useApp } from '../state/AppContext';
import { useI18n } from '../i18n/I18nContext';
import {
  getProfileCached,
  getProfilesCached,
  resolveHandleCached,
} from '../atproto/profile-cache';
import type { StoredMessage } from '../storage/db';
import type { GroupInviteRequest } from '../protocol/group-message';
import type { RootStackParamList } from '../types/navigation';
import * as Clipboard from 'expo-clipboard';
import * as DocumentPicker from 'expo-document-picker';
import { Image } from 'expo-image';

type ChatViewRouteProp = NativeStackScreenProps<RootStackParamList, 'ChatView'>['route'];
type Navigation = NativeStackNavigationProp<RootStackParamList>;

interface SenderProfile {
  displayName: string;
  handle: string;
  avatarUrl: string | null;
}

export function ChatViewScreen(): React.JSX.Element {
  const app = useApp();
  const { t } = useI18n();
  const route = useRoute<ChatViewRouteProp>();
  const navigation = useNavigation<Navigation>();

  const conversationId = 'groupId' in route.params ? route.params.groupId : route.params.friendDid;
  const isGroup = 'groupId' in route.params;
  const {
    storage,
    session,
    sendMessage,
    sendFileMessage,
    retryUploadFileMessage,
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
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [inputHeight, setInputHeight] = useState(44);
  const [displayName, setDisplayName] = useState(isGroup ? t('common.loading') : conversationId);
  const [groupCreatorHandle, setGroupCreatorHandle] = useState('');
  const [friendAvatarUrl, setFriendAvatarUrl] = useState<string | null>(null);
  const [friendAvatarError, setFriendAvatarError] = useState(false);
  const [friendHandle, setFriendHandle] = useState('');
  const [senderProfiles, setSenderProfiles] = useState<Record<string, SenderProfile>>({});
  const senderProfileCacheRef = useRef<Record<string, SenderProfile>>({});
  const [ownProfile, setOwnProfile] = useState<SenderProfile | null>(null);
  const [dissolved, setDissolved] = useState(false);
  const [removed, setRemoved] = useState(false);
  const [left, setLeft] = useState(false);
  const [pickerTarget, setPickerTarget] = useState<StoredMessage | null>(null);
  const [pickerLayout, setPickerLayout] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const [actionMenuTarget, setActionMenuTarget] = useState<StoredMessage | null>(null);
  const [actionMenuLayout, setActionMenuLayout] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const listRef = useRef<FlatList<StoredMessage>>(null);
  const inputRef = useRef<TextInput>(null);
  const sendBtnRef = useRef<View>(null);
  const messagesRef = useRef<StoredMessage[]>([]);
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  useWebTitle(isGroup ? `${t('common.groupPrefix')}${displayName}` : displayName);

  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const node = sendBtnRef.current as unknown as HTMLElement | null;
    if (!node || typeof node.addEventListener !== 'function') return;
    const preventDesktopBlur = (e: Event): void => { e.preventDefault(); };
    node.addEventListener('mousedown', preventDesktopBlur);
    return () => {
      node.removeEventListener('mousedown', preventDesktopBlur);
    };
  }, []);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  const loadRecentMessages = useCallback(async (): Promise<void> => {
    if (!storage) return;
    const { messages: msgs, hasMore: more } = await storage.getMessagesPaginated(conversationId, undefined, 50);
    const blockedSet = new Set(blockList);
    const next = msgs.filter((m) => !blockedSet.has(m.fromDid));
    setMessages(next);
    setHasMore(more);
  }, [storage, conversationId, blockList]);

  const loadOlderMessages = useCallback(async (): Promise<void> => {
    if (!storage || !hasMore || loadingMore || messages.length === 0) return;
    setLoadingMore(true);
    try {
      const beforeId = messages[messages.length - 1]!.id;
      const { messages: older, hasMore: more } = await storage.getMessagesPaginated(conversationId, beforeId, 50);
      const blockedSet = new Set(blockList);
      const next = older.filter((m) => !blockedSet.has(m.fromDid));
      setMessages((prev) => [...prev, ...next]);
      setHasMore(more);
    } catch (err) {
      console.error('loadOlderMessages failed:', err);
    } finally {
      setLoadingMore(false);
    }
  }, [storage, conversationId, hasMore, loadingMore, messages, blockList]);

  useFocusEffect(
    useCallback(() => {
      setActiveConversation(conversationId);
      loadRecentMessages().catch((err: unknown) => {
        console.error('loadRecentMessages failed:', err);
      });
      markConversationAsRead(conversationId).catch((err: unknown) => {
        console.error('markConversationAsRead failed:', err);
      });

      return () => {
        setActiveConversation(null);
      };
    }, [loadRecentMessages, markConversationAsRead, conversationId, setActiveConversation]),
  );

  useEffect(() => {
    if (!storage) return;
    if (messagesRef.current.length === 0) {
      loadRecentMessages().catch((err: unknown) => {
        console.error('loadRecentMessages failed:', err);
      });
    } else {
      const limit = Math.max(50, messagesRef.current.length);
      storage.getMessagesPaginated(conversationId, undefined, limit).then(({ messages: recent }) => {
        if (recent.length === 0) return;
        const recentMap = new Map(recent.map((m) => [m.id, m]));
        setMessages((prev) => {
          const existingIds = new Set(prev.map((m) => m.id));
          const newMessages = recent.filter((m) => !existingIds.has(m.id));
          const merged = prev
            .filter((m) => recentMap.has(m.id))
            .map((m) => recentMap.get(m.id) ?? m);
          return [...newMessages, ...merged];
        });
      }).catch((err: unknown) => {
        console.error('merge messages failed:', err);
      });
    }
    storage.markMessagesAsRead(conversationId).catch((err: unknown) => {
      console.error('markMessagesAsRead failed:', err);
    });
  }, [chatListVersion, storage, conversationId, loadRecentMessages]);

  useEffect(() => {
    if (!isGroup || !session) return;

    // Distinct sender DIDs in the current view, excluding self (own avatar
    // is resolved by the separate ownProfile effect).
    const senderDids = [...new Set(messages.map((m) => m.fromDid))]
      .filter((did) => did !== session.did);
    if (senderDids.length === 0) return;

    // Always mirror the cache into state for DIDs we have already resolved.
    // This is the fix for the cancellation race: a fetch that was superseded
    // by a newer `messages` change (e.g. the markConversationAsRead merge)
    // still writes the cache; we surface it here instead of bailing out and
    // never calling setSenderProfiles.
    setSenderProfiles((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const did of senderDids) {
        const entry = senderProfileCacheRef.current[did];
        if (entry && prev[did] !== entry) {
          next[did] = entry;
          changed = true;
        }
      }
      return changed ? next : prev;
    });

    // Only kick off network resolution for DIDs we don't have yet. The
    // profile-cache module dedups in-flight requests and serves from its
    // own cache, so repeated calls for the same DID are no-ops.
    const missing = senderDids.filter((did) => !senderProfileCacheRef.current[did]);
    if (missing.length === 0) return;

    void (async () => {
      try {
        const profiles = await getProfilesCached(session.agent, missing);
        for (const [did, profile] of Object.entries(profiles)) {
          senderProfileCacheRef.current[did] = {
            displayName: profile.displayName ?? '',
            handle: profile.handle ?? did,
            avatarUrl: profile.avatar ?? null,
          };
        }
      } catch (err) {
        console.error('Failed to batch resolve sender profiles', missing, err);
      }

      const stillMissing = missing.filter((did) => !senderProfileCacheRef.current[did]);
      if (stillMissing.length > 0) {
        await Promise.all(
          stillMissing.map(async (did) => {
            try {
              const handle = await resolveHandleCached(did);
              senderProfileCacheRef.current[did] = { displayName: '', handle, avatarUrl: null };
            } catch {
              senderProfileCacheRef.current[did] = { displayName: '', handle: did, avatarUrl: null };
            }
          }),
        );
      }

      // Publish to state only if we're still mounted. We deliberately do NOT
      // gate this on a per-run `cancelled` flag tied to `messages` changes:
      // superseded runs already wrote the cache, and the next run's cache
      // sync (above) handles surfacing their results.
      if (!mountedRef.current) return;
      setSenderProfiles((prev) => {
        let changed = false;
        const next = { ...prev };
        for (const did of missing) {
          const entry = senderProfileCacheRef.current[did];
          if (entry && prev[did] !== entry) {
            next[did] = entry;
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    })();
  }, [messages, isGroup, session]);

  useEffect(() => {
    if (!isGroup || !session?.did) return;
    void (async () => {
      try {
        const profile = await getProfileCached(session.agent, session.did);
        if (!mountedRef.current || !profile) return;
        const next: SenderProfile = {
          displayName: profile.displayName ?? '',
          handle: profile.handle ?? '',
          avatarUrl: profile.avatar ?? null,
        };
        setOwnProfile((prev) => (prev && prev.displayName === next.displayName && prev.handle === next.handle && prev.avatarUrl === next.avatarUrl ? prev : next));
      } catch (err) {
        console.error('Failed to fetch own profile for avatar:', err);
      }
    })();
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
            const handle = await resolveHandleCached(info.creatorDid);
            if (handle !== info.creatorDid) {
              setGroupCreatorHandle(handle);
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
          const handle = await resolveHandleCached(conversationId);
          if (cancelled) return;
          if (handle !== conversationId) {
            setDisplayName(handle);
            setFriendHandle(handle);
          }
        } catch (err) {
          console.error('Failed to resolve handle for', conversationId, err);
        }
        if (!cancelled && session) {
          try {
            const profile = await getProfileCached(session.agent, conversationId);
            if (cancelled || !profile) return;
            if (profile.displayName) {
              setDisplayName(profile.displayName);
            }
            if (profile.handle) {
              setFriendHandle(profile.handle);
            }
            if (profile.avatar) {
              setFriendAvatarUrl(profile.avatar);
            }
          } catch (err) {
            console.error('Failed to fetch friend profile for', conversationId, err);
          }
        }
      })();
      return () => { cancelled = true; };
    }
  }, [conversationId, isGroup, storage, chatListVersion, session]);

  const keepInputFocused = useCallback((): void => {
    inputRef.current?.focus();
    if (Platform.OS === 'web' && typeof requestAnimationFrame !== 'undefined') {
      requestAnimationFrame(() => {
        inputRef.current?.focus();
      });
    }
  }, []);

  const onSend = useCallback(async (): Promise<void> => {
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    setSending(true);
    try {
      await sendMessage(conversationId, trimmed);
      setText('');
      keepInputFocused();
    } catch (err) {
      console.error('Send failed:', err);
    } finally {
      setSending(false);
    }
  }, [text, sending, sendMessage, conversationId, keepInputFocused]);

  const handleKeyPress = useCallback((e: { nativeEvent: { key: string; shiftKey?: boolean; preventDefault?: () => void } }): void => {
    if (Platform.OS !== 'web') return;
    const isTouchDevice = typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0;
    if (isTouchDevice) return;
    if (e.nativeEvent.key === 'Enter' && !e.nativeEvent.shiftKey) {
      e.nativeEvent.preventDefault?.();
      void onSend();
    }
  }, [onSend]);

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
    if (msg.kind === 'file') {
      if (msg.fileMeta?.localPath) {
        navigation.navigate('ChatList', {
          forwardFile: {
            localPath: msg.fileMeta.localPath,
            fileName: msg.fileMeta.fileName,
            mimeType: msg.fileMeta.mimeType,
            fileSize: msg.fileMeta.fileSize,
          },
        });
      } else {
        navigation.navigate('ChatList');
      }
      return;
    }
    navigation.navigate('ChatList', { forwardText: msg.plaintext });
  }, [navigation]);

  const handleDeleteMessage = useCallback(async (msg: StoredMessage): Promise<void> => {
    try {
      await deleteMessage(conversationId, msg.id);
      setMessages((prev) => prev.filter((m) => m.id !== msg.id));
    } catch (err) {
      console.error('deleteMessage failed:', err);
    }
  }, [deleteMessage, conversationId]);

  const handleAttach = useCallback(async (): Promise<void> => {
    try {
      const result = await DocumentPicker.getDocumentAsync({ type: '*/*' });
      if (!result.canceled && result.assets && result.assets.length > 0) {
        const asset = result.assets[0]!;
        await sendFileMessage(conversationId, asset.uri, asset.name, asset.mimeType ?? 'application/octet-stream', asset.size ?? 0);
      }
    } catch (err) {
      console.error('File pick failed:', err);
    }
  }, [conversationId, sendFileMessage]);

  const canReact = !dissolved && !removed && !left;

  const senderIdentityFor = useCallback((item: StoredMessage): {
    senderDisplayName?: string;
    senderHandle?: string;
    senderAvatarUrl?: string | null;
  } => {
    if (!isGroup) return {};
    const isOwn = item.fromDid === session?.did;
    if (isOwn) {
      return {
        senderDisplayName: ownProfile?.displayName || ownProfile?.handle || session?.did,
        senderAvatarUrl: ownProfile?.avatarUrl ?? null,
      };
    }
    const sp = senderProfiles[item.fromDid];
    return {
      senderDisplayName: sp?.displayName || sp?.handle || item.fromDid,
      senderHandle: sp?.handle,
      senderAvatarUrl: sp?.avatarUrl ?? null,
    };
  }, [isGroup, session?.did, ownProfile, senderProfiles]);

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
        let groupName: string | null = null;
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
            <Text style={styles.inviteTitle} numberOfLines={1}>
              {t('chatview.groupInviteTitle', { group: groupName ?? t('chatview.defaultGroupName') })}
            </Text>
            {alreadyResponded ? (
              <Text style={styles.inviteResponded}>{t('chatview.responded')}</Text>
            ) : (
              <View style={styles.inviteButtons}>
                <Button
                  label={t('common.accept')}
                  onPress={() => respondToGroupInvite(inviteId, true)}
                  variant="primary"
                  style={styles.inviteBtn}
                />
                <Button
                  label={t('common.decline')}
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
        const { senderDisplayName, senderHandle, senderAvatarUrl } = senderIdentityFor(item);
        const isOutgoing = item.fromDid === session?.did;
        return (
          <FileMessageBubble
            fileMeta={fileMeta}
            isOutgoing={isOutgoing}
            senderDisplayName={senderDisplayName}
            senderHandle={senderHandle}
            senderAvatarUrl={senderAvatarUrl}
            reactions={item.reactions}
            currentDid={session?.did}
            onDownload={!isOutgoing && fileMeta.downloadStatus === 'pending' ? () => {
              void downloadFile(conversationId, item.id).catch((err: unknown) => {
                console.error('Download file failed:', err);
              });
            } : undefined}
            onRetry={fileMeta.downloadStatus === 'failed' ? () => {
              void downloadFile(conversationId, item.id).catch((err: unknown) => {
                console.error('Retry download failed:', err);
              });
            } : undefined}
            onRetryUpload={fileMeta.uploadStatus === 'failed' ? () => {
              void retryUploadFileMessage(conversationId, item.id).catch((err: unknown) => {
                console.error('Retry upload failed:', err);
              });
            } : undefined}
            onImagePress={localPath ? () => {
              navigation.navigate('ImageViewer', {
                uri: localPath,
                fileName: fileMeta.fileName,
              });
            } : undefined}
            onVideoPress={localPath ? () => {
              navigation.navigate('VideoViewer', {
                uri: localPath,
                fileName: fileMeta.fileName,
              });
            } : undefined}
            onSave={fileMeta.downloadStatus === 'ready' && localPath ? () => {
              void exportFileToDevice(localPath, fileMeta.fileName, fileMeta.mimeType).catch((err: unknown) => {
                console.error('Export file failed:', err);
              });
            } : undefined}
            onReactionPress={canReact ? (emoji) => { void handleReact(item, emoji); } : undefined}
            onOpenPicker={canReact ? (layout) => handleOpenPicker(item, layout) : undefined}
            onShowActionMenu={(layout) => handleShowActionMenu(item, layout)}
          />
        );
      }

      const { senderDisplayName, senderHandle, senderAvatarUrl } = senderIdentityFor(item);
      const isOutgoing = item.fromDid === session?.did;
      return (
        <MessageBubble
          text={item.plaintext}
          isOutgoing={isOutgoing}
          reactions={item.reactions}
          currentDid={session?.did}
          senderDisplayName={senderDisplayName}
          senderHandle={senderHandle}
          senderAvatarUrl={senderAvatarUrl}
          onReactionPress={canReact ? (emoji) => { void handleReact(item, emoji); } : undefined}
          onOpenPicker={canReact ? (layout) => handleOpenPicker(item, layout) : undefined}
          onShowActionMenu={(layout) => handleShowActionMenu(item, layout)}
        />
      );
    },
    [session?.did, receivedGroupInvites, respondToGroupInvite, isGroup, senderProfiles, ownProfile, canReact, handleReact, handleOpenPicker, handleShowActionMenu, conversationId, downloadFile, retryUploadFileMessage, senderIdentityFor, t],
  );

  const keyExtractor = useCallback(
    (item: StoredMessage): string => item.id,
    [],
  );

  return (
    <View style={[styles.container, Platform.OS === 'web' && styles.containerWeb]}>
      <View style={[styles.header, Platform.OS === 'web' && styles.headerWeb]}>
        <Button
          label={t('common.back')}
          onPress={() => {
            navigation.goBack();
          }}
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
                {t('common.groupPrefix')}{displayName}
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

      <KeyboardAvoidingView
        style={styles.keyboardAvoider}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <FlatList
          ref={listRef}
          style={styles.list}
          contentContainerStyle={styles.listContent}
          data={messages}
          keyExtractor={keyExtractor}
          renderItem={renderItem}
          inverted={true}
          onEndReached={loadOlderMessages}
          onEndReachedThreshold={0.3}
          keyboardShouldPersistTaps="handled"
        />

        {dissolved || removed || left ? (
          <View style={styles.inputBar}>
            <Text style={styles.dissolvedText}>
              {dissolved ? t('chatview.dissolved') : removed ? t('chatview.removed') : t('chatview.left')}
            </Text>
          </View>
        ) : (
          <View style={styles.inputBar}>
            <TouchableOpacity onPress={handleAttach} style={styles.attachBtn} activeOpacity={0.7}>
              <Text style={styles.attachBtnText}>📄</Text>
            </TouchableOpacity>
            <TextInput
              ref={inputRef}
              style={[styles.input, { height: inputHeight }]}
              value={text}
              onChangeText={setText}
              placeholder={t('chatview.typeMessage')}
              placeholderTextColor={theme.colors.placeholder}
              autoCapitalize="none"
              autoCorrect={false}
              multiline
              onKeyPress={handleKeyPress}
              blurOnSubmit={false}
              onContentSizeChange={(e) => {
                const h = e.nativeEvent.contentSize.height;
                setInputHeight(Math.min(Math.max(h, 44), 240));
              }}
            />
            <View ref={sendBtnRef} style={styles.sendBtnWrap}>
              <Button
                label={sending ? '…' : t('chatview.send')}
                onPress={onSend}
                onPressIn={keepInputFocused}
                variant="primary"
                style={styles.sendBtn}
              />
            </View>
          </View>
        )}
      </KeyboardAvoidingView>
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
        showCopy={actionMenuTarget ? actionMenuTarget.kind !== 'file' : true}
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
  containerWeb: {
    paddingTop: 56,
  },
  keyboardAvoider: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: theme.spacing.md,
    paddingTop: theme.spacing.sm,
    height: 56,
  },
  headerWeb: {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 100,
    backgroundColor: theme.colors.background,
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
    alignItems: 'flex-end',
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    gap: theme.spacing.sm,
  },
  input: {
    flex: 1,
    backgroundColor: theme.colors.inputBackground,
    borderRadius: theme.borderRadius.sm,
    borderWidth: 1,
    borderColor: theme.colors.border,
    color: theme.colors.textPrimary,
    fontSize: theme.typography.body,
    lineHeight: 20,
    paddingHorizontal: theme.spacing.md,
    paddingTop: 10,
    paddingBottom: 10,
    textAlignVertical: 'top',
  },
  sendBtnWrap: {
    width: 72,
    height: 48,
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
