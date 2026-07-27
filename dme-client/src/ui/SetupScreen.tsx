/**
 * ui/SetupScreen.tsx - Post-login identity key setup.
 *
 * Flow:
 *   1. Check if identity key exists and is declared on DID.
 *   2. If already declared -> skip to ChatList.
 *   3. "Publish to DID" -> requestPlcSignature (emails token).
 *   4. Enter PLC token -> declareKeys(plcToken).
 *   5. navigate to ChatList.
 *
 * All content uses flexbox layout.
 */

import React, { useEffect, useState, useCallback, useRef } from 'react';
import { Platform, StyleSheet, Text, View, TextInput } from 'react-native';
import { Canvas, Fill } from '@shopify/react-native-skia';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';

import { theme } from './theme';
import { SkiaButton } from './SkiaButton';
import { useApp } from '../state/AppContext';
import { getRemoteEncryptionKey, requestPlcSignature } from '../atproto/did';
import type { RootStackParamList } from '../types/navigation';

function readWebQuery(key: string): string | null {
  if (Platform.OS !== 'web') return null;
  return new URLSearchParams(window.location.search).get(key);
}

interface SetupScreenProps {
  navigation: NativeStackNavigationProp<RootStackParamList, 'Setup'>;
}

export function SetupScreen({ navigation }: SetupScreenProps): React.JSX.Element {
  const app = useApp();

  const [step, setStep] = useState<'checking' | 'publish' | 'token' | 'declaring' | 'done' | 'check_error'>('checking');
  const [error, setError] = useState<string | null>(null);
  const [plcToken, setPlcToken] = useState('');

  const checkKey = useCallback(async (signal: { cancelled: boolean }): Promise<void> => {
    if (!app.session || !app.identityKeys) return;

    try {
      const remoteKey = await getRemoteEncryptionKey(app.session.did);
      if (!remoteKey) {
        if (!signal.cancelled) setStep('publish');
        return;
      }
      const localKey = app.identityKeys.encryption.publicKey;
      const matches = remoteKey.length === localKey.length &&
        remoteKey.every((b: number, i: number) => b === localKey[i]);
      if (!signal.cancelled) {
        if (matches) {
          setStep('done');
          navigation.replace('ChatList');
        } else {
          setStep('publish');
        }
      }
    } catch (err) {
      if (signal.cancelled) return;
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      setStep('check_error');
    }
  }, [app.session, app.identityKeys, navigation]);

  useEffect(() => {
    const signal = { cancelled: false };
    checkKey(signal);
    return () => { signal.cancelled = true; };
  }, [checkKey]);

  const requestSignature = useCallback(async (): Promise<void> => {
    if (!app.session) return;
    setError(null);
    try {
      await requestPlcSignature(app.session.agent);
      setStep('token');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to request PLC signature');
    }
  }, [app.session]);

  const declareKeys = useCallback(async (token: string): Promise<void> => {
    setError(null);
    setStep('declaring');

    try {
      await app.declareKeys(token.trim());
      setStep('done');
      navigation.replace('ChatList');
    } catch (err) {
      setStep('token');
      setError(err instanceof Error ? err.message : 'Failed to declare keys');
    }
  }, [app, navigation]);

  // Auto-publish: request signature, then if urlToken provided, auto-declare
  const autoPublishRan = useRef(false);
  const autoPublish = readWebQuery('autoPublish') === '1';
  const urlToken = readWebQuery('token');
  useEffect(() => {
    if (autoPublish && !autoPublishRan.current && step === 'publish' && app.session) {
      autoPublishRan.current = true;
      if (urlToken) {
        // Token provided via URL, skip email step
        declareKeys(urlToken);
      } else {
        // Request signature email
        requestSignature();
      }
    }
  }, [autoPublish, urlToken, step, app.session, declareKeys, requestSignature]);

  return (
    <View style={styles.container}>
      <Canvas style={StyleSheet.absoluteFill}>
        <Fill color={theme.colors.background} />
      </Canvas>

      <View style={styles.content}>
        <Text style={styles.title}>Setup Identity</Text>

        {step === 'checking' && (
          <Text style={styles.statusText}>Checking identity key...</Text>
        )}

        {step === 'publish' && (
          <SkiaButton
            label="Publish to DID"
            onPress={requestSignature}
            variant="primary"
            style={styles.fullButton}
          />
        )}

        {step === 'token' && (
          <>
            <Text style={styles.statusText}>
              Enter the PLC token sent to your email:
            </Text>
            <TextInput
              style={styles.input}
              value={plcToken}
              onChangeText={setPlcToken}
              placeholder="PLC token"
              placeholderTextColor={theme.colors.textSecondary}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <SkiaButton
              label="Declare Keys"
              onPress={() => declareKeys(plcToken)}
              variant="primary"
              style={styles.fullButton}
            />
          </>
        )}

        {step === 'declaring' && (
          <Text style={styles.statusText}>Declaring keys...</Text>
        )}

        {step === 'check_error' && (
          <>
            <SkiaButton
              label="Retry Check"
              onPress={() => {
                setError(null);
                setStep('checking');
                const signal = { cancelled: false };
                checkKey(signal);
              }}
              variant="primary"
              style={styles.fullButton}
            />
            <SkiaButton
              label="Back to Login"
              onPress={() => app.logout().catch((err: unknown) => console.error('Logout failed:', err))}
              variant="secondary"
              style={styles.fullButton}
            />
          </>
        )}

        {step !== 'checking' && step !== 'check_error' && step !== 'declaring' && (
          <SkiaButton
            label="Cancel"
            onPress={() => app.logout().catch((err: unknown) => console.error('Logout failed:', err))}
            variant="secondary"
            style={styles.fullButton}
          />
        )}

        {error ? (
          <Text style={styles.error}>{error}</Text>
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
    gap: theme.spacing.md,
  },
  title: {
    color: theme.colors.textPrimary,
    fontSize: theme.typography.heading,
    fontWeight: '700',
    marginBottom: theme.spacing.md,
  },
  statusText: {
    color: theme.colors.textSecondary,
    fontSize: theme.typography.body,
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
  },
  fullButton: {
    width: '100%',
    height: 48,
  },
  error: {
    color: theme.colors.error,
    fontSize: theme.typography.caption,
    marginTop: theme.spacing.sm,
    textAlign: 'center',
  },
});
