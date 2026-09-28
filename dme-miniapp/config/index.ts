import { defineConfig, type UserConfigExport } from '@tarojs/cli';

/**
 * ts-mls 主入口会静态引入 @hpke/core（内部走 WebCrypto，小程序无此 API），
 * 并在「签名实现」里动态 import() 一批可选依赖（未安装，webpack 构建会报 Module not found）。
 *
 * 运行期我们从不执行这些路径（hpke 由 src/crypto/hpke-noble.ts 纯 JS 替换；
 * 签名由 src/crypto/mls-noble-kdf.ts 的 createNobleSignature() 静态纯 JS 提供），
 * 因此把以下模块 stub 成空模块：
 *   - @hpke/*            整族（WebCrypto 路径，死代码，顺带减包体）
 *   - @noble/post-quantum/*   ML-DSA 死分支（我们只用 Ed25519）
 *   - @noble/curves/ed448.js、nist.js  死分支
 *
 * ⚠️ 保留 @noble/curves/ed25519.js 的正常打包（签名由 mls-noble-kdf.ts 静态 import）。
 *
 * ⚠️ 代价：被 stub 的模块在运行期是 `undefined`。ts-mls 的
 *    `makeKdfImpl/makeDhKem/makeAead/makeHpke`（default/ 与 noble/ 都是同一份 default 实现）
 *    会执行 `new HkdfSha256()` / `new Aes128Gcm()` / `new CipherSuite()`。
 *    因此 **`nobleCryptoProvider` / `defaultCryptoProvider` / `getCiphersuiteImpl()`
 *    在整个项目里都不可用**，否则报
 *    `undefined is not a constructor (evaluating 'new Ys.HkdfSha256()')`。
 *    CiphersuiteImpl 必须由 `src/crypto/mls-noble-kdf.ts` 的 `getNobleMlsImpl()` 手工组装。
 */
const STUB_MODULES = [
  '@hpke/core',
  '@hpke/common',
  '@hpke/dhkem-x448',
  '@hpke/ml-kem',
  '@hpke/hybridkem-x-wing',
  '@hpke/chacha20poly1305',
  '@noble/post-quantum/ml-dsa.js',
  '@noble/post-quantum',
  '@noble/curves/ed448.js',
  '@noble/curves/nist.js',
];

export default defineConfig(async (merge) => {
  const baseConfig: UserConfigExport = {
    projectName: 'dme-miniapp',
    date: '2026-9-27',
    designWidth: 750,
    deviceRatio: {
      640: 2.34 / 2,
      750: 1,
      375: 2,
      828: 1.81 / 2,
    },
    sourceRoot: 'src',
    outputRoot: 'dist',
    plugins: [],
    defineConstants: {},
    copy: {
      patterns: [],
      options: {},
    },
    framework: 'react',
    compiler: 'webpack5',
    mini: {
      /** 加密栈体积大：主包只放 login/setup/settings/chat-list，聊天与扫码进 pkg-chat 分包 */
      optimizeMainPackage: {
        enable: true,
      },
      webpackChain(chain) {
        chain.resolve.alias.set('@', `${process.cwd()}/src`);
        // webpack 的 alias 允许 false（= 解析为空模块），但 webpack-chain 的类型签名只声明了 string，
        // 这里做一次窄化，语义与 `alias: { '@hpke/core': false }` 完全一致。
        const alias = chain.resolve.alias as unknown as {
          set(key: string, value: string | false): unknown;
        };
        for (const m of STUB_MODULES) {
          alias.set(m, false);
        }

        // 注意：产物 ES5 降级**不在这里做**。
        // Taro 的 webpackChain 回调执行时 optimization.minimizers 还是空的
        // （压缩器在更晚阶段注册），所以改 minimizer 无效。
        // 改用构建后独立过一遍 babel —— 见 scripts/deploy.mjs 的 es5 步骤。
      },
      miniCssExtractPluginOption: {
        ignoreOrder: true,
      },
    },
    h5: {},
  };

  if (process.env.NODE_ENV === 'development') {
    return merge({}, baseConfig, {});
  }
  return merge({}, baseConfig, {});
});
