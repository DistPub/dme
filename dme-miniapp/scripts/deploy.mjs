#!/usr/bin/env node
/**
 * scripts/deploy.mjs - 小程序构建 + 上传（miniprogram-ci）。
 *
 * 用法：
 *   1) 一次性初始化（写入 AppID 到根 project.config.json）
 *      node scripts/deploy.mjs init <appid>
 *
 *   2) 构建（等价 npm run build:weapp）
 *      node scripts/deploy.mjs build
 *
 *   3) 构建 + 上传体验版（需先在微信公众平台配置好上传密钥）
 *      node scripts/deploy.mjs upload --key ./private.key --desc "首次联调"
 *
 *   4) 只上传（不重新构建）
 *      node scripts/deploy.mjs upload --skip-build
 *
 * 上传私钥获取方式：
 *   微信公众平台 → 开发管理 → 开发设置 → 小程序代码上传 → 生成密钥 → 下载
 *   ⚠️ 私钥文件不要提交到版本库（已在 .gitignore 排除 *.key）
 *
 * CI 环境可用环境变量代替参数：
 *   MP_APPID        小程序 AppID
 *   MP_PRIVATE_KEY  私钥文件路径
 *   MP_VERSION      版本号（默认读 package.json version）
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const PROJECT_CONFIG = resolve(ROOT, 'project.config.json');
const DIST = resolve(ROOT, 'dist');
const PKG = resolve(ROOT, 'package.json');

/** 读取根 project.config.json。 */
function readProjectConfig() {
  return JSON.parse(readFileSync(PROJECT_CONFIG, 'utf8'));
}

/** 写回根 project.config.json（保持 2 空格缩进）。 */
function writeProjectConfig(cfg) {
  writeFileSync(PROJECT_CONFIG, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
}

/** 从命令行取 `--key value` 形式的参数。 */
function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = process.argv[i + 1];
  return next && !next.startsWith('--') ? next : true;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function run(cmd, env = {}) {
  console.log(`\n$ ${cmd}\n`);
  execSync(cmd, {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, ...env },
  });
}

// ---------------------------------------------------------------------------
// init：把 AppID 写进 project.config.json
// ---------------------------------------------------------------------------
function cmdInit(appid) {
  if (!appid || appid === true) {
    console.error('❌ 用法：node scripts/deploy.mjs init <appid>');
    console.error('   AppID 形如 wx1234567890abcdef，在微信公众平台 → 开发管理 → 开发设置 查看');
    process.exit(1);
  }
  if (!/^wx[0-9a-f]{16}$/i.test(appid) && !appid.startsWith('touristappid')) {
    console.warn(`⚠️  AppID "${appid}" 格式不像标准小程序 AppID（期望 wx + 16 位十六进制）`);
    console.warn('   如果你用的是「测试号」，AppID 会是 wx 开头的一串字符，可继续。');
  }
  const cfg = readProjectConfig();
  cfg.appid = appid;
  writeProjectConfig(cfg);
  console.log(`✅ 已写入 AppID: ${appid}`);
  console.log('   位置：project.config.json → appid');
  console.log('   下一步：node scripts/deploy.mjs build');
}

