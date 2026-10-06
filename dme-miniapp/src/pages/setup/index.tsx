/**
 * pages/setup/index.tsx - 身份设置页（密钥声明到 DID 文档）。
 *
 * 三条分支：
 *   1. did:plc → 请求 PLC 签名 token（发到邮箱）→ 输入 token → declareKeys
 *   2. did:web → 展示需要手工加入 did.json 的 verificationMethod 条目
 *   3. 远端已声明密钥但本地无私钥 → 引导「从备份恢复」
 *
 * ⚠️ declareKeys 成功后 DID 文档才会带上 #dme_encryption / #dme_signing，
 *    对方才能拿到你的公钥完成握手。
 */

import { useCallback, useEffect, useState } from 'react';
import { View, Text, Input, Button, ScrollView } from '@tarojs/components';
import Taro from '@tarojs/taro';

import { setClipboard } from '../../platform/clipboard';
import { useApp } from '../../state/AppContext';
import { useI18n } from '../../i18n/I18nContext';
import { LogoSpinner } from '../../components/LogoSpinner';
import {
  getDidMethod,
  getRemoteEncryptionKey,
  getRemoteSigningKey,
  generateDidWebUpdate,
  requestPlcSignature,
  type DidWebEntry,
} from '../../atproto/did';
import { useWebTitle } from '../../utils/web-title';
import './index.scss';

type MobileMode = 'checking' | 'plc' | 'web' | 'restore' | 'done';

