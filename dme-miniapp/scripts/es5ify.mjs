/**
 * scripts/es5ify.mjs - 把 dist/ 产物的 JS 降级为小程序 CI 可接受的语法。
 *
 * 为什么需要这一步
 * ----------------
 * Taro 的 babel 只转译 `src/`，`node_modules` 里的第三方依赖（@noble/*、
 * ts-mls、weapp-qrcode-canvas-2d 等，均以 ESM / ES2020 分发）会被 webpack
 * 原样打进 `vendors.js`，残留 `?.`（可选链）、`??`（空值合并）等语法。
 *
 * `project.config.json` 的 `setting.es6` 只影响「微信开发者工具」，对
 * `miniprogram-ci` 上传**无效** —— CI 上传会在服务端做严格语法校验，
 * 遇到 ES6+ 语法直接拒绝：
 *
 *   -80057, invalid file: vendors.js, 1601:14
 *   SyntaxError: Unexpected token .
 *       i = e?.length,
 *
 * 又因为 Taro 的 `webpackChain` 回调执行时 `optimization.minimizers` 仍是
 * 空集合（压缩器在更晚阶段注册），无法通过改 terser 选项来降级。所以这里
 * 在构建完成后，对 `dist/**` 的 JS 独立跑一遍 babel → 与 Taro 内部实现解耦。
 *
 * 🔴 三条血泪约束（都是真机实测踩出来的，改动前务必读完）
 * ------------------------------------------------------------------
 * 1. **只处理真正需要降级的文件**（实测只有 `vendors.js`）。
 *    无差别跑 babel 会重写 `app.js`，打乱 Taro 期望的模块求值顺序
 *    （polyfill 须在加密库加载前注入全局）→ **启动白屏**。
 *
 * 2. **绝不能把 `**` 降级成 `Math.pow`**。
 *    `@noble/curves` 的 Ed25519 常量计算含 `Pe ** BigInt(254)` 这类
 *    **BigInt 幂运算**。babel 默认转成 `Math.pow(Pe, BigInt(254))`，
 *    而 `Math.pow` 是 Number 运算 —— 传 BigInt 会让小程序引擎在 native 层
 *    直接抛异常（真机堆栈：`pow@[native code]`），且该代码在模块顶层执行，
 *    导致**整页白屏**。BigInt 无法降级到 ES5，必须原样保留 `**`。
 *
 * 3. **探针只匹配 `?.` 和 `??`**。
 *    放宽到 `const/let`、箭头函数、模板串只会引入误判，把它们也重写一遍，
 *    风险远大于收益（这些 Taro 已处理，且 CI 不拒绝）。
 *
 * 用法
 * ----
 *   node scripts/es5ify.mjs [distDir]
 */

import { createRequire } from 'node:module';
import { readdir, readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';

const require = createRequire(import.meta.url);
const babel = require('@babel/core');

const DIST_DIR = path.resolve(process.argv[2] ?? 'dist');

/** 递归收集目录下所有 .js 文件。 */
async function collectJsFiles(dir) {
  const out = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await collectJsFiles(full)));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * ES2020+ 语法探针：用于判断某文件是否需要降级。
 *
 * 只检测 `?.` 与 `??` —— 这两者正是微信 CI 明确拒绝过的（-80057）。
 * 刻意**不**检测箭头函数、`const/let`、模板串等：它们由 Taro 自己的 babel
 * 处理（只转译 src/），产物里本就没有；放宽探针只会引入误判风险。
 */
function hasModernSyntax(code) {
  return /\?\./.test(code) || /\?\?/.test(code);
}

/**
 * 只降级「确实含 ES2020 语法」的文件。
 *
 * ⚠️ 关键教训（2026-09-28 实测踩坑）：
 * 早期版本对 dist/ 下所有 .js 无差别跑 babel，结果把 `app.js` 也重写了
 * （babel 注入 helpers、调整语句顺序），导致小程序启动白屏。
 *
 * 根因：Taro 产物对模块求值顺序有隐含要求 —— `app.js` 里的 polyfill 需要
 * 在 `vendors.js` 的加密库**被加载之前**装好 `crypto.getRandomValues` /
 * `TextEncoder`。babel 重写 `app.js` 会打乱这个顺序。
 *
 * 而实际上 Taro 的 babel **只转译 src/**，`vendors.js` 之外的产物本来就没有
 * ES2020 语法（实测 `?.` / `??` 仅出现在 vendors.js）。所以只处理 vendors.js
 * 即可，其余一律跳过 —— 最小干预原则。
 */
async function main() {
  try {
    await stat(DIST_DIR);
  } catch {
    console.error(`❌ 找不到目录：${DIST_DIR}`);
    process.exit(1);
  }

  const files = await collectJsFiles(DIST_DIR);
  let changed = 0;
  let untouched = 0;

  for (const file of files) {
    const original = await readFile(file, 'utf8');

    // 关键：只有真正含 ES2020 语法的文件才动，其余原样保留
    if (!hasModernSyntax(original)) {
      untouched += 1;
      continue;
    }

    const result = await babel.transformAsync(original, {
      // script 模式：不解析/不转换模块，保持 webpackJsonp 包装原样
      sourceType: 'script',
      // 顶层 exclude 是 pattern 匹配，babel 需要 filename 才能判定
      filename: file,
      compact: true,
      comments: false,
      babelrc: false,
      configFile: false,
      // ----------------------------------------------------------------------
      // ⚠️ 关键：禁止把 `**` 降级成 `Math.pow`
      //
      // @noble/curves 的 ed25519 常量计算里有 `Pe ** BigInt(254)` 这类
      // **BigInt 幂运算**。babel 默认会把 `**` 转成 `Math.pow(a, b)`，而
      // Math.pow 是 Number 运算 —— 传入 BigInt 会让小程序引擎在 native 层
      // 直接抛异常（真机堆栈表现为 `pow@[native code]`），且发生在模块顶层，
      // 导致**整页白屏**。
      //
      // BigInt 本身无法降级到 ES5，所以这段语法必须原样保留。小程序基础库
      // 3.3.4（project.config.json 的 libVersion）完全支持 BigInt 与 `**`，
      // 微信 CI 的语法校验也不拒绝 `**`（它拒绝的是 `?.` / `??`）。
      // ----------------------------------------------------------------------
      exclude: [/node_modules[\\/]@babel[\\/]plugin-transform-exponentiation-operator/],
      presets: [
        [
          require.resolve('@babel/preset-env'),
          {
            // 目标 ES5：小程序 CI 校验器不认识 `?.` / `??`
            targets: { ie: '11' },
            // 不转换模块（保持 wx.webpackJsonp 包装，不生成 require 调用）
            modules: false,
            // 只补语法，不注入 polyfill（小程序无 window/document）
            useBuiltIns: false,
            bugfixes: true,
            exclude: [
              // 见上方注释：必须保留 BigInt 幂运算原语法
              '@babel/plugin-transform-exponentiation-operator',
            ],
          },
        ],
      ],
    });

    if (!result?.code) {
      console.warn(`⚠️  ${path.relative(DIST_DIR, file)} 转译无输出，跳过`);
      continue;
    }

    await writeFile(file, result.code, 'utf8');
    changed += 1;
    console.log(`   ↓ 已降级：${path.relative(DIST_DIR, file)}`);
  }

  console.log(
    `✅ ES5 降级完成：降级 ${changed} 个文件，原样保留 ${untouched} 个（无 ES2020 语法）`,
  );
}

main().catch((err) => {
  console.error('❌ ES5 降级失败：', err);
  process.exit(1);
});
