/**
 * scripts/strip-hpke-dead-code.mjs - 从产物里剔除 @hpke 死代码。
 *
 * 🔴 问题：ts-mls 主入口**静态** re-export 了 noble/default 两个 crypto provider
 * ------------------------------------------------------------------
 * `ts-mls/dist/src/index.js` 里有两行：
 *
 *     export { nobleCryptoProvider }   from "./crypto/implementation/noble/provider.js";
 *     export { defaultCryptoProvider } from "./crypto/implementation/default/provider.js";
 *
 * 这两个 provider 的实现链最终会走到 `@hpke/core` 的 `HkdfSha256` /
 * `DhkemX25519HkdfSha256` / `Aes128Gcm`（noble 版的 makeKdfImpl/makeDhKem/makeAead
 * **也只是** `export * from "../default/....js"`，并没有自己的纯 JS 实现）。
 *
 * `config/index.ts` 已经把 `@hpke/*` alias 成 `false`（空模块），
 * 所以这些 `new` 在真机上必然抛：
 *
 *     TypeError: undefined is not a constructor (evaluating 'new Ys.HkdfSha256()')
 *
 * 本项目**从不调用**这两个 provider（CiphersuiteImpl 由
 * `src/crypto/mls-noble-kdf.ts` 的 `getNobleMlsImpl()` 手工纯 JS 组装），
 * 但 webpack 无法做 tree-shaking：ts-mls 是 CJS 风格的 `exports.xxx =` 编译产物，
 * sideEffects 无法证明为 false，于是这坨死代码被**原样打进** vendors.js。
 *
 * 💡 解决思路：构建设置保持不动（alias 仍为 false，语义完全一致），
 *    只在**构建后**把这段死代码从产物里清掉，再让 verifyCryptoWiring() 把关。
 *    这样既保住「真机上绝不会执行到 @hpke 路径」这一硬约束，
 *    又消除了自检误报（自检本身是必要的 —— 它挡住的是"有人把 provider 调回来"）。
 *
 * 处理手段（全部是**按名字定位、精确小替换**，不做大段区间删除）：
 *
 *   1. 定位 ts-mls 主入口模块（同时含 `nobleCryptoProvider:function` 与
 *      `defaultCryptoProvider:function` 的指纹）。
 *   2. 剔掉 `n.d(t,{...})` 里这两个 provider 的 re-export 条目
 *      —— 从此产物里**再也无法引用**这两个入口。
 *   3. `makeKdf`（`function Sc(e){switch(e){case"HKDF-SHA256":...}}`）
 *      函数体换成 `{return;}`。
 *   4. `makeAead` / `makeDhKem` / `makeHpke`（三个 `_asyncToGenerator` 形态的
 *      巨型 async 函数）函数体换成 `{return Promise.resolve();}`
 *      —— 它们内部就是 `new wc.Aes128Gcm()` / `new wc.Dhkem...()`。
 *   5. 删掉 `@hpke/core` 命名空间绑定 `var wc=n(8224)`。
 *   6. **保险**：剩下的裸 `wc.` 引用统一改成 `void 0`，保证产物里
 *      一个 `HkdfSha256` / `HKDF-SHA256` 都不剩；即时语法合法、运行即抛
 *      （但调用方已随 3/4 清空，永不触达）。
 *
 * 为什么不让 webpack 直接不打包这两个 export？
 *   - `optimization.usedExports` / `sideEffects:false` 对 CJS 产物无效；
 *   - 改 ts-mls 主入口需要 patch node_modules，升级依赖后会丢；
 *   - 构建后处理是**唯一**同时满足「不改依赖、不改构建语义、可回归验证」的点。
 *
 * 幂等：处理过的文件会被打上 MARKER，重复运行直接跳过。
 *
 * 用法
 * ----
 *   node scripts/strip-hpke-dead-code.mjs [distDir]
 */

import { readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const DIST_DIR = path.resolve(process.argv[2] ?? 'dist');
const MARKER = '/* dme-hpke-dead-code-stripped */';

/** ts-mls 主入口模块的指纹：两个 provider 的 re-export 同时在场。 */
const MODULE_FINGERPRINTS = [
  'nobleCryptoProvider:function nobleCryptoProvider()',
  'defaultCryptoProvider:function defaultCryptoProvider()',
];

/** `n.d(t,{ NAME:function NAME(){return X;}, ... })` 单条目的形态。 */
function reExportEntry(name) {
  const id = '[_$a-zA-Z0-9]+';
  return new RegExp(
    String.raw`${name}:function\s+${name}\s*\(\)\s*\{\s*return\s+${id}\s*;\s*\},?`,
    'g',
  );
}

/**
 * 把 `function _NAME(){_NAME=_asyncToGenerator(...)}` 这种
 * 「一次性自替换 + 生成器」形态函数的**函数体**清空。
 *
 * 这类函数由 babel 从 `async function` 降级而来，形态固定为：
 *
 *     function _x(){ _x = _asyncToGenerator(_regenerator().m(function _callee(e){
 *        ... while(1)switch(...){ ... }
 *     }, null, [[...]])); return _x.apply(this, arguments); }
 *
 * 用「定名 + 括号配平」定位函数体，只有体内出现 `@hpke` 成员访问
 * （`Aes128Gcm` / `Dhkem...` / `CipherSuite` / `HKDF-SHA256`）才处理。
 *
 * @param {string} src
 * @param {(body: string) => boolean} predicate 判定「这个函数体是否属于要清空的目标」
 */
function neutralizeAsyncFactory(src, predicate) {
  const removed = [];
  let out = src;
  let searchFrom = 0;
  const SIG = /function\s+([_$a-zA-Z0-9]+)\s*\(\s*\)\s*\{/g;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    SIG.lastIndex = searchFrom;
    const m = SIG.exec(out);
    if (!m) break;

    const bodyStart = m.index + m[0].length - 1; // 指向 `{`
    const bodyEnd = matchBrace(out, bodyStart);
    if (bodyEnd < 0) {
      searchFrom = m.index + m[0].length;
      continue;
    }

    const body = out.slice(bodyStart, bodyEnd + 1);
    // 只处理「自替换」形态：函数体里自己给自己赋值 —— 这是 babel async 降级的标志，
    // 避免误伤普通的同步函数。
    const isSelfReplacing = new RegExp(String.raw`\b${m[1]}\s*=`).test(body);
    if (!isSelfReplacing || !predicate(body)) {
      searchFrom = bodyStart + 1;
      continue;
    }

    out = out.slice(0, bodyStart) + '{return Promise.resolve();}' + out.slice(bodyEnd + 1);
    removed.push(m[1]);
    searchFrom = bodyStart + '{return Promise.resolve();}'.length;
  }

  return { code: out, removed };
}

/** 从 `open`（指向 `{`）开始做括号配平，返回匹配 `}` 的下标；失败返回 -1。 */
function matchBrace(src, open) {
  if (src[open] !== '{') return -1;
  let depth = 0;
  let inStr = null;
  let inLine = false;
  let inBlock = false;
  let inRegex = false;
  let prev = '';
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    const n = src[i + 1];

    if (inLine) {
      if (c === '\n') inLine = false;
      continue;
    }
    if (inBlock) {
      if (c === '*' && n === '/') {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inStr) {
      if (c === '\\') {
        i++;
        continue;
      }
      if (c === inStr) inStr = null;
      continue;
    }
    if (inRegex) {
      if (c === '\\') {
        i++;
        continue;
      }
      if (c === '[') {
        while (i < src.length && src[i] !== ']') {
          if (src[i] === '\\') i++;
          i++;
        }
        continue;
      }
      if (c === '/') inRegex = false;
      continue;
    }

    if (c === '/' && n === '/') {
      inLine = true;
      i++;
      continue;
    }
    if (c === '/' && n === '*') {
      inBlock = true;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      inStr = c;
      continue;
    }
    // 正则字面量：`/` 出现在「非标识符/非右括号」之后视为正则起始。
    if (c === '/' && !/[)\]}$_\w]/.test(prev)) {
      inRegex = true;
      continue;
    }

    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return i;
    }
    if (!/\s/.test(c)) prev = c;
  }
  return -1;
}

