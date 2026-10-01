/**
 * pages/login/index.tsx - 登录页。
 *
 * 职责：
 *   1. 进入时先尝试 restoreSession()（有本地会话直接进聊天列表）
 *   2. handle + app password + 可选 PDS URL（白名单校验）登录
 *   3. 登录成功后按身份密钥状态分流：
 *        - 无本地密钥 → setup 页（生成 + 声明到 DID）
 *        - 有本地密钥 → chat-list 页
 *
 * ⚠️ PDS 白名单：小程序 request 域名必须预先在微信后台配置，
 *    这里对用户输入的 pdsUrl 做白名单校验，不在名单内直接拒绝。
 */

import { useCallback, useEffect, useState } from 'react';
import { View, Text, Input, Button, Image } from '@tarojs/components';
import Taro from '@tarojs/taro';

import { useApp } from '../../state/AppContext';
import { useI18n } from '../../i18n/I18nContext';
import { PDS_URL } from '../../config';
import { useWebTitle } from '../../utils/web-title';
import { LogoSpinner } from '../../components/LogoSpinner';
import DmeAsyncStorage from '../../platform/storage';
import logoUrl from '../../assets/images/logo.png';
import './index.scss';

/**
 * ⚠️ 小程序前端不再做 PDS 域名白名单校验 —— 合法域名校验是微信后台的功能。
 *    微信公众平台 → 开发管理 → 开发设置 → 服务器域名 里配的域名才允许 request，
 *    前端写死白名单只会给用户制造"我输对了但被前端拦下"的体验问题（2026-10-01 真机实测）。
 */

/**
 * 上次登录 handle 的本地存储 key。
 *
 * ⚠️ iOS 系统级密码自动填充（Keychain AutoFill）在小程序内**微信平台层面
 * 不可用**（Associated Domains 属于微信域，input 是微信原生组件，无属性可开）。
 * 替代方案：登录成功后记住 handle，下次进入登录页自动回填账号，
 * 用户只需输入密码。密码出于安全不回填。
 */
const LAST_IDENTIFIER_KEY = 'dme:lastIdentifier';

