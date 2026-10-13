/**
 * password-cache.ts - 备份密码缓存（key-rotation-plan.md 1.2）
 *
 * 安全约束（2026-10-14 拍板）：密码**绝不能落在与会话状态同层的可快照存储**
 * （localStorage / AsyncStorage 文件）。否则快照攻击者 = 拿到 state + 密码，
 * 可永远恢复最新自动刷新的备份、链式跟随所有轮换——前向安全整体失效。
 *
 * - native（iOS/Android）：expo-secure-store 系统安全区（Keychain/Keystore），
 *   文件快照拿不到；keychainAccessible = 仅本设备解锁后可读，不随 iCloud 备份迁移；
 * - web（含 embed 模式）：无系统安全区 → **会话内存**（模块级变量，不落盘），
 *   app 重启后首次备份/恢复需重输一次密码；
 * - 登出（logout）必须调用 clearBackupPassword()，换账号不残留。
 *
 * 明文威胁模型：native 侧等同系统安全区标准；web 侧内存中的密码对能跑页面
 * 脚本的攻击者（XSS）可见——这与会话状态本身的暴露面一致，不承诺额外强度。
 */

import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

const KEYCHAIN_KEY = 'dme.backupPasswordCache';

// web / secure-store 异常时的内存兜底（native 侧同时缓存以减少 Keychain 读取）
let memoryCache: string | null = null;

export async function saveBackupPassword(password: string): Promise<void> {
  memoryCache = password;
  if (Platform.OS === 'web') return;
  try {
    await SecureStore.setItemAsync(KEYCHAIN_KEY, password, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
  } catch (err) {
    // Keychain 写失败不阻塞备份流程：密码至少在本会话内存可用
    console.warn('password-cache: secure store save failed:', err);
  }
}

export async function getBackupPassword(): Promise<string | null> {
  if (memoryCache !== null) return memoryCache;
  if (Platform.OS === 'web') return null;
  try {
    const value = await SecureStore.getItemAsync(KEYCHAIN_KEY, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
    memoryCache = value;
    return value;
  } catch (err) {
    console.warn('password-cache: secure store read failed:', err);
    return null;
  }
}

export async function clearBackupPassword(): Promise<void> {
  memoryCache = null;
  if (Platform.OS === 'web') return;
  try {
    await SecureStore.deleteItemAsync(KEYCHAIN_KEY, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
  } catch (err) {
    console.warn('password-cache: secure store clear failed:', err);
  }
}