// ---------------------------------------------------------------------------
// build：调用 Taro 构建
// ---------------------------------------------------------------------------
function cmdBuild() {
  const cfg = readProjectConfig();
  if (!cfg.appid) {
    console.warn('⚠️  project.config.json 的 appid 为空。');
    console.warn('   本地预览仍可在开发者工具里用「测试号」打开，但上传体验版必须填 AppID。');
    console.warn('   填写方式：node scripts/deploy.mjs init <appid>\n');
  }
  run('npx taro build --type weapp');
  if (!existsSync(resolve(DIST, 'app.json'))) {
    console.error('❌ dist/app.json 不存在，构建可能失败');
    process.exit(1);
  }

  // 产物 ES5 降级：node_modules 里的第三方依赖会残留 ?. / ?? 等语法，
  // miniprogram-ci 上传时会被服务端校验拒绝（-80057 invalid file）。
  run('node scripts/es5ify.mjs');
  verifyNoModernSyntax();

  // 死代码剔除：ts-mls 主入口静态 re-export 了 noble/default 两个 crypto provider，
  // 它们内部会 `new HkdfSha256()`（@hpke/core 已被 alias 成 false → 真机崩溃）。
  // 本项目从不调用它们，但 webpack 对 ts-mls 的 CJS 产物无法 tree-shake。
  // 构建后按符号定名清掉，语义不变（仍绝不执行 @hpke 路径）。
  // ⚠️ 必须在 verifyCryptoWiring() **之前**跑，否则自检会拦下这坨死代码。
  run('node scripts/strip-hpke-dead-code.mjs');
  verifyCryptoWiring();

  // 全局占位注入：@noble 在模块求值时就固化 globalThis.crypto 引用，
  // 而 vendors.js 早于 app.js 模块体执行 —— 必须先放占位。
  run('node scripts/inject-polyfills.mjs');

  console.log('\n✅ 构建完成（已 ES5 降级 + 语法/加密自检 + 注入全局占位），产物在 dist/');
  console.log('   建议再跑一次端到端冒烟：node scripts/verify-artifact.mjs');
}

/**
 * 构建后自检：加密栈必须是「纯 JS 装配」，不得把 @hpke 的类拖进产物。
 *
 * 背景：`config/index.ts` 把 `@hpke/*` alias 成 false。ts-mls 的
 * `noble/makeKdfImpl.js` / `makeDhKem.js` / `makeAead.js` / `makeHpke.js`
 * 全是 `export * from "../default/....js"`，default 版第一行就
 * `import { HkdfSha256 } from "@hpke/core"`，`new HkdfSha256()` → undefined。
 * 真机表现为启动/轮询期崩溃：
 *   TypeError: undefined is not a constructor (evaluating 'new Ys.HkdfSha256()')
 *
 * 判定「真的会崩」的充分条件（三者任一命中即 fail）：
 *   1. `HkdfSha256` / `HkdfSha384` / `HkdfSha512` 类名
 *      —— @hpke/core 独有，出现即说明该族被拖进产物；
 *   2. `@hpke/core` 命名空间成员访问（`X.HkdfSha256(` 这类）；
 *   3. 显式 `new HkdfSha256(` 形态。
 *
 * ⚠️ 不能只 grep 裸字符串 `HKDF-SHA256`：ts-mls 的 cipher-suite 元数据表
 *    （`var Re={1:{hash:"SHA-256",hpke:{kem:"DHKEM-X25519-HKDF-SHA256",kdf:"HKDF-SHA256"},…}}`）
 *    是**纯字符串字面量**，用来做 suite name ↔ id 映射，不 `new` 任何东西。
 *    把它算成违规会造成永远无法通过的自检。
 */
function verifyCryptoWiring() {
  const offenders = [];
  /** 真·@hpke 类的构造/成员访问（只查 `Hkdf*`；`Dhkem*`/`Aes*` 已由剔除脚本清零）。 */
  const HPKE_CONSTRUCT = /\bnew\s+[_$a-zA-Z][_$a-zA-Z0-9]*\.?HkdfSha(?:256|384|512)\b|\.HkdfSha(?:256|384|512)\b|\bHkdfSha(?:256|384|512)\b/;

  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.js')) {
        const code = readFileSync(full, 'utf8');
        const rel = full.replace(ROOT + '/', '');
        const hits = [];
        if (HPKE_CONSTRUCT.test(code)) hits.push('HkdfSha* 类名 / 成员访问');
        if (hits.length > 0) offenders.push(`${rel}: ${hits.join(' / ')}`);
      }
    }
  };
  walk(DIST);

  if (offenders.length > 0) {
    console.error('\n❌ 产物里出现了 @hpke 派生的 KDF 代码 —— 真机将崩溃！');
    for (const line of offenders) console.error('   ' + line);
    console.error('\n   报错原文：TypeError: undefined is not a constructor');
    console.error("             (evaluating 'new Ys.HkdfSha256()')");
    console.error('   原因：@hpke/* 被 alias 成 false，而 ts-mls 的 noble 分支只是');
    console.error('   re-export default 分支，后者的 new HkdfSha256() 是同步求值的。');
    console.error('   修复：①CiphersuiteImpl 必须由 src/crypto/mls-noble-kdf.ts 的');
    console.error('   getNobleMlsImpl() 手工纯 JS 组装；②构建末段必须有');
    console.error('   scripts/strip-hpke-dead-code.mjs 剔除 ts-mls 主入口的死 provider。');
    process.exit(1);
  }
  console.log('🔍 加密自检通过：产物中无 @hpke 派生的 KDF 类（HkdfSha256/384/512 均为 0）');
}

