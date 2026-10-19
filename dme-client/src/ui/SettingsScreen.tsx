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
import { BUILD_COMMIT_SHA, BUILD_DIRTY, BUILD_TIME } from '../generated/build-info';

const ROTATION_OPTIONS: { ms: number; labelKey: 'settings.rotation24h' | 'settings.rotation7d' | 'settings.rotation30d' }[] = [
  { ms: 24 * 60 * 60 * 1000, labelKey: 'settings.rotation24h' },
  { ms: 7 * 24 * 60 * 60 * 1000, labelKey: 'settings.rotation7d' },
  { ms: 30 * 24 * 60 * 60 * 1000, labelKey: 'settings.rotation30d' },
];

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
  // BACKUP_CLAIM_STALE 时展示强制备份入口；两段确认防误触（不可逆覆盖云端备份）
  const [claimStale, setClaimStale] = useState(false);
  const [forceConfirm, setForceConfirm] = useState(false);

  const [restorePwd, setRestorePwd] = useState('');
  const [restoreStatus, setRestoreStatus] = useState<'idle' | 'restoring' | 'done' | 'error'>('idle');
  const [restoreError, setRestoreError] = useState<string | null>(null);

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

  const handleRotation = async (ms: number): Promise<void> => {
    await app.setKeyRotationIntervalMs(ms);
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
      await app.backupIdentityGuarded(backupPwd);
      setBackupStatus('done');
      setBackupPwd('');
      setBackupPwdConfirm('');
      setTimeout(() => setBackupStatus('idle'), 2000);
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      setBackupError(
        msg === 'BACKUP_BLOCKED_STALE'
          ? t('settings.backupStaleBlocked')
          : msg === 'BACKUP_CLAIM_STALE'
            ? t('settings.backupClaimStale')
            : msg === 'BACKUP_CLAIM_BUSY'
              ? t('settings.backupClaimBusy')
              : msg === 'BACKUP_COVER_DIFF'
                ? t('settings.backupCoverDiff')
                : msg === 'BACKUP_COVER_UNVERIFIED'
                  ? t('settings.backupCoverUnverified')
                  : msg || t('settings.backupFailed'),
      );
      if (msg === 'BACKUP_CLAIM_STALE') setClaimStale(true);
      setBackupStatus('error');
      setTimeout(() => setBackupStatus('idle'), 2000);
    }
  };

  // 强制备份（接管高水位）：仅当产生高水位的设备已丢失且密钥材料未备份时
  // 使用。两段确认：第一次点只展示警告，第二次点才执行。
  const handleForceBackup = async (): Promise<void> => {
    if (!forceConfirm) {
      setForceConfirm(true);
      return;
    }
    setForceConfirm(false);
    setBackupError(null);
    if (!backupPwd || backupPwd !== backupPwdConfirm) {
      setBackupError(t('settings.enterPassword'));
      return;
    }
    setBackupStatus('backing_up');
    try {
      await app.backupIdentityForced(backupPwd);
      setClaimStale(false);
      setBackupStatus('done');
      setBackupPwd('');
      setBackupPwdConfirm('');
      setTimeout(() => setBackupStatus('idle'), 2000);
    } catch (err) {
      setBackupError(
        err instanceof Error && err.message ? err.message : t('settings.backupFailed'),
      );
      setBackupStatus('error');
      setTimeout(() => setBackupStatus('idle'), 2000);
    }
  };

  // 从备份恢复（key-rotation-plan.md 1.6）：sibling-rotated / 需要回滚时的
  // 唯一恢复路径。用云端最新备份覆盖本机身份与会话状态。
  const handleRestore = async (): Promise<void> => {
    setRestoreError(null);
    if (!restorePwd) {
      setRestoreError(t('settings.enterPassword'));
      return;
    }
    setRestoreStatus('restoring');
    try {
      const ok = await app.restoreIdentityFromBackup(restorePwd);
      if (ok) {
        setRestoreStatus('done');
        setRestorePwd('');
        setTimeout(() => setRestoreStatus('idle'), 2000);
      } else {
        setRestoreError(t('setup.noBackup'));
        setRestoreStatus('error');
        setTimeout(() => setRestoreStatus('idle'), 2000);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      setRestoreError(
        msg === 'RESTORE_BACKUP_STALE'
          ? t('settings.restoreBackupStale')
          : msg || t('setup.restoreFailed'),
      );
      setRestoreStatus('error');
      setTimeout(() => setRestoreStatus('idle'), 2000);
    }
  };

  return (
    <View style={styles.container}>
      <ScreenBackground />

      <View style={styles.header}>
        <Button
          label={t('common.back')}
          onPress={() => navigation.goBack()}
          variant="secondary"
          style={styles.backButton}
        />
        <Text style={styles.headerTitle}>{t('settings.title')}</Text>
      </View>

      <ScrollView style={styles.content} contentContainerStyle={styles.contentInner} keyboardShouldPersistTaps="handled">
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

        <Text style={styles.title}>{t('settings.rotationInterval')}</Text>
        <Text style={styles.hint}>{t('settings.rotationIntervalHint')}</Text>
        <View style={styles.rowButtons}>
          {ROTATION_OPTIONS.map((opt) => (
            <Button
              key={opt.ms}
              label={t(opt.labelKey)}
              onPress={() => { void handleRotation(opt.ms); }}
              variant={app.keyRotationIntervalMs === opt.ms ? 'primary' : 'secondary'}
              style={styles.thirdButton}
            />
          ))}
        </View>

        {app.backupRequired ? (
          <View style={styles.banner}>
            <Text style={styles.bannerText}>{t('settings.backupRequiredBanner')}</Text>
          </View>
        ) : null}

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

        {claimStale ? (
          <View style={styles.forceBackupWrap}>
            <Text style={styles.hint}>
              {forceConfirm ? t('settings.forceBackupWarning') : t('settings.forceBackupHint')}
            </Text>
            <Button
              label={t(forceConfirm ? 'settings.forceBackupConfirm' : 'settings.forceBackup')}
              onPress={handleForceBackup}
              variant="secondary"
              style={styles.fullButton}
              disabled={backupStatus === 'backing_up'}
            />
          </View>
        ) : null}

        <Text style={[styles.title, styles.restoreTitle]}>{t('settings.restoreTitle')}</Text>
        <Text style={styles.hint}>{t('settings.restoreHint')}</Text>
        <TextInput
          style={styles.input}
          value={restorePwd}
          onChangeText={setRestorePwd}
          placeholder={t('settings.passwordPlaceholder')}
          placeholderTextColor={theme.colors.textSecondary}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          editable={restoreStatus !== 'restoring'}
        />
        <Button
          label={
            restoreStatus === 'restoring'
              ? t('settings.restoring')
              : restoreStatus === 'done'
                ? t('settings.restoreSucceeded')
                : t('settings.restore')
          }
          onPress={handleRestore}
          variant="secondary"
          style={styles.fullButton}
          disabled={restoreStatus === 'restoring'}
        />
        {restoreError ? (
          <Text style={styles.error}>{restoreError}</Text>
        ) : null}

        <Button
          label={t('settings.about')}
          onPress={() => navigation.navigate('About')}
          variant="secondary"
          style={styles.fullButton}
        />

        {/* 构建信息：多端测试时对齐各设备跑的是哪个构建（防 web 缓存旧 bundle 误导） */}
        <Text style={styles.buildInfo} selectable>
          {`build ${BUILD_COMMIT_SHA}${BUILD_DIRTY ? '-dirty' : ''} · ${BUILD_TIME}`}
        </Text>
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
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: theme.spacing.lg,
    paddingTop: theme.spacing.lg,
    paddingBottom: theme.spacing.sm,
    gap: theme.spacing.md,
  },
  backButton: {
    width: 96,
    height: 40,
  },
  headerTitle: {
    flex: 1,
    color: theme.colors.textPrimary,
    fontSize: theme.typography.heading,
    fontWeight: '700',
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
  buildInfo: {
    color: theme.colors.textSecondary,
    fontSize: theme.typography.caption,
    textAlign: 'center',
    marginTop: theme.spacing.xl,
  },
  restoreTitle: {
    marginTop: theme.spacing.lg,
  },
  forceBackupWrap: {
    marginTop: theme.spacing.md,
    gap: theme.spacing.md,
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
  thirdButton: {
    flex: 1,
    height: 48,
  },
  banner: {
    borderWidth: 1,
    borderColor: theme.colors.error,
    borderRadius: 8,
    padding: theme.spacing.md,
  },
  bannerText: {
    color: theme.colors.textPrimary,
    fontSize: 13,
    lineHeight: 18,
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
