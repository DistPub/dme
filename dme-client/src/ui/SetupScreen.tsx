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
import { Platform, ScrollView, StyleSheet, Text, View, TextInput } from 'react-native';
import { Canvas, Fill } from '@shopify/react-native-skia';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';

import { theme } from './theme';
import { Button } from './Button';
import { useApp } from '../state/AppContext';
import { getRemoteEncryptionKey, requestPlcSignature, getDidMethod, generateDidWebUpdate, type DidWebEntry } from '../atproto/did';
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

  const [step, setStep] = useState<'checking' | 'publish' | 'token' | 'declaring' | 'done' | 'check_error' | 'restore_choice' | 'restore_password' | 'web_instructions'>('checking');
  const [error, setError] = useState<string | null>(null);
  const [plcToken, setPlcToken] = useState('');
  const [backupPassword, setBackupPassword] = useState('');
  const [restoring, setRestoring] = useState(false);
  const [didWebUpdate, setDidWebUpdate] = useState<{ didJson: string | null; newEntries: DidWebEntry[] } | null>(null);

  const checkKey = useCallback(async (signal: { cancelled: boolean }): Promise<void> => {
    if (!app.session || !app.identityKeys) return;

    try {
      const remoteKey = await getRemoteEncryptionKey(app.session.did);
      if (!remoteKey) {
        if (signal.cancelled) return;
        if (getDidMethod(app.session.did) === 'web') {
          const update = await generateDidWebUpdate(app.session.did, app.identityKeys);
          setDidWebUpdate(update);
          setStep('web_instructions');
        } else {
          setStep('publish');
        }
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
          setStep('restore_choice');
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

  const handleRestore = useCallback(async (password: string): Promise<void> => {
    setError(null);
    setRestoring(true);
    try {
      const ok = await app.restoreIdentityFromBackup(password);
      if (ok) {
        setStep('done');
        navigation.replace('ChatList');
      } else {
        setError('未找到备份');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '恢复失败');
    } finally {
      setRestoring(false);
    }
  }, [app, navigation]);

  const renderJsonWithHighlight = (jsonStr: string, highlightAll = false): React.ReactNode[] => {
    const lines = jsonStr.split('\n');
    const nodes: React.ReactNode[] = [];
    let inDmeSection = false;
    let currentGroup: string[] = [];
    let groupStart = 0;

    const flushGroup = (key: string) => {
      if (currentGroup.length === 0) return;
      nodes.push(
        <View key={key} style={styles.jsonLineHighlightBg}>
          {currentGroup.map((line, idx) => (
            <Text key={idx} selectable style={styles.jsonLineHighlight}>
              {line}
            </Text>
          ))}
        </View>
      );
      currentGroup = [];
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const isDmeKey = line.includes('dme_encryption') || line.includes('dme_signing');
      const isDmeEntryStart = line.trim() === '{' && i + 1 < lines.length &&
        (lines[i + 1]!.includes('dme_encryption') || lines[i + 1]!.includes('dme_signing'));

      if (isDmeKey || isDmeEntryStart) {
        inDmeSection = true;
      }

      const isSectionEnd = inDmeSection && line.trim().startsWith('}');
      const isHighlight = highlightAll || inDmeSection || isDmeKey || isDmeEntryStart;

      if (isHighlight) {
        if (currentGroup.length === 0) groupStart = i;
        currentGroup.push(line);
        if (isSectionEnd) {
          inDmeSection = false;
        }
      } else {
        flushGroup(`g-${groupStart}`);
        nodes.push(
          <Text key={`l-${i}`} selectable style={styles.jsonLineNormal}>
            {line}
          </Text>
        );
      }
    }
    flushGroup(`g-${groupStart}`);

    return nodes;
  };

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
          <Button
            label="Publish to DID"
            onPress={requestSignature}
            variant="primary"
            style={styles.fullButton}
          />
        )}

        {step === 'web_instructions' && (
          <>
            <Text style={styles.statusText}>
              你的账号使用 did:web，需要手动更新 DID 文档。
            </Text>
            {didWebUpdate?.didJson ? (
              <>
                <Text style={styles.hint}>
                  将以下内容保存为 .well-known/did.json 上传到你的服务器：
                </Text>
                <ScrollView style={styles.jsonOutput}>
                  {renderJsonWithHighlight(didWebUpdate.didJson)}
                </ScrollView>
              </>
            ) : (
              <>
                <Text style={styles.hint}>
                  无法获取当前 DID 文档。请将以下条目添加到你的 did.json 的 verificationMethod 数组中：
                </Text>
                <ScrollView style={styles.jsonOutput}>
                  {renderJsonWithHighlight(JSON.stringify(didWebUpdate?.newEntries ?? [], null, 2), true)}
                </ScrollView>
              </>
            )}
            <Button
              label="我已更新，检测"
              onPress={() => {
                setError(null);
                setStep('checking');
                const signal = { cancelled: false };
                checkKey(signal);
              }}
              variant="primary"
              style={styles.fullButton}
            />
          </>
        )}

        {step === 'restore_choice' && (
          <>
            <Text style={styles.statusText}>
              检测到此账号已声明密钥，但当前设备没有对应私钥
            </Text>
            <Button
              label="从备份恢复"
              onPress={() => setStep('restore_password')}
              variant="primary"
              style={styles.fullButton}
            />
            <Button
              label="重新声明密钥"
              onPress={() => setStep('publish')}
              variant="secondary"
              style={styles.fullButton}
            />
          </>
        )}

        {step === 'restore_password' && (
          <>
            <Text style={styles.statusText}>
              输入备份密码以恢复身份密钥
            </Text>
            <TextInput
              style={styles.input}
              value={backupPassword}
              onChangeText={setBackupPassword}
              placeholder="备份密码"
              placeholderTextColor={theme.colors.textSecondary}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              editable={!restoring}
            />
            <Button
              label={restoring ? '恢复中...' : '恢复'}
              onPress={() => handleRestore(backupPassword)}
              variant="primary"
              style={styles.fullButton}
              disabled={restoring}
            />
            <Button
              label="返回"
              onPress={() => {
                setError(null);
                setBackupPassword('');
                setStep('restore_choice');
              }}
              variant="secondary"
              style={styles.fullButton}
            />
          </>
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
            <Button
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
            <Button
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
            <Button
              label="Back to Login"
              onPress={() => app.logout().catch((err: unknown) => console.error('Logout failed:', err))}
              variant="secondary"
              style={styles.fullButton}
            />
          </>
        )}

        {step !== 'checking' && step !== 'check_error' && step !== 'declaring' && (
          <Button
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
  hint: {
    color: theme.colors.textSecondary,
    fontSize: theme.typography.caption,
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
  jsonOutput: {
    flex: 1,
    width: '100%',
    backgroundColor: theme.colors.inputBackground,
    borderRadius: theme.borderRadius.sm,
    borderWidth: 1,
    borderColor: theme.colors.border,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
  },
  jsonLineNormal: {
    color: theme.colors.textPrimary,
    fontSize: theme.typography.caption,
  },
  jsonLineHighlight: {
    color: theme.colors.success,
    fontSize: theme.typography.caption,
    fontWeight: '700',
  },
  jsonLineHighlightBg: {
    backgroundColor: 'rgba(52, 199, 89, 0.15)',
  },
});
