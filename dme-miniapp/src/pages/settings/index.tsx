/**
 * pages/settings/index.tsx - 设置页。
 *
 * 与 dme-client/src/ui/SettingsScreen.tsx **逐节对齐**：
 *
 *   顶栏： [返回] + 标题
 *   1. 语言            —— 语言按钮组
 *   2. 轮询批次大小     —— [输入] + [保存]（全宽）
 *   3. AppView Proxy   —— [输入] + [保存][重置]
 *   4. Server URL      —— [输入] + [保存][重置]
 *   5. Gateway URL     —— [输入] + [保存][重置]
 *   6. 声音            —— 开关（行内）
 *   7. 身份备份         —— [密码][确认密码] + [备份]
 *   7.5 从备份恢复      —— [密码] + [恢复]（轮换后 sibling-rotated 的唯一
 *       恢复路径；web 设置页已同步增加，不再是纯 Setup 流程专属）
 *   8. 关于            —— [关于] → /pages/about
 *
 * ⚠️ 与 web 的差异**已全部修正**（曾经的偏差）：
 *   1. 删除多余的「账号」区（web 无此区）
 *   2. 每个字段都是 [保存] + [重置] 一对（web 如此）；只有轮询批次是单 [保存]
 *   3. 删除「退出登录」按钮 —— web 的退出登录只在 ChatList 的头像菜单里
 *   4. 「从备份恢复」曾经删除（当时该功能属于 Setup/登录流程，设置页再放
 *      一个是重复入口）；但定时密钥轮换上线后，sibling-rotated（另一台设备
 *      已轮换）的唯一恢复路径是在已登录状态下从备份恢复，web 设置页已
 *      加入口，小程序对齐恢复（2026-10-14）。
 */

import { useCallback, useEffect, useState } from 'react';
import { View, Text, Input, Switch, Button, ScrollView } from '@tarojs/components';
import Taro from '@tarojs/taro';

import { useApp } from '../../state/AppContext';
import { useI18n } from '../../i18n/I18nContext';
import type { Language } from '../../i18n/translations';
import { LANGUAGES } from '../../i18n/translations';
import { useWebTitle } from '../../utils/web-title';
import { DEFAULT_APPVIEW_PROXY, DME_SERVER_URL, DEFAULT_DME_GATEWAY_URL } from '../../config';
import { BUILD_COMMIT_SHA, BUILD_DIRTY, BUILD_TIME } from '../../generated/build-info';
import './index.scss';

const ROTATION_OPTIONS: {
  ms: number;
  labelKey: 'settings.rotation24h' | 'settings.rotation7d' | 'settings.rotation30d';
}[] = [
  { ms: 24 * 60 * 60 * 1000, labelKey: 'settings.rotation24h' },
  { ms: 7 * 24 * 60 * 60 * 1000, labelKey: 'settings.rotation7d' },
  { ms: 30 * 24 * 60 * 60 * 1000, labelKey: 'settings.rotation30d' },
];

