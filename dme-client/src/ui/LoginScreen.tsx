/**
 * ui/LoginScreen.tsx - Login screen with flexbox layout.
 *
 * Screen backdrop is a solid-color View via ScreenBackground (no Skia).
 * All interactive elements use RN Views/TextInput with flexbox positioning.
 */

import React, { useState, useCallback, useEffect, useRef } from 'react';
import { Platform, StyleSheet, Text, TextInput, View } from 'react-native';

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
  const autoLogin = readWebQuery('auto') === '1';
  const autoLoginRan = useRef(false);

  const onLogin = useCallback(async (): Promise<void> => {
    if (!handle.trim() || !password.trim()) return;
    try {
      await app.login(handle.trim(), password.trim(), pdsUrl.trim() || PDS_URL);
    } catch (err) {
      console.error('Login failed:', err);
    }
  }, [app, handle, password, pdsUrl]);

  useEffect(() => {
    if (autoLogin && !autoLoginRan.current && handle && password) {
      autoLoginRan.current = true;
      onLogin();
    }
  }, [autoLogin, handle, password, onLogin]);

  return (
    <View style={styles.container}>
      <ScreenBackground />

      <View style={styles.content}>
        <Text style={styles.title}>{t('login.title')}</Text>

        <TextInput
          style={styles.input}
          value={pdsUrl}
          onChangeText={setPdsUrl}
          placeholder={t('login.pdsPlaceholder')}
          placeholderTextColor={theme.colors.placeholder}
          autoCapitalize="none"
          autoCorrect={false}
        />

        <TextInput
          style={styles.input}
          value={handle}
          onChangeText={setHandle}
          placeholder={t('login.handlePlaceholder')}
          placeholderTextColor={theme.colors.placeholder}
          autoCapitalize="none"
          autoCorrect={false}
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
        />

        <Button
          label={app.loading ? t('login.loggingIn') : t('login.button')}
          onPress={onLogin}
          variant="primary"
          style={styles.button}
        />

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
  button: {
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
