/**
 * password-cache.ts - 备份密码缓存（key-rotation-plan.md 1.2，miniapp 移植版）
 *
 * 安全约束（2026-10-14 拍板）：密码**绝不能落在与会话状态同层的可快照存储**
 * （wx storage 文件）。否则快照攻击者 = 拿到 state + 密码，可永远恢复最新
 * 自动刷新的备份、链式跟随所有轮换——前向安全整体失效。
 *
 * 小程序无系统安全区（Keychain/Keystore 等价物）→ **仅会话内存缓存**：
 * 冷启动后首次备份/恢复需重输一次密码。登出/清库必须调用 clearBackupPassword()。
 */

let memoryCache: string | null = null;

export async function saveBackupPassword(password: string): Promise<void> {
  memoryCache = password;
}

export async function getBackupPassword(): Promise<string | null> {
  return memoryCache;
}

export async function clearBackupPassword(): Promise<void> {
  memoryCache = null;
}
