/**
 * crypto/rng.ts - ts-mls `Rng` 接口的纯 JS 实现。
 *
 * 【为什么不能复用 ts-mls 的 defaultRng】
 *   ts-mls/dist/src/crypto/implementation/default/rng.js:
 *       randomBytes(n) { return crypto.getRandomValues(new Uint8Array(n)); }
 *   它直接引用**全局** `crypto.getRandomValues`。本项目的 random polyfill
 *   （`src/polyfills/random.ts`）确实会把 `globalThis.crypto.getRandomValues`
 *   补上，但那条路径依赖 polyfill 的安装时机；一旦 `installPolyfills()` 未执行
 *   （或 `@noble/hashes/crypto.js` 在占位注入前就绑定了空的 crypto 对象），
 *   真机就是 `crypto.getRandomValues must be defined`。
 *
 *   这里改为直接调用 `@noble/hashes/crypto.js` 导出的 **`crypto` 对象本身**：
 *   注意 `crypto.js` 是 `export const crypto = ...`（**具名导出**，不是默认导出），
 *   `utils.js` 内部正是这样引用它的。同一条绑定链 + (crypto.getRandomValues ||
 *   crypto.randomBytes || 抛错) 的三级兜底。
 *
 * 【为什么必须是同步】
 *   ts-mls 的 `Rng.randomBytes(n)` 是同步签名，而 `wx.getRandomValues` 是异步 API，
 *   所以 polyfill 侧用 64KB 预取缓冲池 + 同步兜底（见 AGENTS.md 关键设计 §4）。
 */

import { crypto as nobleCrypto } from '@noble/hashes/crypto';
import { randomBytes } from '@noble/hashes/utils';
import type { Rng } from 'ts-mls';

/** 兼容 ts-mls `Rng` 接口、不依赖 WebCrypto `subtle` 的随机数源。 */
export const nobleRng: Rng = {
  randomBytes(n: number): Uint8Array {
    // 优先走 @noble/hashes 自己的 randomBytes（与 rest of noble 同一随机源）。
    // 它在 crypto.getRandomValues 缺失时会抛错，此时退回 ts-mls 的等价实现，
    // 保证在任何 polyfill 状态下都不会「静默返回全零」。
    try {
      return randomBytes(n);
    } catch (err) {
      const c = nobleCrypto as
        | { getRandomValues?: (o: Uint8Array) => Uint8Array }
        | undefined;
      if (c && typeof c.getRandomValues === 'function') {
        return c.getRandomValues(new Uint8Array(n));
      }
      throw err;
    }
  },
};
