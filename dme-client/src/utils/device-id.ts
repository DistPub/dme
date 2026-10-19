/**
 * utils/device-id.ts - 设备短码：安装期随机生成、持久化于本机 storage。
 *
 * 用途：备份记录外层明文元数据（BackupMeta）的展示标签——确认弹窗里
 * 「ios-M3XP 于 20:31 写入」就是 platform + deviceId。
 *
 * 设计约束：
 *   - 纯随机熵（账号密钥全设备相同，从账号体系内派生不出区分度）；
 *   - 永不进入加密备份载荷（FullBackupData）——恢复流程不消费它，
 *     本机 id 不会被任何一次恢复改写；
 *   - 重装 / 清存储会换新短码：可接受（低频操作，旧份备份仍可凭
 *     时间与指纹判断）。
 */

import { Platform } from 'react-native';
import { storage } from '../storage/backend';
import { bytesToBase64url } from '../crypto/utils';

const DEVICE_ID_KEY = 'dme.deviceId';
let cached: string | null = null;

/** 取本机设备短码（8 字符，base64url）；不存在时随机生成并持久化。 */
export async function getOrCreateDeviceId(): Promise<string> {
  if (cached) return cached;
  const existing = await storage.getItem(DEVICE_ID_KEY);
  if (existing) {
    cached = existing;
    return existing;
  }
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  const id = bytesToBase64url(bytes).replace(/[-_]/g, 'A').slice(0, 8);
  await storage.setItem(DEVICE_ID_KEY, id);
  cached = id;
  return id;
}

/** 平台标签：web / ios / android / miniapp（miniapp 端由自己的实现覆盖）。 */
export function getPlatformLabel(): string {
  return Platform.OS;
}

/** 弹窗展示标签，如「ios-M3XP」「web-K7Q2M4XA」。 */
export function formatDeviceLabel(meta: { deviceId: string; platform: string }): string {
  return `${meta.platform}-${meta.deviceId}`;
}
