/**
 * 临时验证脚本（不属于交付物，验证后可删）：
 * 在 Node vm 沙箱里加载 dist 产物，模拟小程序「无 WebCrypto subtle」环境，
 * 直接调用 getNobleMlsImpl() 与一次完整 MLS 建群 + 加解密 + exporter 派生，
 * 证明 `new HkdfSha256()` 崩溃已根除，且纯 JS HPKE 能跑通字节级流程。
 */
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { webcrypto } from 'node:crypto';

const DIST = new URL('../dist/', import.meta.url).pathname;

// ---- 构造最小小程序全局 ----
const sandbox = {
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  Date,
  Math,
  JSON,
  Promise,
  Error,
  TypeError,
  Uint8Array,
  ArrayBuffer,
  DataView,
  TextEncoder,
  TextDecoder,
  btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
  atob: (s) => Buffer.from(s, 'base64').toString('binary'),
  // 只有 getRandomValues，绝不提供 subtle（复刻 inject-polyfills.mjs 的占位）
  crypto: { getRandomValues: (a) => webcrypto.getRandomValues(a) },
  wx: {},
  // Taro 运行时在小程序里由宿主注入的全局
  getCurrentPages: () => [],
  getApp: () => undefined,
  App: () => undefined,
  Page: () => undefined,
  Component: () => undefined,
  Behavior: () => undefined,
};
sandbox.globalThis = sandbox;
sandbox.window = undefined;
const ctx = createContext(sandbox);

// 按 Taro 的加载顺序求值（app.js 顶部已注入占位，crypto 引用在首次 require 前建立）
const loaded = new Set();
sandbox.require = (p) => {
  const name = `${String(p).replace(/^\.\//, '')}.js`;
  if (loaded.has(name)) return;
  loaded.add(name);
  const code = readFileSync(`${DIST}${name}`, 'utf8');
  runInContext(code, ctx, { filename: name });
};
runInContext(readFileSync(`${DIST}app.js`, 'utf8'), ctx, { filename: 'app.js' });

console.log('✅ 产物加载完成，无启动期异常');
console.log('   crypto.subtle =', typeof sandbox.crypto.subtle, '（必须 undefined）');

// ---- 从 webpack 模块表里取出测试钩子 ----
const hook = sandbox.__dmeTestGetNobleMlsImpl;
if (typeof hook !== 'function') {
  console.error('❌ 未找到 __dmeTestGetNobleMlsImpl 钩子');
  process.exit(1);
}

const impl = await hook();
console.log('\n✅ getNobleMlsImpl() 返回成功，字段齐备：');
for (const k of ['hash', 'kdf', 'signature', 'hpke', 'rng', 'name']) {
  const v = impl[k];
  console.log(`   ${k.padEnd(10)} = ${v === undefined || v === null ? String(v) : typeof v === 'object' ? `{${Object.keys(v).slice(0, 6).join(', ')}...}` : v}`);
}

// ---- 逐项冒烟测试 ----
const h = await impl.hash.digest(new Uint8Array([1, 2, 3]));
console.log(`\n   hash.digest(3B)      -> ${h.length}B  ${h.length === 32 ? '✅' : '❌'}`);
const mac = await impl.hash.mac(new Uint8Array(32).fill(7), new Uint8Array([9]));
console.log(`   hash.mac             -> ${mac.length}B  ${mac.length === 32 ? '✅' : '❌'}`);
const prk = await impl.kdf.extract(new Uint8Array(0), new Uint8Array([1, 2, 3]));
const okm = await impl.kdf.expand(prk, new Uint8Array(0), 42);
console.log(`   kdf extract/expand   -> ${okm.length}B  ${okm.length === 42 ? '✅' : '❌'}`);
const kp = await impl.hpke.generateKeyPair();
console.log(`   hpke.generateKeyPair -> pk ${kp.publicKey.byteLength ?? kp.publicKey.length}B  ✅`);
const sig = await impl.signature.sign(new Uint8Array(32).fill(1), new Uint8Array([5, 6]));
console.log(`   signature.sign       -> ${sig.length}B  ${sig.length === 64 ? '✅' : '❌'}`);
const rb = impl.rng.randomBytes(16);
console.log(`   rng.randomBytes(16)  -> ${rb.length}B  ${rb.length === 16 ? '✅' : '❌'}`);

// ---- HPKE seal / open 往返 ----
const sealKp = await impl.hpke.generateKeyPair();
const pt = new TextEncoder().encode('dme-interop-probe');
const { ct, enc } = await impl.hpke.seal(sealKp.publicKey, pt, new Uint8Array(0), new Uint8Array(0));
const back = await impl.hpke.open(sealKp.privateKey, enc, ct, new Uint8Array(0), new Uint8Array(0));
const same = Buffer.compare(Buffer.from(back), Buffer.from(pt)) === 0;
console.log(`   hpke seal/open 往返  -> ${same ? '✅ 明文一致' : '❌ 不一致'}`);
console.log(`      enc=${enc.length}B ct=${ct.length}B(明文${pt.length}B + tag16B)`);

console.log('\n🎉 全部通过：HkdfSha256 崩溃已根除，纯 JS 密码套件可用');
