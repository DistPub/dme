import React, { useState } from 'react';
import { StyleSheet, Text, View, TextInput, ScrollView, Switch } from 'react-native';
import { Canvas, Fill } from '@shopify/react-native-skia';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';

import { theme } from './theme';
import { Button } from './Button';
import { useApp } from '../state/AppContext';
import { DEFAULT_APPVIEW_PROXY } from '../config';
import type { RootStackParamList } from '../types/navigation';

interface Props {
  navigation: NativeStackNavigationProp<RootStackParamList, 'Settings'>;
}

export function SettingsScreen({ navigation }: Props): React.JSX.Element {
  const app = useApp();
  const [draft, setDraft] = useState(String(app.pollBatchSize));
  const [saved, setSaved] = useState(false);

  const [proxyDraft, setProxyDraft] = useState(app.appViewProxy);
  const [proxySaved, setProxySaved] = useState(false);

  const [backupPwd, setBackupPwd] = useState('');
  const [backupPwdConfirm, setBackupPwdConfirm] = useState('');
  const [backupStatus, setBackupStatus] = useState<'idle' | 'backing_up' | 'done' | 'error'>('idle');
  const [backupError, setBackupError] = useState<string | null>(null);

  const handleSave = async (): Promise<void> => {
    const n = parseInt(draft, 10);
    if (!Number.isFinite(n) || n < 1 || n > 20) return;
    await app.setPollBatchSize(n);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const handleSaveProxy = async (): Promise<void> => {
    await app.setAppViewProxy(proxyDraft);
    setProxySaved(true);
    setTimeout(() => setProxySaved(false), 2000);
  };

  const handleResetProxy = async (): Promise<void> => {
    setProxyDraft(DEFAULT_APPVIEW_PROXY);
    await app.setAppViewProxy(DEFAULT_APPVIEW_PROXY);
    setProxySaved(true);
    setTimeout(() => setProxySaved(false), 2000);
  };

  const handleBackup = async (): Promise<void> => {
    setBackupError(null);
    if (!backupPwd) {
      setBackupError('请输入密码');
      return;
    }
    if (backupPwd !== backupPwdConfirm) {
      setBackupError('两次密码不一致');
      return;
    }
    setBackupStatus('backing_up');
    try {
      await app.backupIdentity(backupPwd);
      setBackupStatus('done');
      setBackupPwd('');
      setBackupPwdConfirm('');
      setTimeout(() => setBackupStatus('idle'), 2000);
    } catch (err) {
      setBackupError(err instanceof Error ? err.message : '备份失败');
      setBackupStatus('error');
      setTimeout(() => setBackupStatus('idle'), 2000);
    }
  };

  return (
    <View style={styles.container}>
      <Canvas style={StyleSheet.absoluteFill}>
        <Fill color={theme.colors.background} />
      </Canvas>

      <ScrollView style={styles.content} contentContainerStyle={styles.contentInner} keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>Settings</Text>

        <Text style={styles.label}>Poll Batch Size</Text>
        <Text style={styles.hint}>
          How many future messages to check per poll cycle (1-20).
        </Text>
        <TextInput
          style={styles.input}
          value={draft}
          onChangeText={setDraft}
          keyboardType="numeric"
          placeholder="3"
          placeholderTextColor={theme.colors.textSecondary}
        />

        <Button
          label={saved ? 'Saved!' : 'Save'}
          onPress={handleSave}
          variant="primary"
          style={styles.fullButton}
        />

        <Text style={styles.title}>AppView Proxy</Text>
        <Text style={styles.hint}>
          atproto-proxy header sent to PDS when writing records.
        </Text>
        <TextInput
          style={styles.input}
          value={proxyDraft}
          onChangeText={setProxyDraft}
          placeholder={DEFAULT_APPVIEW_PROXY}
          placeholderTextColor={theme.colors.textSecondary}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <View style={styles.rowButtons}>
          <Button
            label={proxySaved ? 'Saved!' : 'Save'}
            onPress={handleSaveProxy}
            variant="primary"
            style={styles.halfButton}
          />
          <Button
            label="Reset"
            onPress={handleResetProxy}
            variant="secondary"
            style={styles.halfButton}
          />
        </View>

        <Text style={styles.title}>Sound</Text>
        <View style={styles.switchRow}>
          <Text style={styles.label}>Message notifications</Text>
          <Switch
            value={app.soundEnabled}
            onValueChange={(v) => { void app.setSoundEnabled(v); }}
            trackColor={{ false: theme.colors.border, true: theme.colors.accent }}
            thumbColor="#fff"
          />
        </View>

        <Text style={styles.title}>Identity Backup</Text>
        <Text style={styles.hint}>
          Backup your identity keys to PDS. Restore on other devices with the same password.
        </Text>
        <TextInput
          style={styles.input}
          value={backupPwd}
          onChangeText={setBackupPwd}
          placeholder="Password"
          placeholderTextColor={theme.colors.textSecondary}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          editable={backupStatus !== 'backing_up'}
        />
        <TextInput
          style={styles.input}
          value={backupPwdConfirm}
          onChangeText={setBackupPwdConfirm}
          placeholder="Confirm Password"
          placeholderTextColor={theme.colors.textSecondary}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          editable={backupStatus !== 'backing_up'}
        />
        <Button
          label={
            backupStatus === 'backing_up'
              ? 'Backing up...'
              : backupStatus === 'done'
                ? 'Backed up!'
                : 'Backup'
          }
          onPress={handleBackup}
          variant="primary"
          style={styles.fullButton}
          disabled={backupStatus === 'backing_up'}
        />
        {backupError ? (
          <Text style={styles.error}>{backupError}</Text>
        ) : null}

        <Button
          label="Back"
          onPress={() => navigation.goBack()}
          variant="secondary"
          style={styles.fullButton}
        />
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
    paddingHorizontal: theme.spacing.lg,
    paddingTop: theme.spacing.xl,
    paddingBottom: theme.spacing.xl,
    gap: theme.spacing.md,
  },
  title: {
    color: theme.colors.textPrimary,
    fontSize: theme.typography.heading,
    fontWeight: '700',
    marginBottom: theme.spacing.sm,
  },
  label: {
    color: theme.colors.textPrimary,
    fontSize: theme.typography.body,
    fontWeight: '600',
  },
  hint: {
    color: theme.colors.textSecondary,
    fontSize: theme.typography.caption,
  },
  input: {
    width: '100%',
    height: 48,
    flexShrink: 0,
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
    flexShrink: 0,
  },
  rowButtons: {
    flexDirection: 'row',
    gap: theme.spacing.md,
    flexShrink: 0,
  },
  halfButton: {
    flex: 1,
    height: 48,
  },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  error: {
    color: theme.colors.error,
    fontSize: theme.typography.caption,
    textAlign: 'center',
  },
});
