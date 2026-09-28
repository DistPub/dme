/**
 * components/ErrorBoundary.tsx - 把白屏变成可见的错误信息。
 *
 * 为什么需要：小程序真机上如果 React 渲染期抛异常，整页会**白屏且无任何提示**，
 * 无法定位问题。这里捕获渲染错误并把 message + stack 直接画到页面上，
 * 方便真机截图排查。
 *
 * 同时 app.tsx 会安装全局 errorHandler 捕获渲染期之外的启动异常。
 */

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { View, Text } from '@tarojs/components';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
  info: string;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, info: '' };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[DME] 渲染异常:', error, info);
    this.setState({ info: info?.componentStack ?? '' });
  }

  render(): ReactNode {
    const { error, info } = this.state;
    if (!error) return this.props.children;

    return (
      <View
        style={{
          padding: '32rpx',
          fontSize: '24rpx',
          lineHeight: '1.6',
          wordBreak: 'break-all',
          background: '#fff',
          minHeight: '100vh',
        }}
      >
        <Text style={{ fontSize: '30rpx', fontWeight: 'bold', color: '#c00' }}>
          启动失败（ErrorBoundary 捕获）
        </Text>

        <View style={{ marginTop: '24rpx' }}>
          <Text style={{ fontWeight: 'bold' }}>message：</Text>
          <Text style={{ color: '#c00' }}>{error.message || '(空)'}</Text>
        </View>

        {error.stack ? (
          <View style={{ marginTop: '16rpx' }}>
            <Text style={{ fontWeight: 'bold' }}>stack：</Text>
            <Text>{error.stack.slice(0, 2000)}</Text>
          </View>
        ) : null}

        {info ? (
          <View style={{ marginTop: '16rpx' }}>
            <Text style={{ fontWeight: 'bold' }}>componentStack：</Text>
            <Text>{info.slice(0, 1200)}</Text>
          </View>
        ) : null}
      </View>
    );
  }
}
