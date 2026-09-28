/**
 * polyfills/random.ts - crypto.getRandomValues 同步 API 的小程序实现。
 *
 * 矛盾点：ts-mls / keypackage / file-crypto / backup / mls-session 共 7 处
 * 调用 `crypto.getRandomValues(...)` 是**同步**的，而微信提供的
 * `wx.getRandomValues`（基础库 2.15.0+）是**异步**的（回调 / Promise）。
 *
 * 解法：预取缓冲池。
 *   - 启动即异步预取 64KB 入池（wx.getRandomValues 单次上限 1MB）；
 *   - 同步取用时从池中切分，可用量低于水位线（8KB）时自动异步补充；
 *   - 池空时用同步兜底（sha256(状态串) 派生），并打 warn 日志。
 *
 * ⚠️ 注意：本 polyfill 只提供 getRandomValues，**绝不创建 crypto.subtle**。
 *    ts-mls 的 Ed25519 签名实现会检测 `globalThis.crypto?.subtle` 是否存在，
 *    一旦存在就会走 WebCrypto 路径（小程序无此能力）并崩溃；不存在时才回退
 *    @noble 纯 JS 分支 —— 正是我们要的路径。见 PLAN.md §0.1 / §0.4。
 */

import { sha256 } from '@noble/hashes/sha256';
import { utf8ToBytes } from './encoding';

/** 缓冲池容量（一次预取）。 */
const POOL_SIZE = 64 * 1024;
/** 水位线：剩余不足该值即触发异步补充。 */
const LOW_WATERMARK = 8 * 1024;
/** 单次 wx.getRandomValues 请求字节数。 */
const FETCH_SIZE = 32 * 1024;

let pool = new Uint8Array(0);
let refilling = false;
let warnCount = 0;

/** 同步兜底随机源（非密码学安全，仅池空应急；以计数器 + 时间 + 池内残留做种子）。 */
let fallbackCounter = 0;
let fallbackState: Uint8Array = sha256(utf8ToBytes(`dme-fallback-${Date.now()}-${Math.random()}`));

function fallbackRandom(n: number): Uint8Array {
  const out = new Uint8Array(n);
  let offset = 0;
  while (offset < n) {
    fallbackCounter += 1;
    fallbackState = sha256(fallbackState);
    const take = Math.min(32, n - offset);
    out.set(fallbackState.subarray(0, take), offset);
    offset += take;
  }
  return out;
}

/** 异步从微信接口取随机数并追加进池。 */
async function refill(): Promise<void> {
  if (refilling) return;
  refilling = true;
  try {
    const wxApi = (globalThis as unknown as { wx?: { getRandomValues?: (o: unknown) => void } }).wx;
    if (!wxApi?.getRandomValues) {
      console.error('[dme] wx.getRandomValues 不可用（需基础库 2.15.0+），将使用同步兜底随机源');
      return;
    }
    const bytes = await new Promise<Uint8Array>((resolve, reject) => {
      wxApi.getRandomValues!({
        length: FETCH_SIZE,
        success: (res: { randomValues: ArrayBuffer }) => resolve(new Uint8Array(res.randomValues)),
        fail: (err: unknown) => reject(err),
      });
    });
    // 追加到池尾（池内可能还有残留数据）
    const merged = new Uint8Array(pool.length + bytes.length);
    merged.set(pool, 0);
    merged.set(bytes, pool.length);
    // 只保留最新 POOL_SIZE 字节，避免无限增长
    pool = merged.length > POOL_SIZE ? merged.subarray(merged.length - POOL_SIZE) : merged;
  } catch (err) {
    console.error('[dme] 随机数预取失败，将使用同步兜底随机源:', err);
  } finally {
    refilling = false;
  }
}

/** 启动时调用：预取随机数缓冲池。 */
export function primeRandomPool(): void {
  void refill();
}

/** crypto.getRandomValues 的小程序实现（同步）。 */
function getRandomValues<T extends ArrayBufferView>(array: T): T {
  const view = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
  const n = view.length;
  if (n === 0) return array;

  if (pool.length >= n) {
    view.set(pool.subarray(pool.length - n)); // 从池尾取，避免 subarray 引用歧义
    pool = pool.subarray(0, pool.length - n);
  } else {
    // 池不够：有多少用多少，剩余走同步兜底
    const avail = pool.length;
    if (avail > 0) {
      view.set(pool, 0);
      pool = pool.subarray(0, 0);
    }
    view.set(fallbackRandom(n - avail), avail);
    if (warnCount < 5) {
      warnCount += 1;
      console.warn('[dme] 随机数池耗尽，已使用非密码学安全的同步兜底（请检查预取是否正常）');
    }
  }

  if (pool.length < LOW_WATERMARK) void refill();
  return array;
}

/** 挂载全局 crypto.getRandomValues（不创建 crypto.subtle）。 */
export function installRandomPolyfill(): void {
  const g = globalThis as unknown as { crypto?: Record<string, unknown> };
  if (!g.crypto) {
    g.crypto = {};
  }
  const cryptoObj = g.crypto as Record<string, unknown>;
  if (typeof cryptoObj.getRandomValues !== 'function') {
    cryptoObj.getRandomValues = getRandomValues;
  }
  primeRandomPool();
}
