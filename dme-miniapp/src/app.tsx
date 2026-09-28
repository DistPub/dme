/**
 * app.ts - 应用入口。
 *
 * 启动顺序非常关键：
 *   1. installPolyfills() 必须最先执行 —— 在加载任何 crypto/ts-mls 代码之前，
 *      把 crypto.getRandomValues / btoa / atob / TextEncoder / TextDecoder 注入全局，
 *      并用 wx.getRandomValues 预取随机数缓冲池（同步调用方依赖它）。
 *   2. 安装全局错误捕获（onError / unhandledrejection）—— 真机白屏时把真实
 *      错误显示出来，而不是让用户面对一片空白。
 *   3. 之后才 render React 树（ErrorBoundary / I18nProvider / AppProvider）。
 */
import './polyfills';

import { Component, type PropsWithChildren, type ReactNode } from 'react';
import Taro from '@tarojs/taro';

import { I18nProvider } from './i18n/I18nContext';
import { AppProvider } from './state/AppContext';
import { ErrorBoundary } from './components/ErrorBoundary';
import './app.scss';

/**
 * 捕获启动期异常（渲染期之外的）并在页面上显示。
 *
 * 小程序真机没有控制台可看，白屏时无从下手；这里把错误写到 app 级的全局
 * 变量并尝试渲染，配合 ErrorBoundary 覆盖绝大多数启动崩溃。
 */
interface GlobalBootError {
  message: string;
  stack: string;
}

export function installGlobalErrorHandlers(): void {
  const g = globalThis as unknown as {
    onError?: (msg: string) => void;
    __dmeBootError?: GlobalBootError;
  };

  const record = (message: string, stack = ''): void => {
    g.__dmeBootError = { message, stack };
    console.error('[DME] 启动异常:', message, stack);
  };

  // 小程序未捕获异常
  const prev = g.onError;
  g.onError = (msg: string): void => {
    record(String(msg));
    prev?.(msg);
  };

  // 未处理的 Promise rejection（异步启动路径常见）
  const proc = (globalThis as unknown as {
    process?: { on?: (ev: string, cb: (e: unknown) => void) => void };
  }).process;
  proc?.on?.('unhandledRejection', (e: unknown) => {
    const err = e as { message?: string; stack?: string } | undefined;
    record(err?.message ?? String(e), err?.stack ?? '');
  });
}

installGlobalErrorHandlers();

class App extends Component<PropsWithChildren> {
  render(): ReactNode {
    const { children } = this.props;
    return (
      <ErrorBoundary>
        <I18nProvider>
          <AppProvider>{children}</AppProvider>
        </I18nProvider>
      </ErrorBoundary>
    );
  }
}

export default App;