/**
 * 构建后自检：产物里不允许残留 ES2020+ 语法，也不允许出现
 * 「Math.pow 接收 BigInt」这种会让真机 native 崩溃的降级错误。
 */
function verifyNoModernSyntax() {
  const bad = [];
  const powBigint = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.js')) {
        const code = readFileSync(full, 'utf8');
        const rel = full.replace(ROOT + '/', '');
        const optChain = (code.match(/\?\./g) ?? []).length;
        const nullish = (code.match(/\?\?/g) ?? []).length;
        if (optChain > 0 || nullish > 0) {
          bad.push(`${rel}: ?.=${optChain} ??=${nullish}`);
        }
        // Math.pow(x, BigInt(...)) / Math.pow(x, 123n) → 真机 native 崩溃
        const m = code.match(/Math\.pow\([^)]*,\s*(?:BigInt\(|\d+n)/g);
        if (m && m.length > 0) {
          powBigint.push(`${rel}: ${m.length} 处（如 ${m[0].slice(0, 50)}）`);
        }
      }
    }
  };
  walk(DIST);

  let failed = false;

  if (bad.length > 0) {
    console.error('\n❌ 产物中仍残留 ES2020 语法，上传会被微信拒绝：');
    for (const line of bad) console.error('   ' + line);
    console.error('\n   修复：确认 scripts/es5ify.mjs 正常执行（见其文件头注释）。');
    failed = true;
  }

  if (powBigint.length > 0) {
    console.error('\n❌ 产物中 Math.pow 收到了 BigInt —— 真机会白屏！');
    for (const line of powBigint) console.error('   ' + line);
    console.error('\n   原因：`**` 被 babel 降级成 Math.pow，而 BigInt 幂运算无法用');
    console.error('   Number 运算表达。修复：es5ify.mjs 已 exclude');
    console.error('   @babel/plugin-transform-exponentiation-operator，请检查是否被改回。');
    failed = true;
  }

  if (failed) process.exit(1);
  console.log('🔍 语法自检通过：无 ?. / ?? 残留，且未出现 Math.pow(BigInt)');
}