/**
 * 从工厂函数体里**就地**取出它创建的 `@hpke/core` 命名空间变量，并顺手记录该绑定。
 *
 * 目标体形如：
 *     { var x,y,z; return _regenerator().w(function(){... new wc.Aes128Gcm() ...}) }
 * 或
 *     { _t=a; return n.e(48).then(...); ... throw new N("...@hpke/chacha20poly1305...") }
 *
 * 这里不做解析，只做「该体是否引用了 @hpke 成员」的判定；命名空间变量统一
 * 由 {@link stripHpkeNamespace} 处理。
 */
const HPKE_MEMBER_RE =
  /\b([_$a-zA-Z][_$a-zA-Z0-9]*)\.(HkdfSha256|HkdfSha384|HkdfSha512|Aes128Gcm|Aes256Gcm|CipherSuite|DhkemP256HkdfSha256|DhkemX25519HkdfSha256|DhkemP521HkdfSha512|DhkemP384HkdfSha384|Chacha20Poly1305|MlKem512|MlKem768|MlKem1024)\b/;

/** `var X = n(<digits>);` —— webpack 内部模块绑定。 */
const VAR_FROM_MODULE_RE = /var\s+([_$a-zA-Z0-9]+)\s*=\s*n\((\d+)\);/g;

/**
 * 删除 `@hpke/core` 命名空间绑定。
 *
 * 判定：该变量在模块里**只**用于上面的 @hpke 成员访问（允许若干次），
 * 且绑定语句是 `var X = n(<digits>);`。两者同时满足才删，
 * 避免误删正常使用的内部模块引用。
 */
function stripHpkeNamespace(mod) {
  const removed = [];
  let out = mod;

  const candidates = [];
  VAR_FROM_MODULE_RE.lastIndex = 0;
  let m;
  while ((m = VAR_FROM_MODULE_RE.exec(mod)) !== null) {
    candidates.push({ name: m[1], index: m.index, full: m[0] });
  }

  for (const cand of candidates) {
    const memberUses = new RegExp(
      String.raw`\b${cand.name}\.(?:HkdfSha256|HkdfSha384|HkdfSha512|Aes128Gcm|Aes256Gcm|CipherSuite|Dhkem[_$a-zA-Z0-9]*|Chacha20Poly1305|MlKem[_$a-zA-Z0-9]*)`,
      'g',
    );
    const memberCount = (out.match(memberUses) ?? []).length;
    if (memberCount === 0) continue;

    const totalRe = new RegExp(String.raw`\b${cand.name}\b`, 'g');
    const total = (out.match(totalRe) ?? []).length;
    // 绑定自身占 1 次；其余必须**全部**是 @hpke 成员访问。
    if (total - 1 !== memberCount) continue;

    out = out.replace(cand.full, '');
    removed.push(cand.full);
  }

  // 保险：把残留的 `X.成员` 统一替换成 `void 0`（X 已解绑时才会走到这里）。
  out = out.replace(
    /\b[_$a-zA-Z][_$a-zA-Z0-9]*\.(?:HkdfSha256|HkdfSha384|HkdfSha512|Aes128Gcm|Aes256Gcm|CipherSuite|DhkemP256HkdfSha256|DhkemX25519HkdfSha256|DhkemP521HkdfSha512|DhkemP384HkdfSha384|Chacha20Poly1305)\b/g,
    'void 0',
  );

  return { code: out, removed };
}

/** 在 ts-mls 主入口模块里剔除两个 provider 的 re-export 条目。 */
function stripProviderReExports(mod) {
  const removed = [];
  let out = mod;
  for (const name of ['nobleCryptoProvider', 'defaultCryptoProvider']) {
    const re = reExportEntry(name);
    if (re.test(out)) {
      re.lastIndex = 0;
      out = out.replace(re, '');
      removed.push(name);
    }
  }
  return { code: out, removed };
}

