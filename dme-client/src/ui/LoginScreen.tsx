/**
 * ui/LoginScreen.tsx - Login screen with flexbox layout.
 *
 * Screen backdrop is a solid-color View via ScreenBackground (no Skia).
 * All interactive elements use RN Views/TextInput with flexbox positioning.
 */

import React, { useState, useCallback, useEffect, useRef } from 'react';
import { Platform, StyleSheet, Text, TextInput, View } from 'react-native';
import { Image } from 'expo-image';

import { theme } from './theme';
import { Button } from './Button';
import { ScreenBackground } from './ScreenBackground';
import { useApp } from '../state/AppContext';
import { useI18n } from '../i18n/I18nContext';
import { PDS_URL } from '../config';

function readWebQuery(key: string): string | null {
  if (Platform.OS !== 'web') return null;
  return new URLSearchParams(window.location.search).get(key);
}

export function LoginScreen(): React.JSX.Element {
  const app = useApp();
  const { t } = useI18n();

  const [pdsUrl, setPdsUrl] = useState(() => readWebQuery('pds') ?? PDS_URL);
  const [handle, setHandle] = useState(() => readWebQuery('handle') ?? '');
  const [password, setPassword] = useState(() => readWebQuery('password') ?? '');
  const [authFactorToken, setAuthFactorToken] = useState('');
  const autoLogin = readWebQuery('auto') === '1';
  const autoLoginRan = useRef(false);

  const awaiting2FA = app.loginStep === 'awaiting2FA';

  const onLogin = useCallback(async (): Promise<void> => {
    if (!handle.trim() || !password.trim()) return;
    try {
      await app.login({
        identifier: handle.trim(),
        password: password.trim(),
        pdsUrl: pdsUrl.trim() || PDS_URL,
        authFactorToken: awaiting2FA ? authFactorToken.trim() || undefined : undefined,
      });
    } catch (err) {
      console.error('Login failed:', err);
    }
  }, [app, handle, password, pdsUrl, authFactorToken, awaiting2FA]);

  const onBackToPassword = useCallback((): void => {
    app.cancel2FA();
    setAuthFactorToken('');
  }, [app]);

  useEffect(() => {
    if (autoLogin && !autoLoginRan.current && handle && password && !awaiting2FA) {
      autoLoginRan.current = true;
      onLogin();
    }
  }, [autoLogin, handle, password, onLogin, awaiting2FA]);

  return (
    <View style={styles.container}>
      <ScreenBackground />

      <View style={styles.content}>
        <Image
          source={require('../../assets/images/logo.png')}
          style={styles.logo}
          contentFit="contain"
          accessibilityLabel={t('login.title')}
        />
        <Text style={styles.title}>{t('login.title')}</Text>

        <TextInput
          style={styles.input}
          value={pdsUrl}
          onChangeText={setPdsUrl}
          placeholder={t('login.pdsPlaceholder')}
          placeholderTextColor={theme.colors.placeholder}
          autoCapitalize="none"
          autoCorrect={false}
          editable={!awaiting2FA}
        />

        <TextInput
          style={styles.input}
          value={handle}
          onChangeText={setHandle}
          placeholder={t('login.handlePlaceholder')}
          placeholderTextColor={theme.colors.placeholder}
          autoCapitalize="none"
          autoCorrect={false}
          editable={!awaiting2FA}
        />

        <TextInput
          style={styles.input}
          value={password}
          onChangeText={setPassword}
          placeholder={t('login.passwordPlaceholder')}
          placeholderTextColor={theme.colors.placeholder}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          onSubmitEditing={onLogin}
          returnKeyType="send"
          editable={!awaiting2FA}
        />

        {awaiting2FA ? (
          // ⚠️ 不设 maxLength：2FA 验证码长度目前无统一标准，可能是 6 位以上
          <TextInput
            style={[styles.input, styles.codeInput]}
            value={authFactorToken}
            onChangeText={setAuthFactorToken}
            placeholder={t('login.2faPlaceholder')}
            placeholderTextColor={theme.colors.placeholder}
            autoCapitalize="none"
            autoCorrect={false}
            autoFocus
            onSubmitEditing={onLogin}
            returnKeyType="send"
          />
        ) : null}

        <Button
          label={
            app.loading
              ? t('login.loggingIn')
              : awaiting2FA
                ? t('login.verify')
                : t('login.button')
          }
          onPress={onLogin}
          variant="primary"
          style={styles.button}
        />

        {awaiting2FA ? (
          <Button
            label={t('login.backToPassword')}
            onPress={onBackToPassword}
            variant="secondary"
            style={styles.secondaryButton}
          />
        ) : null}

        {app.error ? (
          <Text style={styles.error}>{app.error}</Text>
        ) : null}
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
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: theme.spacing.lg,
  },
  logo: {
    width: 96,
    height: 96,
    marginBottom: theme.spacing.md,
  },
  title: {
    color: theme.colors.textPrimary,
    fontSize: theme.typography.title,
    fontWeight: '700',
    marginBottom: theme.spacing.xl,
  },
  input: {
    width: '100%',
    height: 48,
    backgroundColor: theme.colors.inputBackground,
    borderRadius: theme.borderRadius.sm,
    borderWidth: 1,
    borderColor: theme.colors.border,
    color: theme.colors.textPrimary,
    fontSize: theme.typography.body,
    paddingHorizontal: theme.spacing.md,
    marginBottom: theme.spacing.md,
  },
  codeInput: {
    borderColor: theme.colors.accent,
    textAlign: 'center',
    letterSpacing: 8,
  },
  button: {
    width: '100%',
    height: 48,
    marginTop: theme.spacing.sm,
  },
  secondaryButton: {
    width: '100%',
    height: 48,
    marginTop: theme.spacing.sm,
  },
  error: {
    color: theme.colors.error,
    fontSize: theme.typography.caption,
    marginTop: theme.spacing.md,
    textAlign: 'center',
  },
});
