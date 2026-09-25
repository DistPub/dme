import React, { useState } from 'react';
import { StyleSheet, Text, View, TextInput, ScrollView, Switch } from 'react-native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';

import { theme } from './theme';
import { Button } from './Button';
import { ScreenBackground } from './ScreenBackground';
import { useApp } from '../state/AppContext';
import { DEFAULT_APPVIEW_PROXY, DME_SERVER_URL, DEFAULT_DME_GATEWAY_URL } from '../config';
import type { RootStackParamList } from '../types/navigation';
import { useI18n } from '../i18n/I18nContext';
import { LANGUAGES } from '../i18n/translations';

interface Props {
  navigation: NativeStackNavigationProp<RootStackParamList, 'Settings'>;
}

export function SettingsScreen({ navigation }: Props): React.JSX.Element {
  const app = useApp();
  const { language, setLanguage, t } = useI18n();
  const [draft, setDraft] = useState(String(app.pollBatchSize));
  const [saved, setSaved] = useState(false);

  const [proxyDraft, setProxyDraft] = useState(app.appViewProxy);
  const [proxySaved, setProxySaved] = useState(false);

  const [serverDraft, setServerDraft] = useState(app.serverUrl);
  const [serverSaved, setServerSaved] = useState(false);

  const [gatewayDraft, setGatewayDraft] = useState(app.gatewayUrl);
  const [gatewaySaved, setGatewaySaved] = useState(false);

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

  const handleSaveServer = async (): Promise<void> => {
    await app.setServerUrl(serverDraft);
    setServerSaved(true);
    setTimeout(() => setServerSaved(false), 2000);
  };

  const handleResetServer = async (): Promise<void> => {
    setServerDraft(DME_SERVER_URL);
    await app.setServerUrl(DME_SERVER_URL);
    setServerSaved(true);
    setTimeout(() => setServerSaved(false), 2000);
  };

  const handleSaveGateway = async (): Promise<void> => {
    await app.setGatewayUrl(gatewayDraft);
    setGatewaySaved(true);
    setTimeout(() => setGatewaySaved(false), 2000);
  };

  const handleResetGateway = async (): Promise<void> => {
    setGatewayDraft(DEFAULT_DME_GATEWAY_URL);
    await app.setGatewayUrl(DEFAULT_DME_GATEWAY_URL);
    setGatewaySaved(true);
    setTimeout(() => setGatewaySaved(false), 2000);
  };

  const handleBackup = async (): Promise<void> => {
    setBackupError(null);
    if (!backupPwd) {
      setBackupError(t('settings.enterPassword'));
      return;
    }
    if (backupPwd !== backupPwdConfirm) {
      setBackupError(t('settings.passwordMismatch'));
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
      setBackupError(err instanceof Error ? err.message : t('settings.backupFailed'));
      setBackupStatus('error');
      setTimeout(() => setBackupStatus('idle'), 2000);
    }
  };

  return (
    <View style={styles.container}>
      <ScreenBackground />

      <ScrollView style={styles.content} contentContainerStyle={styles.contentInner} keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>{t('settings.title')}</Text>

        <Text style={styles.title}>{t('settings.language')}</Text>
        <View style={styles.rowButtons}>
          {LANGUAGES.map((lang) => (
            <Button
              key={lang.code}
              label={lang.label}
              onPress={() => { void setLanguage(lang.code); }}
              variant={language === lang.code ? 'primary' : 'secondary'}
              style={styles.halfButton}
            />
          ))}
        </View>

        <Text style={styles.label}>{t('settings.pollBatchSize')}</Text>
        <Text style={styles.hint}>{t('settings.pollBatchSizeHint')}</Text>
        <TextInput
          style={styles.input}
          value={draft}
          onChangeText={setDraft}
          keyboardType="numeric"
          placeholder="3"
          placeholderTextColor={theme.colors.textSecondary}
        />

        <Button
          label={saved ? t('common.saved') : t('common.save')}
          onPress={handleSave}
          variant="primary"
          style={styles.fullButton}
        />

        <Text style={styles.title}>{t('settings.appViewProxy')}</Text>
        <Text style={styles.hint}>{t('settings.appViewProxyHint')}</Text>
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
            label={proxySaved ? t('common.saved') : t('common.save')}
            onPress={handleSaveProxy}
            variant="primary"
            style={styles.halfButton}
          />
          <Button
            label={t('common.reset')}
            onPress={handleResetProxy}
            variant="secondary"
            style={styles.halfButton}
          />
        </View>

        <Text style={styles.title}>{t('settings.server')}</Text>
        <Text style={styles.hint}>{t('settings.serverHint')}</Text>
        <TextInput
          style={styles.input}
          value={serverDraft}
          onChangeText={setServerDraft}
          placeholder={DME_SERVER_URL}
          placeholderTextColor={theme.colors.textSecondary}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <View style={styles.rowButtons}>
          <Button
            label={serverSaved ? t('common.saved') : t('common.save')}
            onPress={handleSaveServer}
            variant="primary"
            style={styles.halfButton}
          />
          <Button
            label={t('common.reset')}
            onPress={handleResetServer}
            variant="secondary"
            style={styles.halfButton}
          />
        </View>

        <Text style={styles.title}>{t('settings.gateway')}</Text>
        <Text style={styles.hint}>{t('settings.gatewayHint')}</Text>
        <TextInput
          style={styles.input}
          value={gatewayDraft}
          onChangeText={setGatewayDraft}
          placeholder={t('settings.gatewayPlaceholder')}
          placeholderTextColor={theme.colors.textSecondary}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <View style={styles.rowButtons}>
          <Button
            label={gatewaySaved ? t('common.saved') : t('common.save')}
            onPress={handleSaveGateway}
            variant="primary"
            style={styles.halfButton}
          />
          <Button
            label={t('common.reset')}
            onPress={handleResetGateway}
            variant="secondary"
            style={styles.halfButton}
          />
        </View>

        <Text style={styles.title}>{t('settings.sound')}</Text>
        <View style={styles.switchRow}>
          <Text style={styles.label}>{t('settings.notifications')}</Text>
          <Switch
            value={app.soundEnabled}
            onValueChange={(v) => { void app.setSoundEnabled(v); }}
            trackColor={{ false: theme.colors.border, true: theme.colors.accent }}
            thumbColor="#fff"
          />
        </View>

        <Text style={styles.title}>{t('settings.identityBackup')}</Text>
        <Text style={styles.hint}>{t('settings.backupHint')}</Text>
        <TextInput
          style={styles.input}
          value={backupPwd}
          onChangeText={setBackupPwd}
          placeholder={t('settings.passwordPlaceholder')}
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
          placeholder={t('settings.confirmPasswordPlaceholder')}
          placeholderTextColor={theme.colors.textSecondary}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          editable={backupStatus !== 'backing_up'}
        />
        <Button
          label={
            backupStatus === 'backing_up'
              ? t('settings.backingUp')
              : backupStatus === 'done'
                ? t('settings.backedUp')
                : t('settings.backup')
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
          label={t('common.back')}
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
