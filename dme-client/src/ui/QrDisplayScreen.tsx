/**
 * ui/QrDisplayScreen.tsx - 邀请流程：检查 Bob DME 状态并生成 Bluesky 帖子。
 *
 * 三种情况：
 *   a. Bob 没注册 → 文本帖子邀请注册，发布/取消
 *   b. Bob 已注册非好友 → 帖子嵌入 QR 码，发布/取消，发布后轮询等待扫码
 *   c. Bob 已是好友 → 提示直接去聊天
 *
 * 所有内容用 flexbox 布局。
 */

import React, { useCallback, useRef, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { Canvas, Fill } from '@shopify/react-native-skia';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import QRCode from 'react-native-qrcode-skia';

import { theme } from './theme';
import { SkiaButton } from './SkiaButton';
import { useApp } from '../state/AppContext';
import { DmeDidManager } from '../atproto/did';
import {
  checkBobDmeStatus,
  generateQrPngBytes,
  generateInvitePostText,
  generateAddFriendPostText,
  createDmeInvitePost,
} from '../handshake/invite';
import type { BobStatus } from '../handshake/invite';
import type { PendingInvite } from '../storage/db';
import { encodeHandshakeQR } from '../handshake/qr-encode';

type RootStackParamList = {
  Login: undefined;
  Setup: undefined;
  ChatList: undefined;
  ChatView: { friendDid: string };
  QrDisplay: undefined;
  QrScan: undefined;
};

type Phase = 'input' | 'checking' | 'preview' | 'already_friend' | 'publishing' | 'published' | 'error';

const QR_SIZE = 220;

export function QrDisplayScreen(): React.JSX.Element {
  const app = useApp();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();

  const [handle, setHandle] = useState('');
  const [phase, setPhase] = useState<Phase>('input');
  const [bobStatus, setBobStatus] = useState<BobStatus | null>(null);
  const [bobDid, setBobDid] = useState('');
  const [bobHandle, setBobHandle] = useState('');
  const [postText, setPostText] = useState('');
  const [qrValue, setQrValue] = useState('');
  const [errorMsg, setErrorMsg] = useState('');

  const pendingRef = useRef<{ queueId1: string } | null>(null);
  const submittedRef = useRef(false);

  const onCheckBob = useCallback(async (): Promise<void> => {
    const trimmed = handle.trim();
    if (!trimmed || !app.session || submittedRef.current) return;
    submittedRef.current = true;
    setPhase('checking');

    try {
      const result = await app.session.agent.com.atproto.identity.resolveHandle({
        handle: trimmed,
      });
      const resolvedDid = result.data.did;

      const manager = new DmeDidManager();
      const status = await checkBobDmeStatus(manager, app.storage, resolvedDid);
      setBobDid(resolvedDid);
      setBobHandle(trimmed);
      setBobStatus(status);

      if (status === 'not_registered') {
        setPostText(generateInvitePostText(trimmed));
        setPhase('preview');
      } else if (status === 'registered_not_friend') {
        const payload = await app.startHandshake(resolvedDid);
        pendingRef.current = { queueId1: payload.queueId1 };
        const encoded = encodeHandshakeQR(payload);
        setQrValue(encoded);
        setPostText(generateAddFriendPostText(trimmed));
        setPhase('preview');
      } else {
        setPhase('already_friend');
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to check Bob\'s status');
      setPhase('error');
    }
  }, [handle, app]);

  const onPublish = useCallback(async (): Promise<void> => {
    if (!app.session || phase !== 'preview') return;
    setPhase('publishing');

    try {
      const qrBytes = bobStatus === 'registered_not_friend'
        ? generateQrPngBytes(qrValue)
        : null;

      const postResult = await createDmeInvitePost(app.session.agent, postText, qrBytes);

      if (bobStatus === 'registered_not_friend' && pendingRef.current) {
        const invite: PendingInvite = {
          bobDid,
          bobHandle,
          queueId1: pendingRef.current.queueId1,
          postUri: postResult.uri,
          status: 'pending',
          createdAt: new Date().toISOString(),
        };
        await app.addPendingInvite(invite);
      }

      setPhase('published');
      setTimeout(() => navigation.goBack(), 1500);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to publish invite');
      setPhase('error');
    }
  }, [phase, bobStatus, qrValue, postText, bobDid, bobHandle, app, navigation]);

  const onCancel = useCallback((): void => {
    navigation.goBack();
  }, [navigation]);

  const onRetry = useCallback((): void => {
    submittedRef.current = false;
    setPhase('input');
    setHandle('');
    setQrValue('');
    setPostText('');
    setErrorMsg('');
    setBobStatus(null);
    pendingRef.current = null;
  }, []);

  const onGoToChat = useCallback((): void => {
    if (bobDid) {
      navigation.replace('ChatView', { friendDid: bobDid });
    }
  }, [bobDid, navigation]);

  return (
    <View style={styles.container}>
      <Canvas style={StyleSheet.absoluteFill}>
        <Fill color={theme.colors.background} />
      </Canvas>

      <View style={styles.content}>
        <Text style={styles.title}>Invite to DME</Text>

        {phase === 'input' && (
          <>
            <Text style={styles.hint}>
              Enter Bob's handle to invite them to DME.
            </Text>
            <TextInput
              style={styles.input}
              value={handle}
              onChangeText={setHandle}
              placeholder="Bob's handle (e.g. bob.bsky.social)"
              placeholderTextColor={theme.colors.placeholder}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <SkiaButton
              label="Check & Generate"
              onPress={onCheckBob}
              variant="primary"
              style={styles.fullButton}
            />
            <SkiaButton
              label="Back"
              onPress={onCancel}
              variant="secondary"
              style={styles.fullButton}
            />
          </>
        )}

        {phase === 'checking' && (
          <Text style={styles.hint}>Checking Bob's DME status...</Text>
        )}

        {phase === 'preview' && (
          <>
            <View style={styles.previewBox}>
              <Text style={styles.previewLabel}>Post Preview (editable):</Text>
              <TextInput
                style={styles.previewInput}
                value={postText}
                onChangeText={setPostText}
                multiline
                autoCapitalize="none"
                autoCorrect={false}
                placeholderTextColor={theme.colors.placeholder}
              />
            </View>

            {qrValue ? (
              <View style={styles.qrWrap}>
                <QRCode
                  value={qrValue}
                  size={QR_SIZE}
                  color={theme.colors.textPrimary}
                  style={styles.qr}
                />
              </View>
            ) : null}

            <SkiaButton
              label="Publish to Bluesky"
              onPress={onPublish}
              variant="primary"
              style={styles.fullButton}
            />
            <SkiaButton
              label="Cancel"
              onPress={onCancel}
              variant="secondary"
              style={styles.fullButton}
            />
          </>
        )}

        {phase === 'already_friend' && (
          <>
            <Text style={styles.hint}>{bobHandle} is already your DME friend!</Text>
            <SkiaButton
              label="Go to Chat"
              onPress={onGoToChat}
              variant="primary"
              style={styles.fullButton}
            />
            <SkiaButton
              label="Back"
              onPress={onCancel}
              variant="secondary"
              style={styles.fullButton}
            />
          </>
        )}

        {phase === 'publishing' && (
          <Text style={styles.hint}>Publishing to Bluesky...</Text>
        )}

        {phase === 'published' && (
          <>
            <Text style={styles.hint}>Invite published!</Text>
            <SkiaButton
              label="Back to Chats"
              onPress={() => navigation.goBack()}
              variant="primary"
              style={styles.fullButton}
            />
          </>
        )}

        {phase === 'error' && (
          <>
            <Text style={[styles.hint, { color: theme.colors.error }]}>{errorMsg}</Text>
            <SkiaButton
              label="Try Again"
              onPress={onRetry}
              variant="primary"
              style={styles.fullButton}
            />
            <SkiaButton
              label="Back"
              onPress={onCancel}
              variant="secondary"
              style={styles.fullButton}
            />
          </>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  content: {
    flex: 1,
    paddingHorizontal: theme.spacing.md,
    paddingTop: theme.spacing.lg,
    gap: theme.spacing.md,
  },
  title: {
    color: theme.colors.textPrimary,
    fontSize: theme.typography.heading,
    fontWeight: '700',
    marginBottom: theme.spacing.sm,
  },
  hint: {
    fontSize: 15,
    color: theme.colors.textSecondary,
    lineHeight: 22,
  },
  input: {
    height: 48,
    backgroundColor: theme.colors.inputBackground,
    borderRadius: theme.borderRadius.sm,
    borderWidth: 1,
    borderColor: theme.colors.border,
    color: theme.colors.textPrimary,
    fontSize: theme.typography.body,
    paddingHorizontal: theme.spacing.md,
  },
  fullButton: {
    width: '100%',
    height: 48,
  },
  previewBox: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: 12,
    minHeight: 120,
  },
  previewLabel: {
    color: theme.colors.textSecondary,
    fontSize: 12,
    marginBottom: 6,
  },
  previewInput: {
    color: theme.colors.textPrimary,
    fontSize: 14,
    lineHeight: 20,
    flex: 1,
    textAlignVertical: 'top',
    padding: 0,
  },
  qrWrap: {
    alignItems: 'center',
    marginVertical: theme.spacing.sm,
  },
  qr: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.borderRadius.md,
  },
});
