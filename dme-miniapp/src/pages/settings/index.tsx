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
 *   8. 关于            —— [关于] → /pages/about
 *
 * ⚠️ 与 web 的差异**已全部修正**（曾经的偏差）：
 *   1. 删除多余的「账号」区（web 无此区）
 *   2. 每个字段都是 [保存] + [重置] 一对（web 如此）；只有轮询批次是单 [保存]
 *   3. 删除「退出登录」按钮 —— web 的退出登录只在 ChatList 的头像菜单里
 *   4. 删除「从备份恢复」—— 该功能属于 Setup/登录流程，不属于设置页；
 *      小程序在登录页已有「从备份恢复」入口，设置页再放一个是重复入口。
 *      （dme-client 的 SettingsScreen 里也没有这一段。）
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
import './index.scss';

export default function SettingsPage(): React.JSX.Element {
  const { t, language, setLanguage } = useI18n();
  const {
    pollBatchSize,
    appViewProxy,
    serverUrl,
    gatewayUrl,
    soundEnabled,
    setPollBatchSize,
    setAppViewProxy,
    setServerUrl,
    setGatewayUrl,
    setSoundEnabled,
    backupIdentity,
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
      await backupIdentity(password);
      setPassword('');
      setConfirmPassword('');
      await Taro.showToast({ title: t('settings.backedUp'), icon: 'success' });
    } catch (err) {
      setError(`${t('settings.backupFailed')}: ${err instanceof Error ? err.message : ''}`);
      console.error('备份失败:', err);
    } finally {
      setBusy(false);
    }
  }, [password, confirmPassword, backupIdentity, t]);

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

        {/* 8. 关于（对应 web 的 styles.fullButton + navigation.navigate('About')） */}
        <Button
          className="settings__fullButton settings__fullButton--ghost"
          onClick={async () => {
            await Taro.navigateTo({ url: '/pages/about/index' });
          }}
        >
          {t('settings.about')}
        </Button>
      </ScrollView>
    </View>
  );
}