export default function SetupPage(): React.JSX.Element {
  const { t } = useI18n();
  const {
    session,
    storage,
    storageSync,
    identityKeys,
    identityKeysSync,
    declareKeys,
    restoreIdentityFromBackup,
    hasIdentityBackup,
    setupIdentity,
    clearSession,
    loading,
  } = useApp();

  const [mode, setMode] = useState<MobileMode>('checking');
  const [plcToken, setPlcToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [webEntries, setWebEntries] = useState<DidWebEntry[]>([]);
  const [webDidJson, setWebDidJson] = useState<string | null>(null);
  const [restorePassword, setRestorePassword] = useState('');

  useWebTitle(t('setup.title'));

  const did = session?.did ?? '';

  // ---- 首次进入：判断该走哪条分支 ---------------------------------------
  useEffect(() => {
    let cancelled = false;

    (async () => {
      if (!session) {
        await Taro.reLaunch({ url: '/pages/login/index' });
        return;
      }

      await setupIdentity();

      // 重新读取本地身份密钥（setupIdentity 可能刚生成）
      // ⚠️ 用 storageSync / identityKeysSync 而非 state：本行与 setupIdentity() 在
      //    同一个 tick，React state 尚未提交，读 state 会拿到 null（2026-09-28 踩坑）。
      const activeStorage = storageSync ?? storage;
      const localKeys = (await activeStorage?.getIdentityKeys().catch(() => null)) ?? null;
      const keys = localKeys ?? identityKeysSync ?? identityKeys;
      if (!keys) {
        setLocalError('身份密钥不可用，请返回登录页重试');
        return;
      }

      // 远端是否已声明 DME 公钥
      const remoteKey = await getRemoteEncryptionKey(did, true);
      if (cancelled) return;

      const method = getDidMethod(did);

      // ⚠️ 与 web 端 SetupScreen.checkKey 完全一致的判定（2026-09-28 修复）：
      //   1. 远端没声明过 → did:web 给 did.json 指引 / did:plc 走邮箱签名 token
      //   2. 远端已声明 → **逐字节比较**本地加密公钥与远端公钥：
      //      一致 → done（自动进聊天列表）
      //      不一致（换设备/重装/多端登录）→ restore 模式（从备份恢复 或 重新声明）
      //
      //    早期实现只判断"远端有没有声明"，**从不比较内容**，本地随便什么密钥
      //    都被当成已声明直接放行 → 群聊握手时对方按 DID 文档旧公钥加密的
      //    KeyPackage 解不开，弹 `aes/gcm: invalid ghash tag`（真机实测）。
      if (!remoteKey) {
        if (method === 'web') {
          const update = await generateDidWebUpdate(did, keys);
          if (cancelled) return;
          setWebEntries(update.newEntries);
          setWebDidJson(update.didJson);
          setMode('web');
        } else {
          setMode('plc');
        }
        return;
      }

      const localPub = keys.encryption.publicKey;
      const matches =
        remoteKey.length === localPub.length &&
        remoteKey.every((b: number, i: number) => b === localPub[i]);

      if (matches) {
        setMode('done');
        // web 端 done 后立即 replace 到 ChatList；这里延迟一拍自动跳转，
        // 用户不会停留在本页（'done' 的手动按钮仅作兜底）
        setTimeout(() => {
          if (cancelled) return;
          void Taro.reLaunch({ url: '/pages/chat-list/index' });
        }, 800);
        return;
      }

      // 本地密钥与 DID 文档不一致 → 让用户选择恢复备份或重新声明
      setMode('restore');
    })();

    return () => {
      cancelled = true;
    };
    // 仅在会话就绪时执行一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [did]);

  // ---- did:plc：请求签名 token -------------------------------------------
  const handleRequestToken = useCallback(async (): Promise<void> => {
    if (!session) return;
    setBusy(true);
    setLocalError(null);
    try {
      await requestPlcSignature(session);
      await Taro.showToast({ title: t('setup.tokenPrompt'), icon: 'none', duration: 3000 });
    } catch (err) {
      setLocalError(t('setup.failedPlcSig'));
      console.error('requestPlcSignature 失败:', err);
    } finally {
      setBusy(false);
    }
  }, [session, t]);

  // ---- did:plc：提交 token 声明密钥 --------------------------------------
  const handleDeclare = useCallback(async (): Promise<void> => {
    if (!plcToken.trim()) {
      setLocalError(t('setup.tokenPlaceholder'));
      return;
    }
    setBusy(true);
    setLocalError(null);
    try {
      await declareKeys(plcToken.trim());
      await Taro.showToast({ title: t('common.saved'), icon: 'success' });
      await Taro.reLaunch({ url: '/pages/chat-list/index' });
    } catch (err) {
      setLocalError(t('setup.failedDeclare'));
      console.error('declareKeys 失败:', err);
    } finally {
      setBusy(false);
    }
  }, [plcToken, declareKeys, t]);

  // ---- did:web：复制 did.json --------------------------------------------
  const handleCopyDidJson = useCallback(async (): Promise<void> => {
    const content = webDidJson ?? JSON.stringify(webEntries, null, 2);
    await setClipboard(content);
    await Taro.showToast({ title: t('common.copy'), icon: 'success' });
  }, [webDidJson, webEntries, t]);

  // ---- did:web：重新检测 --------------------------------------------------
  const handleRecheckWeb = useCallback(async (): Promise<void> => {
    setBusy(true);
    try {
      const enc = await getRemoteEncryptionKey(did, true);
      const sig = await getRemoteSigningKey(did, true);
      if (enc && sig) {
        await Taro.reLaunch({ url: '/pages/chat-list/index' });
      } else {
        await Taro.showToast({ title: t('setup.retryCheck'), icon: 'none' });
      }
    } catch (err) {
      console.error('did:web 重新检测失败:', err);
    } finally {
      setBusy(false);
    }
  }, [did, t]);

  // ---- 从备份恢复 --------------------------------------------------------
  const handleRestore = useCallback(async (): Promise<void> => {
    if (!restorePassword) {
      setLocalError(t('settings.enterPassword'));
      return;
    }
    setBusy(true);
    setLocalError(null);
    try {
      const exists = await hasIdentityBackup();
      if (!exists) {
        setLocalError(t('setup.noBackup'));
        return;
      }
      const ok = await restoreIdentityFromBackup(restorePassword);
      if (ok) {
        await Taro.reLaunch({ url: '/pages/chat-list/index' });
      } else {
        setLocalError(t('setup.restoreFailed'));
      }
    } catch (err) {
      setLocalError(t('setup.restoreFailed'));
      console.error('恢复身份失败:', err);
    } finally {
      setBusy(false);
    }
  }, [restorePassword, hasIdentityBackup, restoreIdentityFromBackup, t]);

  // checking 与 done 都是自动过渡态：渲染与 login/chat-list 相同的全屏
  // 品牌启动屏（LogoSpinner 自带 fixed 全屏定位，跨页面位置一致不跳变），
  // 不出现本页的标题 / 返回登录等交互元素
  if (mode === 'checking' || mode === 'done') {
    return <LogoSpinner />;
  }

  return (
    <ScrollView className="setup" scrollY>
      <Text className="setup__title">{t('setup.title')}</Text>

      {localError ? <Text className="setup__error">{localError}</Text> : null}

      {mode === 'plc' ? (
        <View className="setup__block">
          <Button className="setup__button setup__button--ghost" onClick={handleRequestToken}>
            {t('setup.publish')}
          </Button>
          <Text className="setup__hint">{t('setup.tokenPrompt')}</Text>
          <Input
            className="setup__input"
            value={plcToken}
            placeholder={t('setup.tokenPlaceholder')}
            onInput={(e) => setPlcToken(e.detail.value)}
          />
          <Button className="setup__button" onClick={handleDeclare}>
            {busy || loading ? t('setup.declaring') : t('setup.declareKeys')}
          </Button>
        </View>
      ) : null}

      {mode === 'web' ? (
        <View className="setup__block">
          <Text className="setup__hint">{t('setup.webNote1')}</Text>
          <Text className="setup__hint">
            {webDidJson ? t('setup.webNote2') : t('setup.webNote3')}
          </Text>
          <ScrollView className="setup__code" scrollY>
            <Text className="setup__codeText">
              {webDidJson ?? JSON.stringify(webEntries, null, 2)}
            </Text>
          </ScrollView>
          <Button className="setup__button setup__button--ghost" onClick={handleCopyDidJson}>
            {t('common.copy')}
          </Button>
          <Button className="setup__button" onClick={handleRecheckWeb}>
            {t('setup.webCheck')}
          </Button>
        </View>
      ) : null}

      {mode === 'restore' ? (
        <View className="setup__block">
          <Text className="setup__hint">{t('setup.restoreChoice')}</Text>
          <Text className="setup__title" style={{ fontSize: 36, marginBottom: 12 }}>
            @{session?.handle ?? ''}
          </Text>
          <Text
            className="setup__codeText"
            style={{ fontSize: 22, lineHeight: 34, marginBottom: 24 }}
            selectable
          >
            {session?.did ?? ''}
          </Text>
          <Input
            className="setup__input"
            password
            value={restorePassword}
            placeholder={t('setup.backupPasswordPlaceholder')}
            onInput={(e) => setRestorePassword(e.detail.value)}
          />
          <Button className="setup__button" onClick={handleRestore}>
            {busy ? t('setup.restoring') : t('setup.restore')}
          </Button>
          <Button
            className="setup__button setup__button--ghost"
            onClick={() => setMode(getDidMethod(did) === 'web' ? 'web' : 'plc')}
          >
            {t('setup.redeclare')}
          </Button>
        </View>
      ) : null}

      <Button
        className="setup__button setup__button--ghost"
        onClick={async () => {
          // 🔴 必须先清会话再回登录页：login 页挂载时 restoreSession() 只看
          // 本地持久化的 session —— 若 token 还在，会立刻被弹回 setup，
          // 形成「setup → login → setup」死循环。clearSession 只吊销 token、
          // 删除本地 session 持久化，保留身份密钥与消息库，重新登录后
          // setup 密钥比对仍能直接放行。
          await clearSession();
          await Taro.reLaunch({ url: '/pages/login/index' });
        }}
      >
        {t('setup.backToLogin')}
      </Button>
    </ScrollView>
  );
}
