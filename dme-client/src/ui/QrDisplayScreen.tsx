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

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Image } from 'expo-image';
import { useNavigation, useRoute } from '@react-navigation/native';
import type { NativeStackNavigationProp, NativeStackScreenProps } from '@react-navigation/native-stack';

import { theme } from './theme';
import { Button } from './Button';
import { ScreenBackground } from './ScreenBackground';
import { useApp } from '../state/AppContext';
import { useI18n } from '../i18n/I18nContext';
import {
  checkBobDmeStatus,
  generateQrPngBytes,
  generateQrSvgDataUri,
  generateInvitePostText,
  generateAddFriendPostText,
  createDmeInvitePost,
} from '../handshake/invite';
import type { BobStatus } from '../handshake/invite';

type RootStackParamList = {
  Login: undefined;
  Setup: undefined;
  ChatList: undefined;
  ChatView: { friendDid: string; handle?: string };
  QrDisplay: { did?: string; handle?: string } | undefined;
  QrScan: undefined;
};

type QrDisplayRouteProp = NativeStackScreenProps<RootStackParamList, 'QrDisplay'>['route'];

type Phase = 'input' | 'checking' | 'preview' | 'already_friend' | 'publishing' | 'published' | 'error';

const QR_SIZE = 220;

export function QrDisplayScreen(): React.JSX.Element {
  const app = useApp();
  const { t, language } = useI18n();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const route = useRoute<QrDisplayRouteProp>();
  // DME_START_CHAT（web 嵌入态）携带目标 DID 直达：跳过 handle 输入，挂载即自动检查。
  const autoDid = route.params?.did;
  const autoHandle = route.params?.handle;
  const autoStartedRef = useRef(false);

  const [handle, setHandle] = useState('');
  const [phase, setPhase] = useState<Phase>('input');
  const [bobStatus, setBobStatus] = useState<BobStatus | null>(null);
  const [bobDid, setBobDid] = useState('');
  const [bobHandle, setBobHandle] = useState('');
  const [postText, setPostText] = useState('');
  const [qrValue, setQrValue] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [previewHeight, setPreviewHeight] = useState(0);

  const submittedRef = useRef(false);
  const keyPackageSerializedRef = useRef<string>('');
  const welcomeQueueIdRef = useRef<string>('');
  const [qrDataUri, setQrDataUri] = useState<string | null>(null);

  // Render the QR preview from a pure-JS SVG (qrcode library). We deliberately
  // avoid Skia here: both the Skia <QRCode> component and Skia.Surface.MakeOffscreen
  // require a WebGL/graphics context that is unavailable in some web
  // environments, leaving the preview blank (or crashing the screen).
  useEffect(() => {
    if (!qrValue) {
      setQrDataUri(null);
      return;
    }
    let cancelled = false;
    generateQrSvgDataUri(qrValue, QR_SIZE)
      .then((uri) => {
        if (!cancelled) setQrDataUri(uri);
      })
      .catch((err: unknown) => {
        console.error('Failed to render QR preview:', err);
        if (!cancelled) setQrDataUri(null);
      });
    return () => {
      cancelled = true;
    };
  }, [qrValue]);

  /**
   * 对既定 DID 执行三路检查（未注册 / 已注册非好友 / 已是好友）。手动输入
   * 路径先 resolveHandle 再进入；DME_START_CHAT 直达路径跳过解析直接调用。
   * `submittedRef` 防重入：调用方负责在需要重新检查时复位。
   */
  const runCheck = useCallback(async (targetDid: string, displayHandle: string): Promise<void> => {
    if (!app.session || submittedRef.current) return;
    submittedRef.current = true;
    setPhase('checking');

    try {
      if (targetDid === app.session.did) {
        setErrorMsg(t('qrdisplay.cantInviteSelf'));
        setPhase('error');
        return;
      }

      const status = await checkBobDmeStatus(app.storage, targetDid);
      setBobDid(targetDid);
      setBobHandle(displayHandle);
      setBobStatus(status);

      if (status === 'not_registered') {
        setPostText(generateInvitePostText(displayHandle, language));
        setPhase('preview');
      } else if (status === 'registered_not_friend') {
        const { qrString, keyPackageSerialized, welcomeQueueId } = await app.generateInviteQr(targetDid);
        setQrValue(qrString);
        keyPackageSerializedRef.current = keyPackageSerialized;
        welcomeQueueIdRef.current = welcomeQueueId;
        setPostText(generateAddFriendPostText(displayHandle, language));
        setPhase('preview');
      } else {
        setPhase('already_friend');
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : t('qrdisplay.failedCheck'));
      setPhase('error');
    }
  }, [app.session, app.storage, app.generateInviteQr, language, t]);

  const onCheckBob = useCallback(async (): Promise<void> => {
    const trimmed = handle.trim();
    if (!trimmed || !app.session) return;
    try {
      const result = await app.session.agent.com.atproto.identity.resolveHandle({
        handle: trimmed,
      });
      const resolvedDid = result.data.did;
      await runCheck(resolvedDid, trimmed);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : t('qrdisplay.failedCheck'));
      setPhase('error');
    }
  }, [handle, app.session, runCheck, t]);

  // DME_START_CHAT 直达：挂载即自动检查（只跑一次；重试走 onRetry）。
  // session 未就绪时等待，不置 started 标记，避免空转后永久卡在 input 阶段。
  useEffect(() => {
    if (!autoDid || autoStartedRef.current || !app.session) return;
    autoStartedRef.current = true;
    void runCheck(autoDid, autoHandle ?? autoDid);
  }, [autoDid, autoHandle, app.session, runCheck]);

  const onPublish = useCallback(async (): Promise<void> => {
    if (!app.session || phase !== 'preview') return;
    setPhase('publishing');

    try {
      const qrBytes = bobStatus === 'registered_not_friend'
        ? await generateQrPngBytes(qrValue)
        : null;

      await createDmeInvitePost(app.session.agent, postText, qrBytes, language);

      // Only start waiting for the handshake after the invite post is published.
      if (bobStatus === 'registered_not_friend' && bobDid && keyPackageSerializedRef.current && welcomeQueueIdRef.current) {
        await app.trackInvitePendingWelcome(bobDid, keyPackageSerializedRef.current, welcomeQueueIdRef.current);
      }

      setPhase('published');
      setTimeout(() => navigation.goBack(), 1500);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : t('qrdisplay.failedPublish'));
      setPhase('error');
    }
  }, [phase, bobStatus, qrValue, postText, app, bobDid, navigation, language]);

  const onCancel = useCallback((): void => {
    navigation.goBack();
  }, [navigation]);

  const onRetry = useCallback((): void => {
    submittedRef.current = false;
    keyPackageSerializedRef.current = '';
    welcomeQueueIdRef.current = '';
    setQrValue('');
    setPostText('');
    setErrorMsg('');
    setBobStatus(null);
    if (autoDid) {
      // DME_START_CHAT 直达路径：重试 = 重新自动检查，不回到 handle 输入。
      void runCheck(autoDid, autoHandle ?? autoDid);
    } else {
      setPhase('input');
      setHandle('');
    }
  }, [autoDid, autoHandle, runCheck]);

  const onGoToChat = useCallback((): void => {
    if (bobDid) {
      navigation.replace('ChatView', { friendDid: bobDid, handle: bobHandle || undefined });
    }
  }, [bobDid, bobHandle, navigation]);

  return (
    <View style={styles.container}>
      <ScreenBackground />

      <ScrollView
        style={styles.content}
        contentContainerStyle={styles.contentInner}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.title}>{t('qrdisplay.title')}</Text>

        {phase === 'input' && (
          <>
            <Text style={styles.hint}>
              {t('qrdisplay.hint')}
            </Text>
            <TextInput
              style={styles.input}
              value={handle}
              onChangeText={setHandle}
              onSubmitEditing={onCheckBob}
              returnKeyType="go"
              placeholder={t('qrdisplay.handlePlaceholder')}
              placeholderTextColor={theme.colors.placeholder}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <Button
              label={t('qrdisplay.checkGenerate')}
              onPress={onCheckBob}
              variant="primary"
              style={styles.fullButton}
            />
            <Button
              label={t('common.back')}
              onPress={onCancel}
              variant="secondary"
              style={styles.fullButton}
            />
          </>
        )}

        {phase === 'checking' && (
          <Text style={styles.hint}>{t('qrdisplay.checking')}</Text>
        )}

        {phase === 'preview' && (
          <>
            <View style={styles.previewBox}>
              <Text style={styles.previewLabel}>{t('qrdisplay.previewLabel')}</Text>
              <TextInput
                style={[styles.previewInput, previewHeight > 0 ? { minHeight: previewHeight } : null]}
                value={postText}
                onChangeText={setPostText}
                onContentSizeChange={(e) => {
                  const h = e.nativeEvent.contentSize.height;
                  setPreviewHeight((prev) => (Math.abs(prev - h) > 1 ? h : prev));
                }}
                multiline
                scrollEnabled={false}
                autoCapitalize="none"
                autoCorrect={false}
                placeholderTextColor={theme.colors.placeholder}
              />
            </View>

            {qrDataUri ? (
              <View style={styles.qrWrap}>
                <Image
                  source={{ uri: qrDataUri }}
                  style={styles.qr}
                  contentFit="contain"
                />
              </View>
            ) : null}

            <Button
              label={t('qrdisplay.publish')}
              onPress={onPublish}
              variant="primary"
              style={styles.fullButton}
            />
            <Button
              label={t('common.cancel')}
              onPress={onCancel}
              variant="secondary"
              style={styles.fullButton}
            />
          </>
        )}

        {phase === 'already_friend' && (
          <>
            <Text style={styles.hint}>{t('qrdisplay.alreadyFriend', { handle: bobHandle })}</Text>
            <Button
              label={t('qrdisplay.goToChat')}
              onPress={onGoToChat}
              variant="primary"
              style={styles.fullButton}
            />
            <Button
              label={t('common.back')}
              onPress={onCancel}
              variant="secondary"
              style={styles.fullButton}
            />
          </>
        )}

        {phase === 'publishing' && (
          <Text style={styles.hint}>{t('qrdisplay.publishing')}</Text>
        )}

        {phase === 'published' && (
          <>
            <Text style={styles.hint}>{t('qrdisplay.published')}</Text>
            <Button
              label={t('qrdisplay.backToChats')}
              onPress={() => navigation.goBack()}
              variant="primary"
              style={styles.fullButton}
            />
          </>
        )}

        {phase === 'error' && (
          <>
            <Text style={[styles.hint, { color: theme.colors.error }]}>{errorMsg}</Text>
            <Button
              label={t('common.tryAgain')}
              onPress={onRetry}
              variant="primary"
              style={styles.fullButton}
            />
            <Button
              label={t('common.back')}
              onPress={onCancel}
              variant="secondary"
              style={styles.fullButton}
            />
          </>
        )}
      </ScrollView>
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
  },
  contentInner: {
    paddingHorizontal: theme.spacing.md,
    paddingTop: theme.spacing.lg,
    paddingBottom: theme.spacing.lg,
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
    textAlignVertical: 'top',
    padding: 0,
  },
  qrWrap: {
    alignItems: 'center',
    marginVertical: theme.spacing.sm,
  },
  qr: {
    width: QR_SIZE,
    height: QR_SIZE,
    backgroundColor: theme.colors.surface,
    borderRadius: theme.borderRadius.md,
  },
});
