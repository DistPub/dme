/**
 * utils/screen.ts - 屏幕可用尺寸（浮层定位用）。
 *
 * `Taro.getWindowInfo()` 需要基础库 2.20.1+；低版本会抛错，
 * 这里回退到 `getSystemInfoSync()`（已废弃但全版本可用）。
 */

import Taro from '@tarojs/taro';

export interface ScreenSize {
  width: number;
  height: number;
}

const FALLBACK: ScreenSize = { width: 375, height: 667 };

export function getScreenSize(): ScreenSize {
  try {
    const info = Taro.getWindowInfo();
    if (info && info.windowWidth > 0) {
      return { width: info.windowWidth, height: info.windowHeight };
    }
  } catch {
    // 基础库过低，走下面的回退
  }

  try {
    const info = Taro.getSystemInfoSync();
    return {
      width: info.windowWidth > 0 ? info.windowWidth : FALLBACK.width,
      height: info.windowHeight > 0 ? info.windowHeight : FALLBACK.height,
    };
  } catch (err) {
    console.warn('getScreenSize: 无法获取屏幕尺寸，使用回退值', err);
    return FALLBACK;
  }
}

/** 触点 / 点击的视口坐标（fixed 浮层定位用，与 clientX/clientY 同一坐标系）。 */
export interface TapPos {
  x: number;
  y: number;
}

/**
 * 从 Taro/weapp 事件里取触点视口坐标。
 *
 * 🔴 不要用 `createSelectorQuery` 去量测气泡：MessageBubble 等自定义组件
 *    内部节点页面查不到，且量测是异步往返（浮层跟随感差）。事件对象自带
 *    `changedTouches[0].clientX/clientY`（longpress/click 都有），同步又可靠。
 */
export function posFromEvent(e: unknown): TapPos {
  const ev = e as {
    changedTouches?: Array<{ clientX?: number; clientY?: number }>;
    touches?: Array<{ clientX?: number; clientY?: number }>;
    detail?: { x?: number; y?: number };
  };
  const t = ev.changedTouches?.[0] ?? ev.touches?.[0];
  if (t && typeof t.clientX === 'number' && typeof t.clientY === 'number') {
    return { x: t.clientX, y: t.clientY };
  }
  return { x: ev.detail?.x ?? 0, y: ev.detail?.y ?? 0 };
}

/** touchstart/move 里取当前触点（Taro 的 BaseEventOrig 类型不带 touches，这里兜底）。 */
export function touchOf(e: unknown): TapPos | null {
  const ev = e as {
    changedTouches?: Array<{ clientX?: number; clientY?: number }>;
    touches?: Array<{ clientX?: number; clientY?: number }>;
  };
  const t = ev.changedTouches?.[0] ?? ev.touches?.[0];
  if (t && typeof t.clientX === 'number' && typeof t.clientY === 'number') {
    return { x: t.clientX, y: t.clientY };
  }
  return null;
}
