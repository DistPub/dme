/**
 * polyfills/index.ts - 统一安装全局 polyfill。
 *
 * 必须在任何 crypto / ts-mls / @noble 代码之前执行（见 app.ts 首行 import）。
 * 本模块只做三件事：UTF-8/base64、crypto.getRandomValues、启动随机池预取。
 * 绝不创建 crypto.subtle（原因见 random.ts 顶部注释）。
 */
import { installEncodingPolyfills } from './encoding';
import { installRandomPolyfill } from './random';

let installed = false;

export function installPolyfills(): void {
  if (installed) return;
  installed = true;
  installEncodingPolyfills();
  installRandomPolyfill();
}

installPolyfills();

export * from './encoding';
export * from './random';
