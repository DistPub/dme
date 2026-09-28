/**
 * scripts/inject-polyfills.mjs - 在 dist/app.js 顶部注入「全局对象占位」。
 *
 * 🔴 问题：@noble 在模块求值时就固化了 crypto 引用
 * ------------------------------------------------------------------
 * `@noble/hashes/crypto.js` 的实现是：
 *
 *   exports.crypto = typeof globalThis === 'object' && 'crypto' in globalThis
 *     ? globalThis.crypto : undefined;
 *
 * 这是**模块求值那一刻的一次性绑定**。而 Taro 产物 `app.js` 第一行是：
 *
 *   require("./common"), require("./vendors"), ...
 *
 * `@noble/hashes` 在 `vendors.js` 里 → 早于 `app.js` 模块体（`installPolyfills()`
 * 所在处）就被求值。此时 `globalThis.crypto` 尚不存在，noble 就把 `crypto`
 * 永久绑定成 `undefined`，此后任何 `randomPrivateKey()` 都抛：
 *
 *   Error: crypto.getRandomValues must be defined
 *
 * 💡 关键洞察：noble 保存的是 **`globalThis.crypto` 这个对象引用**，而调用时
 *    每次都用 `crypto_1.crypto.getRandomValues(...)` **重新取属性**。
 *
 *    所以只需要在 require 之前**放一个空的 crypto 对象占位**，让 noble 拿到
 *    引用；真正的 `getRandomValues` 实现仍由 `src/polyfills/random.ts` 在
 *    `installPolyfills()` 里挂到**同一个对象**上 —— 引用一致，noble 就能调到。
 *
 *    同理为 `TextEncoder` / `TextDecoder` / `btoa` / `atob` 预留位置：
 *    noble 与 ts-mls 也可能在模块顶层读取它们。
 *
 * 这样注入的代码量极小（不需要把整个 polyfill 复制一遍），且**单一实现源**，
 * 不会出现两套实现不一致的风险。
 *
 * 用法
 * ----
 *   node scripts/inject-polyfills.mjs [distDir]
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const DIST_DIR = path.resolve(process.argv[2] ?? 'dist');
const APP_JS = path.join(DIST_DIR, 'app.js');

/** 幂等标记：重复注入时跳过。 */
const MARKER = '__dmeGlobalPlaceholdersInstalled';

/**
 * 注入的占位代码。
 *
 * 要求：纯 ES5、自包含、不 import 任何模块、同步执行。
 * 只**创建**全局对象，不实现具体逻辑（实现留给 src/polyfills/*）。
 */
const PLACEHOLDER = `/* dme-global-placeholders:start */
(function () {
  var g = globalThis;
  if (g.${MARKER}) return;
  g.${MARKER} = true;

  // @noble/hashes/crypto.js 会在模块求值时读 globalThis.crypto 并保存引用。
  // 这里先放一个空对象占位，具体 getRandomValues 由 installPolyfills() 补上。
  // ⚠️ 绝不能在此定义 crypto.subtle —— ts-mls 检测到 subtle 会误走 WebCrypto
  //    路径并崩溃（详见 AGENTS.md 关键设计 §2）。
  if (!g.crypto) g.crypto = {};

  // 这些全局对象在部分小程序运行时缺失，noble / ts-mls 在模块顶层会读它们。
  // 同样先占位，实现由 installPolyfills() 补齐。
  if (typeof g.TextEncoder === 'undefined') g.TextEncoder = function TextEncoder() {};
  if (typeof g.TextDecoder === 'undefined') g.TextDecoder = function TextDecoder() {};
  if (typeof g.btoa === 'undefined') g.btoa = function btoa() {};
  if (typeof g.atob === 'undefined') g.atob = function atob() {};
})();
/* dme-global-placeholders:end */
`;

async function main() {
  let source;
  try {
    source = await readFile(APP_JS, 'utf8');
  } catch {
    console.error(`❌ 找不到 ${APP_JS}，请先构建。`);
    process.exit(1);
  }

  if (source.includes(MARKER)) {
    console.log('ℹ️  app.js 已含全局占位，跳过注入。');
    return;
  }

  // 注入到 license banner 之后、任何 require 之前
  const banner = /^\/\*![^\n]*\*\/\n/;
  const m = source.match(banner);
  const injected = m
    ? m[0] + PLACEHOLDER + '\n' + source.slice(m[0].length)
    : PLACEHOLDER + '\n' + source;

  await writeFile(APP_JS, injected, 'utf8');

  // 自检：确认占位在任何 require 之前
  const reqIdx = injected.indexOf('require("./');
  const phIdx = injected.indexOf(MARKER);
  if (phIdx < 0 || (reqIdx >= 0 && phIdx > reqIdx)) {
    console.error('❌ 注入位置异常：未能在所有 require 之前');
    process.exit(1);
  }
  console.log(`✅ 已在 app.js 顶部注入全局占位（占位@${phIdx} < require@${reqIdx}）`);
}

main().catch((err) => {
  console.error('❌ 注入全局占位失败：', err);
  process.exit(1);
});