/** 把 `function Sc(e){switch(e){case"HKDF-SHA256":...}}` 的函数体清空。 */
function neutralizeMakeKdf(mod) {
  const removed = [];
  let out = mod;
  let searchFrom = 0;
  const SIG = /function\s+([_$a-zA-Z0-9]+)\s*\(\s*[_$a-zA-Z0-9]+\s*\)\s*\{/g;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    SIG.lastIndex = searchFrom;
    const m = SIG.exec(out);
    if (!m) break;

    const bodyStart = m.index + m[0].length - 1;
    const bodyEnd = matchBrace(out, bodyStart);
    if (bodyEnd < 0) {
      searchFrom = m.index + m[0].length;
      continue;
    }

    const body = out.slice(bodyStart, bodyEnd + 1);
    const isMakeKdf = body.includes('"HKDF-SHA256"') || body.includes("'HKDF-SHA256'");
    if (!isMakeKdf) {
      searchFrom = m.index + m[0].length;
      continue;
    }

    out = out.slice(0, bodyStart) + '{return;}' + out.slice(bodyEnd + 1);
    removed.push(m[1]);
    searchFrom = bodyStart + '{return;}'.length;
  }

  return { code: out, removed };
}

/** 一个文件是否已经是 ts-mls 主入口所在 chunk。 */
function isTsMlsEntry(src) {
  return MODULE_FINGERPRINTS.every((f) => src.includes(f));
}

async function main() {
  const entries = await readdir(DIST_DIR, { withFileTypes: true });
  const jsFiles = entries.filter((e) => e.isFile() && e.name.endsWith('.js'));

  let totalSaved = 0;
  const report = [];

  for (const entry of jsFiles) {
    const full = path.join(DIST_DIR, entry.name);
    let src = await readFile(full, 'utf8');

    if (src.includes(MARKER)) continue;
    if (!isTsMlsEntry(src)) continue;

    const before = src.length;
    const steps = [];

    // 1) 踢掉 noble/default provider 的 re-export 入口
    let r = stripProviderReExports(src);
    src = r.code;
    steps.push(...r.removed.map((x) => `n.d() 条目 ${x}`));

    // 2) 清空 makeKdf
    r = neutralizeMakeKdf(src);
    src = r.code;
    if (r.removed.length) steps.push(`makeKdf(${r.removed.join(',')}) → return;`);

    // 3) 清空 makeAead / makeDhKem / makeHpke / makeSignature（babel async 工厂形态）
    //
    //    前三个体内是 `new wc.Aes128Gcm()` / `new wc.Dhkem*()`（@hpke/core）；
    //    makeSignature 体内是 `await import("@noble/curves/ed25519.js")` 的
    //    可选依赖分支（未安装 → webpack 拆成 n.e() 懒加载 chunk，真机 loadChunk
    //    失败）。本项目签名由 createNobleSignature() 静态纯 JS 提供，同样不调用。
    r = neutralizeAsyncFactory(
      src,
      (body) =>
        HPKE_MEMBER_RE.test(body) ||
        /Optional dependency/.test(body) ||
        /@noble\/curves/.test(body),
    );
    src = r.code;
    if (r.removed.length) steps.push(`@hpke/@noble 死工厂清零(${r.removed.join(',')})`);

    // 4) 解绑 @hpke/core 命名空间 + 兜底替换残留成员访问
    r = stripHpkeNamespace(src);
    src = r.code;
    steps.push(...r.removed.map((x) => `命名空间解绑 ${x}`));

    if (steps.length === 0) continue;

    src += `\n${MARKER}\n`;
    await writeFile(full, src, 'utf8');

    const saved = before - src.length;
    totalSaved += saved;
    report.push(`   ${entry.name}: ${steps.join(' | ')}（-${saved}B）`);
  }

  if (report.length === 0) {
    console.log('ℹ️  未发现 @hpke 死代码（已处理过，或产物结构变化）。');
    return;
  }

  console.log('🧹 已剔除 @hpke 死代码路径：');
  for (const line of report) console.log(line);
  console.log(`   合计释放 ${totalSaved} 字节`);
}

main().catch((err) => {
  console.error('❌ 剔除 @hpke 死代码失败：', err);
  process.exit(1);
});
