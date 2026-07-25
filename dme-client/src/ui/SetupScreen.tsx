/**
 * ui/SetupScreen.tsx - Post-login identity key setup.
 *
 * Flow:
 *   1. Check if identity key exists and is declared on DID.
 *   2. If already declared -> skip to ChatList.
 *   3. Generate key (if missing).
 *   4. "Publish to DID" -> requestPlcSignature.
 *   5. TextInput for email token.
 *   6. declareEncryptionKey -> navigate to ChatList.
 *
 * All content uses flexbox layout.
 */

import React, { useEffect, useState, useCallback, useRef } from 'react';
import { Platform, StyleSheet, Text, TextInput, View } from 'react-native';
import { Canvas, Fill } from '@shopify/react-native-skia';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';

import { theme } from './theme';
import { SkiaButton } from './SkiaButton';
import { useApp } from '../state/AppContext';
import { DmeDidManager } from '../atproto/did';

function readWebQuery(key: string): string | null {
  if (Platform.OS !== 'web') return null;
  return new URLSearchParams(window.location.search).get(key);
}

type RootStackParamList = {
  Login: undefined;
  Setup: undefined;
  ChatList: undefined;
};

interface SetupScreenProps {
  navigation: NativeStackNavigationProp<RootStackParamList, 'Setup'>;
}

export function SetupScreen({ navigation }: SetupScreenProps): React.JSX.Element {
  const app = useApp();

  const [step, setStep] = useState<'checking' | 'publish' | 'token' | 'declaring' | 'done' | 'check_error'>('checking');
  const [error, setError] = useState<string | null>(null);
  const [plcToken, setPlcToken] = useState('');

  const checkKey = useCallback(async (signal: { cancelled: boolean }): Promise<void> => {
    if (!app.session || !app.identityKey) return;

    const manager = new DmeDidManager();
    try {
      const remoteKey = await manager.getRemoteEncryptionKey(app.session.did);
      const localKey = app.identityKey.publicKey;
      const matches = remoteKey.length === localKey.length &&
        remoteKey.every((b, i) => b === localKey[i]);
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
      if (msg.includes('DmeDidManager:')) {
        setStep('publish');
      } else {
        setError(msg);
        setStep('check_error');
      }
    }
  }, [app.session, app.identityKey, navigation]);

  useEffect(() => {
    const signal = { cancelled: false };
    checkKey(signal);
    return () => { signal.cancelled = true; };
  }, [checkKey]);

  const requestSignature = useCallback(async (): Promise<void> => {
    if (!app.session) return;
    setError(null);
    try {
      await DmeDidManager.requestPlcSignature(app.session.agent);
      setStep('token');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to request PLC signature');
    }
  }, [app.session]);

  const autoPublishRan = useRef(false);
  const autoPublish = readWebQuery('autoPublish') === '1';
  useEffect(() => {
    if (autoPublish && !autoPublishRan.current && step === 'publish' && app.session) {
      autoPublishRan.current = true;
      requestSignature();
    }
  }, [autoPublish, step, app.session, requestSignature]);

  const declareKey = useCallback(async (): Promise<void> => {
    if (!plcToken.trim()) return;
    setError(null);
    setStep('declaring');

    try {
      await app.declareKey(plcToken.trim());
      setStep('done');
      navigation.replace('ChatList');
    } catch (err) {
      setStep('token');
      setError(err instanceof Error ? err.message : 'Failed to declare encryption key');
    }
  }, [app, plcToken, navigation]);

  const autoDeclareRan = useRef(false);
  const pendingAutoDeclare = useRef(false);
  const urlToken = readWebQuery('token');
  useEffect(() => {
    if (urlToken && !autoDeclareRan.current && (step === 'token' || step === 'publish')) {
      autoDeclareRan.current = true;
      if (step === 'publish') {
        setStep('token');
      }
      pendingAutoDeclare.current = true;
      setPlcToken(urlToken);
    }
  }, [urlToken, step]);

  useEffect(() => {
    if (pendingAutoDeclare.current && plcToken && step === 'token') {
      pendingAutoDeclare.current = false;
      declareKey();
    }
  }, [plcToken, step, declareKey]);

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
            <TextInput
              style={styles.input}
              value={plcToken}
              onChangeText={setPlcToken}
              placeholder="Enter PLC email token"
              placeholderTextColor={theme.colors.placeholder}
              autoCapitalize="none"
              autoCorrect={false}
              onSubmitEditing={declareKey}
              returnKeyType="send"
            />
            <SkiaButton
              label="Confirm"
              onPress={declareKey}
              variant="primary"
              style={styles.fullButton}
            />
          </>
        )}

        {step === 'declaring' && (
          <TextInput
            style={styles.input}
            value="Declaring key..."
            onChangeText={() => {}}
            editable={false}
          />
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
              onPress={() => app.logout().catch(console.error)}
              variant="secondary"
              style={styles.fullButton}
            />
          </>
        )}

        {step !== 'checking' && step !== 'check_error' && (
          <SkiaButton
            label="Cancel"
            onPress={() => app.logout().catch(console.error)}
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