// ---------------------------------------------------------------------------
// upload：miniprogram-ci 上传体验版
// ---------------------------------------------------------------------------
async function cmdUpload() {
  const cfg = readProjectConfig();
  const appid = process.env.MP_APPID || cfg.appid;
  if (!appid) {
    console.error('❌ 缺少 AppID。先执行：node scripts/deploy.mjs init <appid>');
    console.error('   或设置环境变量 MP_APPID=<appid>');
    process.exit(1);
  }

  const keyArg = arg('key', process.env.MP_PRIVATE_KEY);
  if (!keyArg || keyArg === true) {
    console.error('❌ 缺少上传私钥。用法：node scripts/deploy.mjs upload --key ./private.key');
    console.error('   获取：微信公众平台 → 开发管理 → 开发设置 → 小程序代码上传 → 生成密钥');
    process.exit(1);
  }
  const keyPath = isAbsolute(keyArg) ? keyArg : resolve(ROOT, keyArg);
  if (!existsSync(keyPath)) {
    console.error(`❌ 私钥文件不存在：${keyPath}`);
    process.exit(1);
  }

  if (!hasFlag('skip-build')) {
    cmdBuild();
  } else if (!existsSync(resolve(DIST, 'app.json'))) {
    console.error('❌ dist/ 无产物，不能 --skip-build。请先构建。');
    process.exit(1);
  }

  const version = String(arg('version', process.env.MP_VERSION ?? JSON.parse(readFileSync(PKG, 'utf8')).version));
  const desc = String(arg('desc', `DME 小程序 ${version}`));

  // miniprogram-ci 是 CJS 包：具名导出在模块顶层（无 default）。
  // ESM 动态 import 时 CJS 的具名导出可能落在 `.default` 上，这里两种都兼容。
  let ci;
  try {
    const mod = await import('miniprogram-ci');
    ci = mod?.Project ? mod : (mod?.default ?? mod);
  } catch {
    console.error('❌ 未安装 miniprogram-ci。请执行：');
    console.error('   npm i -D miniprogram-ci');
    process.exit(1);
  }
  if (typeof ci?.Project !== 'function' || typeof ci?.upload !== 'function') {
    console.error('❌ miniprogram-ci 导出结构异常，缺少 Project / upload');
    console.error('   实际导出：', Object.keys(ci ?? {}).slice(0, 12).join(', '));
    process.exit(1);
  }

  const project = new ci.Project({
    appid,
    type: 'miniProgram',
    projectPath: DIST,
    privateKeyPath: keyPath,
    ignores: ['node_modules/**/*', '*.LICENSE.txt'],
  });

  // 启动页面：显式指定，避免依赖后台「体验版路径」输入框（填错格式会导致
  // 扫码进入时提示「页面不存在」）。格式为 app.json 里的相对路径、不带前导
  // 斜杠、不带 .html —— 与 app.json pages 数组首项一致。
  const entryPage = String(arg('entry', 'pages/login/index'));
  if (entryPage.startsWith('/') || entryPage.endsWith('/') || entryPage.endsWith('.html')) {
    console.error(`❌ --entry 格式错误："${entryPage}"`);
    console.error('   正确示例：pages/login/index');
    console.error('   不要以 / 开头或结尾，也不要带 .html');
    process.exit(1);
  }

  console.log(`\n📦 上传中：appid=${appid} version=${version}`);
  console.log(`   描述：${desc}`);
  console.log(`   启动页：${entryPage}`);

  const result = await ci.upload({
    project,
    version,
    desc,
    // 显式指定扫码进入时的启动页。注意不带前导斜杠。
    pagePath: entryPage,
    setting: { es6: false, minify: false, urlCheck: false },
    onProgressUpdate: (p) => {
      if (typeof p === 'string') return;
      if (p._msg) process.stdout.write(`\r   ${p._msg}                    `);
    },
  });

  console.log('\n\n✅ 上传成功');
  console.log(`   版本：${version}`);
  console.log(`   启动页：${entryPage}`);
  if (result?.subPackageInfo) {
    console.log('   分包信息：', JSON.stringify(result.subPackageInfo, null, 2));
  }
  console.log('\n下一步：微信公众平台 → 版本管理 → 将刚上传的版本设为「体验版」');
  console.log('       然后在「成员管理」里把测试人员加为体验成员，即可扫码真机测试。');
  console.log('\n⚠️  若扫码仍提示「页面不存在」，去后台把「体验版路径」清空，');
  console.log(`   或改成完全一致的值：${entryPage}`);
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
const cmd = process.argv[2];

switch (cmd) {
  case 'init':
    cmdInit(process.argv[3]);
    break;
  case 'build':
    cmdBuild();
    break;
  case 'upload':
    await cmdUpload();
    break;
  default:
    console.log(`dme-miniapp 部署脚本

用法：
  node scripts/deploy.mjs init <appid>      写入 AppID 到 project.config.json
  node scripts/deploy.mjs build             构建（taro build --type weapp）
  node scripts/deploy.mjs upload --key ./private.key [--desc "说明"] [--skip-build]

环境变量（可替代参数）：
  MP_APPID  MP_PRIVATE_KEY  MP_VERSION

上传前置条件：
  1. 已注册小程序账号并拿到 AppID
  2. 微信公众平台 → 开发管理 → 开发设置 → 小程序代码上传 → 生成并下载私钥
  3. npm i -D miniprogram-ci
  4. 真机联调前需配置 request 合法域名（见 AGENTS.md §已知环境坑 5）
`);
    process.exit(cmd ? 1 : 0);
}