export default function LoginPage(): React.JSX.Element {
  const { t } = useI18n();
  const {
    login,
    cancel2FA,
    restoreSession,
    loading,
    error,
    setupIdentity,
    session,
    sessionExpired,
    loginStep,
  } = useApp();

  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [pdsUrl, setPdsUrl] = useState(PDS_URL);
  const [authFactorToken, setAuthFactorToken] = useState('');
  const [bootstrapping, setBootstrapping] = useState(true);
  const [localError, setLocalError] = useState<string | null>(null);

  const awaiting2FA = loginStep === 'awaiting2FA';

  useWebTitle(t('login.title'));

  // ---- 回填上次登录的 handle（iOS 自动填充的替代方案，见文件头注释）------
  useEffect(() => {
    (async () => {
      try {
        const last = await DmeAsyncStorage.getItem(LAST_IDENTIFIER_KEY);
        if (last) setIdentifier(last);
      } catch (err) {
        console.error('读取上次登录 handle 失败:', err);
      }
    })();
  }, []);

  // ---- 启动时尝试恢复会话 ------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const restored = await restoreSession();
        if (cancelled) return;
        if (restored) {
          // ⚠️ 与 web 端一致（App.tsx computeGotoRoute：restored → 'Setup'）：
          //    恢复成功也**先进 Setup 页**做密钥一致性校验，再由它放行到聊天列表。
          await Taro.reLaunch({ url: '/pages/setup/index' });
          return;
        }
      } catch (err) {
        console.error('restoreSession 失败:', err);
      }
      if (!cancelled) setBootstrapping(false);
    })();
    return () => {
      cancelled = true;
    };
    // 仅首次挂载执行
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 恢复会话时若发现 token 已失效（服务端校验不通过），明确告知用户原因，
  // 否则用户会莫名"被登出"却不知道发生了什么。
  useEffect(() => {
    if (sessionExpired && !bootstrapping) {
      setLocalError(t('login.sessionExpired'));
    }
  }, [sessionExpired, bootstrapping, t]);

  const onBackToPassword = useCallback((): void => {
    cancel2FA();
    setAuthFactorToken('');
  }, [cancel2FA]);

  const handleLogin = useCallback(async (): Promise<void> => {
    setLocalError(null);

    if (!identifier.trim()) {
      setLocalError(t('login.handlePlaceholder'));
      return;
    }
    if (!password) {
      setLocalError(t('login.passwordPlaceholder'));
      return;
    }

    const trimmedPds = pdsUrl.trim() || PDS_URL;

    try {
      await login({
        identifier: identifier.trim(),
        password,
        pdsUrl: trimmedPds,
        authFactorToken: awaiting2FA ? authFactorToken.trim() || undefined : undefined,
      });

      if (awaiting2FA) {
        // 2FA 验证通过，继续后续引导流程
      }

      // 记住本次 handle，下次登录页自动回填
      await DmeAsyncStorage.setItem(LAST_IDENTIFIER_KEY, identifier.trim());
      // 确保身份密钥存在（首次登录会生成）
      await setupIdentity();

      // ⚠️ 与 web 端一致（App.tsx：登录成功 → navigate('Setup')）：
      //    **一律先进 Setup 页**，由它逐字节校验「本地密钥 vs DID 文档已声明的
      //    公钥」后再放行到聊天列表。绝不能因为本地有密钥就直接进列表 ——
      //    换设备/重装/多端登录后本地密钥与远端不一致时，群聊握手中对方按
      //    你 DID 文档旧公钥加密的 KeyPackage 将无法解密
      //    （`aes/gcm: invalid ghash tag`，2026-09-28 真机实测）。
      await Taro.reLaunch({ url: '/pages/setup/index' });
    } catch (err) {
      console.error('登录失败:', err);
      setLocalError(err instanceof Error ? err.message : t('login.failed'));
    }
  }, [identifier, password, pdsUrl, authFactorToken, awaiting2FA, login, setupIdentity, t]);

  if (bootstrapping || loading) {
    // 品牌过渡屏（对齐 web App.tsx 恢复会话时的 LogoSpinner），
    // 替代一闪而过的「加载中」文字
    return (
      <View className="login login--center">
        <LogoSpinner />
      </View>
    );
  }

  const shownError = localError ?? error;

  return (
    <View className="login">
      <View className="login__brand">
        <Image
          className="login__logo"
          src={logoUrl}
          mode="aspectFit"
          aria-label={t('login.title')}
        />
        <Text className="login__title">{t('login.title')}</Text>
      </View>

      {/* ⚠️ 字段次序与 web LoginScreen 一致：PDS → Handle → Password */}
      <View className="login__field">
        <Text className="login__label">{t('login.pdsPlaceholder')}</Text>
        <Input
          className={`login__input ${awaiting2FA ? 'login__input--disabled' : ''}`}
          value={pdsUrl}
          placeholder={t('login.pdsPlaceholder')}
          onInput={(e) => setPdsUrl(e.detail.value)}
          disabled={awaiting2FA}
        />
      </View>

      <View className="login__field">
        <Text className="login__label">{t('login.handlePlaceholder')}</Text>
        <Input
          className={`login__input ${awaiting2FA ? 'login__input--disabled' : ''}`}
          type="text"
          name="username"
          value={identifier}
          placeholder={t('login.handlePlaceholder')}
          onInput={(e) => setIdentifier(e.detail.value)}
          disabled={awaiting2FA}
        />
      </View>

      <View className="login__field">
        <Text className="login__label">{t('login.passwordPlaceholder')}</Text>
        <Input
          className={`login__input ${awaiting2FA ? 'login__input--disabled' : ''}`}
          password
          name="password"
          confirmType="send"
          value={password}
          placeholder={t('login.passwordPlaceholder')}
          onInput={(e) => setPassword(e.detail.value)}
          onConfirm={handleLogin}
          disabled={awaiting2FA}
        />
      </View>

      {awaiting2FA ? (
        <View className="login__field">
          <Text className="login__label">{t('login.2faPlaceholder')}</Text>
          {/* ⚠️ 不设 maxlength：2FA 验证码长度目前无统一标准，可能是 6 位以上 */}
          <Input
            className="login__input login__input--code"
            value={authFactorToken}
            placeholder={t('login.2faPlaceholder')}
            onInput={(e) => setAuthFactorToken(e.detail.value)}
            onConfirm={handleLogin}
            focus={awaiting2FA}
          />
        </View>
      ) : null}

      {shownError ? <Text className="login__error">{shownError}</Text> : null}

      <Button className="login__button" onClick={handleLogin}>
        {loading ? t('login.loggingIn') : awaiting2FA ? t('login.verify') : t('login.button')}
      </Button>

      {awaiting2FA ? (
        <Button className="login__button login__button--secondary" onClick={onBackToPassword}>
          {t('login.backToPassword')}
        </Button>
      ) : null}

      {session ? (
        <Text className="login__hint">
          {session.handle} · {session.did}
        </Text>
      ) : null}
    </View>
  );
}