export default function SettingsPage(): React.JSX.Element {
  const { t, language, setLanguage } = useI18n();
  const {
    pollBatchSize,
    appViewProxy,
    serverUrl,
    gatewayUrl,
    soundEnabled,
    keyRotationIntervalMs,
    backupRequired,
    setPollBatchSize,
    setKeyRotationIntervalMs,
    setAppViewProxy,
    setServerUrl,
    setGatewayUrl,
    setSoundEnabled,
    backupIdentity,
    backupIdentityGuarded,
    backupIdentityForced,
    restoreIdentityFromBackup,
  } = useApp();

  useWebTitle(t('settings.title'));

  // 本地草稿（与 web 的 draft / xxxDraft 一一对应）
  const [batchDraft, setBatchDraft] = useState(String(pollBatchSize));
  const [proxyDraft, setProxyDraft] = useState(appViewProxy);
  const [serverDraft, setServerDraft] = useState(serverUrl);
  const [gatewayDraft, setGatewayDraft] = useState(gatewayUrl);

  // 「已保存」回显（对应 web 的 saved / proxySaved / serverSaved / gatewaySaved）
  const [saved, setSaved] = useState(false);
  const [proxySaved, setProxySaved] = useState(false);
  const [serverSaved, setServerSaved] = useState(false);
  const [gatewaySaved, setGatewaySaved] = useState(false);

  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // BACKUP_CLAIM_STALE 时展示强制备份入口；两段确认防误触（不可逆覆盖云端备份）
  const [claimStale, setClaimStale] = useState(false);
  const [forceConfirm, setForceConfirm] = useState(false);

  // 从备份恢复（对应 web SettingsScreen 的 restorePwd / restoreStatus / restoreError）
  const [restorePassword, setRestorePassword] = useState('');
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);

  useEffect(() => {
    setBatchDraft(String(pollBatchSize));
  }, [pollBatchSize]);

  useEffect(() => {
    setProxyDraft(appViewProxy);
    setServerDraft(serverUrl);
    setGatewayDraft(gatewayUrl);
  }, [appViewProxy, serverUrl, gatewayUrl]);

  // ---- 保存 / 重置（与 web 的 handleSaveXxx / handleResetXxx 一一对应） ----
  const flash = (setter: (v: boolean) => void): void => {
    setter(true);
    setTimeout(() => setter(false), 2000);
  };

  const saveBatch = useCallback(async (): Promise<void> => {
    const n = parseInt(batchDraft, 10);
    if (!Number.isFinite(n) || n < 1 || n > 20) return;
    await setPollBatchSize(n);
    flash(setSaved);
  }, [batchDraft, setPollBatchSize]);

  const saveProxy = useCallback(async (): Promise<void> => {
    await setAppViewProxy(proxyDraft);
    flash(setProxySaved);
  }, [proxyDraft, setAppViewProxy]);

  const resetProxy = useCallback(async (): Promise<void> => {
    setProxyDraft(DEFAULT_APPVIEW_PROXY);
    await setAppViewProxy(DEFAULT_APPVIEW_PROXY);
    flash(setProxySaved);
  }, [setAppViewProxy]);

  const saveServer = useCallback(async (): Promise<void> => {
    await setServerUrl(serverDraft);
    flash(setServerSaved);
  }, [serverDraft, setServerUrl]);

  const resetServer = useCallback(async (): Promise<void> => {
    setServerDraft(DME_SERVER_URL);
    await setServerUrl(DME_SERVER_URL);
    flash(setServerSaved);
  }, [setServerUrl]);

  const saveGateway = useCallback(async (): Promise<void> => {
    await setGatewayUrl(gatewayDraft);
    flash(setGatewaySaved);
  }, [gatewayDraft, setGatewayUrl]);

  const resetGateway = useCallback(async (): Promise<void> => {
    setGatewayDraft(DEFAULT_DME_GATEWAY_URL);
    await setGatewayUrl(DEFAULT_DME_GATEWAY_URL);
    flash(setGatewaySaved);
  }, [setGatewayUrl]);

  // ---- 备份（对应 web handleBackup） -------------------------------------
  const handleBackup = useCallback(async (): Promise<void> => {
    setError(null);
    if (!password) {
      setError(t('settings.enterPassword'));
      return;
    }
    if (password !== confirmPassword) {
      setError(t('settings.passwordMismatch'));
      return;
    }
    setBusy(true);
    try {
      // ⚠️ 先展示原生 loading 再进入 backupIdentity：
      //    备份加密（PBKDF2 10 万次迭代，真机 ES5 低端机 1.5~5s+）是纯 JS
      //    同步大块，且其前的 storage 读取全是一次 resolve 的微任务级联 ——
      //    直接 await 的话 setBusy(true) 的「备份中」渲染永远排不上号，
      //    点按钮后整个页面冻结数秒（真机感知为卡死，2026-09-29）。
      //    showLoading 是原生组件，JS 冻结期间依然显示；mask 拦截连点。
      await Taro.showLoading({ title: t('settings.backingUp'), mask: true });
      await backupIdentityGuarded(password);
      setPassword('');
      setConfirmPassword('');
      Taro.hideLoading();
      await Taro.showToast({ title: t('settings.backedUp'), icon: 'success' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      setError(
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
                  : `${t('settings.backupFailed')}: ${msg}`,
      );
      if (msg === 'BACKUP_CLAIM_STALE') setClaimStale(true);
      console.error('备份失败:', err);
    } finally {
      Taro.hideLoading();
      setBusy(false);
    }
  }, [password, confirmPassword, backupIdentityGuarded, t]);

  // ---- 强制备份（接管高水位，对应 web handleForceBackup） ----------------
  // 仅当产生高水位的设备已丢失且密钥材料未备份时使用。两段确认：第一段
  // 点只展示警告，第二次点才执行。
  const handleForceBackup = useCallback(async (): Promise<void> => {
    if (!forceConfirm) {
      setForceConfirm(true);
      return;
    }
    setForceConfirm(false);
    setError(null);
    if (!password || password !== confirmPassword) {
      setError(t('settings.enterPassword'));
      return;
    }
    setBusy(true);
    try {
      await Taro.showLoading({ title: t('settings.backingUp'), mask: true });
      await backupIdentityForced(password);
      setClaimStale(false);
      setPassword('');
      setConfirmPassword('');
      Taro.hideLoading();
      await Taro.showToast({ title: t('settings.backedUp'), icon: 'success' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      setError(`${t('settings.backupFailed')}: ${msg}`);
      console.error('强制备份失败:', err);
    } finally {
      Taro.hideLoading();
      setBusy(false);
    }
  }, [forceConfirm, password, confirmPassword, backupIdentityForced, t]);

  // ---- 从备份恢复（对应 web handleRestore；showLoading 理由同 handleBackup） --
  const handleRestore = useCallback(async (): Promise<void> => {
    setRestoreError(null);
    if (!restorePassword) {
      setRestoreError(t('settings.enterPassword'));
      return;
    }
    setRestoreBusy(true);
    try {
      await Taro.showLoading({ title: t('settings.restoring'), mask: true });
      const ok = await restoreIdentityFromBackup(restorePassword);
      Taro.hideLoading();
      if (ok) {
        setRestorePassword('');
        await Taro.showToast({ title: t('settings.restoreSucceeded'), icon: 'success' });
      } else {
        setRestoreError(t('setup.noBackup'));
      }
    } catch (err) {
      Taro.hideLoading();
      const msg = err instanceof Error ? err.message : '';
      setRestoreError(
        msg === 'RESTORE_BACKUP_STALE'
          ? t('settings.restoreBackupStale')
          : `${t('setup.restoreFailed')}: ${msg}`,
      );
      console.error('恢复失败:', err);
    } finally {
      setRestoreBusy(false);
    }
  }, [restorePassword, restoreIdentityFromBackup, t]);

  return (
    <View className="settings">
      {/* 顶栏：[返回] + 标题（对应 web 的 styles.header） */}
      <View className="settings__header">
        <Button
          className="settings__backBtn"
          onClick={async () => {
            await Taro.navigateBack();
          }}
        >
          {t('common.back')}
        </Button>
        <Text className="settings__headerTitle">{t('settings.title')}</Text>
      </View>

      <ScrollView className="settings__content" scrollY>
        {error ? <Text className="settings__error">{error}</Text> : null}

        {/* 1. 语言 */}
        <Text className="settings__title">{t('settings.language')}</Text>
        <View className="settings__rowButtons">
          {LANGUAGES.map((lang) => (
            <Button
              key={lang.code}
              className={`settings__halfBtn ${language === lang.code ? 'settings__halfBtn--on' : ''}`}
              onClick={() => void setLanguage(lang.code as Language)}
            >
              {lang.label}
            </Button>
          ))}
        </View>

        {/* 2. 轮询批次大小（全宽单 [保存]） */}
        <Text className="settings__label">{t('settings.pollBatchSize')}</Text>
        <Text className="settings__hint">{t('settings.pollBatchSizeHint')}</Text>
        <Input
          className="settings__input"
          type="number"
          value={batchDraft}
          placeholder="3"
          onInput={(e) => setBatchDraft(e.detail.value)}
        />
        <Button className="settings__fullButton" onClick={() => void saveBatch()}>
          {saved ? t('common.saved') : t('common.save')}
        </Button>

        {/* 3. AppView Proxy */}
        <Text className="settings__title">{t('settings.appViewProxy')}</Text>
        <Text className="settings__hint">{t('settings.appViewProxyHint')}</Text>
        <Input
          className="settings__input"
          value={proxyDraft}
          placeholder={DEFAULT_APPVIEW_PROXY}
          onInput={(e) => setProxyDraft(e.detail.value)}
        />
        <View className="settings__rowButtons">
          <Button className="settings__halfBtn" onClick={() => void saveProxy()}>
            {proxySaved ? t('common.saved') : t('common.save')}
          </Button>
          <Button
            className="settings__halfBtn settings__halfBtn--ghost"
            onClick={() => void resetProxy()}
          >
            {t('common.reset')}
          </Button>
        </View>

        {/* 4. Server URL */}
        <Text className="settings__title">{t('settings.server')}</Text>
        <Text className="settings__hint">{t('settings.serverHint')}</Text>
        <Input
          className="settings__input"
          value={serverDraft}
          placeholder={DME_SERVER_URL}
          onInput={(e) => setServerDraft(e.detail.value)}
        />
        <View className="settings__rowButtons">
          <Button className="settings__halfBtn" onClick={() => void saveServer()}>
            {serverSaved ? t('common.saved') : t('common.save')}
          </Button>
          <Button
            className="settings__halfBtn settings__halfBtn--ghost"
            onClick={() => void resetServer()}
          >
            {t('common.reset')}
          </Button>
        </View>

        {/* 5. Gateway URL */}
        <Text className="settings__title">{t('settings.gateway')}</Text>
        <Text className="settings__hint">{t('settings.gatewayHint')}</Text>
        <Input
          className="settings__input"
          value={gatewayDraft}
          placeholder={t('settings.gatewayPlaceholder')}
          onInput={(e) => setGatewayDraft(e.detail.value)}
        />
        <View className="settings__rowButtons">
          <Button className="settings__halfBtn" onClick={() => void saveGateway()}>
            {gatewaySaved ? t('common.saved') : t('common.save')}
          </Button>
          <Button
            className="settings__halfBtn settings__halfBtn--ghost"
            onClick={() => void resetGateway()}
          >
            {t('common.reset')}
          </Button>
        </View>

        {/* 6. 声音（行内开关） */}
        <Text className="settings__title">{t('settings.sound')}</Text>
        <View className="settings__switchRow">
          <Text className="settings__label">{t('settings.notifications')}</Text>
          <Switch
            checked={soundEnabled}
            onChange={(e) => void setSoundEnabled(e.detail.value)}
          />
        </View>

        {/* 6.5 密钥轮换周期（三档，无关闭项） */}
        <Text className="settings__title">{t('settings.rotationInterval')}</Text>
        <Text className="settings__hint">{t('settings.rotationIntervalHint')}</Text>
        <View className="settings__rowButtons">
          {ROTATION_OPTIONS.map((opt) => (
            <Button
              key={opt.ms}
              className={`settings__halfBtn ${keyRotationIntervalMs === opt.ms ? 'settings__halfBtn--on' : ''}`}
              onClick={() => void setKeyRotationIntervalMs(opt.ms)}
            >
              {t(opt.labelKey)}
            </Button>
          ))}
        </View>

        {backupRequired ? (
          <View className="settings__banner">
            <Text className="settings__bannerText">{t('settings.backupRequiredBanner')}</Text>
          </View>
        ) : null}

        {/* 7. 身份备份 */}
        <Text className="settings__title">{t('settings.identityBackup')}</Text>
        <Text className="settings__hint">{t('settings.backupHint')}</Text>
        <Input
          className="settings__input"
          password
          value={password}
          placeholder={t('settings.passwordPlaceholder')}
          onInput={(e) => setPassword(e.detail.value)}
        />
        <Input
          className="settings__input"
          password
          value={confirmPassword}
          placeholder={t('settings.confirmPasswordPlaceholder')}
          onInput={(e) => setConfirmPassword(e.detail.value)}
        />
        <Button className="settings__fullButton" disabled={busy} onClick={() => void handleBackup()}>
          {busy ? t('settings.backingUp') : t('settings.backup')}
        </Button>

        {/* 7.4 强制备份（接管高水位）：高水位设备丢失且未备份时的自救路径 */}
        {claimStale ? (
          <View className="settings__forceBackup">
            <Text className="settings__hint">
              {forceConfirm ? t('settings.forceBackupWarning') : t('settings.forceBackupHint')}
            </Text>
            <Button
              className="settings__fullButton settings__fullButton--ghost"
              disabled={busy}
              onClick={() => void handleForceBackup()}
            >
              {t(forceConfirm ? 'settings.forceBackupConfirm' : 'settings.forceBackup')}
            </Button>
          </View>
        ) : null}

        {/* 7.5 从备份恢复（轮换后 sibling-rotated 的唯一恢复路径） */}
        <Text className="settings__title">{t('settings.restoreTitle')}</Text>
        <Text className="settings__hint">{t('settings.restoreHint')}</Text>
        <Input
          className="settings__input"
          password
          value={restorePassword}
          placeholder={t('settings.passwordPlaceholder')}
          onInput={(e) => setRestorePassword(e.detail.value)}
        />
        <Button
          className="settings__fullButton settings__fullButton--ghost"
          disabled={restoreBusy}
          onClick={() => void handleRestore()}
        >
          {restoreBusy ? t('settings.restoring') : t('settings.restore')}
        </Button>
        {restoreError ? <Text className="settings__error">{restoreError}</Text> : null}

        {/* 8. 关于（对应 web 的 styles.fullButton + navigation.navigate('About')） */}
        <Button
          className="settings__fullButton settings__fullButton--ghost"
          onClick={async () => {
            await Taro.navigateTo({ url: '/pages/about/index' });
          }}
        >
          {t('settings.about')}
        </Button>

        {/* 9. 构建信息（与 web 设置页底部对齐）：多端测试时对齐各设备
            跑的是哪个构建，防止体验版/本地缓存版本误导。selectable 方便
            长按复制 sha。 */}
        <Text className="settings__buildInfo" userSelect>
          {`build ${BUILD_COMMIT_SHA}${BUILD_DIRTY ? '-dirty' : ''} · ${BUILD_TIME}`}
        </Text>
      </ScrollView>
    </View>
  );
}
