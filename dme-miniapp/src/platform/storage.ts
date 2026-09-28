/**
 * platform/storage.ts - AsyncStorage 兼容的最小存储实现。
 *
 * dme-client 的 storage/db.ts 与 i18n/I18nContext.tsx 只用到 4 个方法：
 *   getItem / setItem / removeItem / getAllKeys
 * 这里以 `Taro.*StorageSync` 同步 API 实现同名异步接口，db.ts 逻辑零改动。
 *
 * ⚠️ 容量守卫：微信 wx.storage 单 key 上限 1MB。消息按会话存成单个 JSON 数组
 *   （db.ts putMessage 整读整写），超限会写入失败。这里在 setItem 时做 900KB
 *   预警日志（不抛错，避免影响正常流程），便于尽早发现需要分片。
 */

import Taro from '@tarojs/taro';

/** 单 key 预警阈值（微信上限 1MB = 1048576 字节）。 */
const KEY_SIZE_WARN_BYTES = 900 * 1024;

function estimateBytes(value: string): number {
  // 中文字符占 3 字节，这里按上界估算（length * 3）以留安全余量
  return value.length * 3;
}

export const DmeAsyncStorage = {
  async getItem(key: string): Promise<string | null> {
    try {
      const value = Taro.getStorageSync<string>(key);
      return value === '' || value === undefined || value === null ? null : (value as string);
    } catch (err) {
      console.error('[dme:storage] getItem 失败:', key, err);
      return null;
    }
  },

  async setItem(key: string, value: string): Promise<void> {
    const size = estimateBytes(value);
    if (size > KEY_SIZE_WARN_BYTES) {
      console.warn(
        `[dme:storage] key "${key}" 体积约 ${Math.round(size / 1024)}KB，接近微信单 key 1MB 上限，建议分片存储`,
      );
    }
    try {
      Taro.setStorageSync(key, value);
    } catch (err) {
      console.error('[dme:storage] setItem 失败（可能超出容量）:', key, err);
      throw err;
    }
  },

  async removeItem(key: string): Promise<void> {
    try {
      Taro.removeStorageSync(key);
    } catch (err) {
      console.error('[dme:storage] removeItem 失败:', key, err);
    }
  },

  async getAllKeys(): Promise<string[]> {
    try {
      const info = Taro.getStorageInfoSync();
      return info.keys ?? [];
    } catch (err) {
      console.error('[dme:storage] getAllKeys 失败:', err);
      return [];
    }
  },
};

export default DmeAsyncStorage;
