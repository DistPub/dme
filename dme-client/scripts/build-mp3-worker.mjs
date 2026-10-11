/**
 * build-mp3-worker.mjs — 生成 web 端 MP3 录音所需的静态资源。
 *
 * mp3-mediarecorder 需要一个 Web Worker + vmsg.wasm（LAME 编码）才能把
 * PCM 编码成 MP3。其 worker 模块（`mp3-mediarecorder/worker`）是自包含的
 * （无外部 import），因此这里把它抽成静态文件，避免 Metro 对 Worker 的
 * 打包支持问题；wasm 也作为静态资源随 public/ 一起部署（离线 SW 可命中）。
 *
 * 产物：
 *   public/mp3-recorder-worker.js   经典 Worker（已去掉 ESM 的 export，并在尾部
 *                                   调用 initMp3MediaEncoder 指到 /vmsg.wasm）
 *   public/vmsg.wasm                LAME MP3 编码 wasm（~150KB）
 *
 * 运行：bun run scripts/build-mp3-worker.mjs
 * 时机：依赖安装后、web 构建前（dev 与 build 都需要）。
 */

import { readFileSync, writeFileSync, copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const workerSrc = resolve(root, 'node_modules/mp3-mediarecorder/worker/index.es5.js');
const wasmSrc = resolve(root, 'node_modules/mp3-mediarecorder/dist/vmsg.wasm');

const publicDir = resolve(root, 'public');
if (!existsSync(publicDir)) mkdirSync(publicDir, { recursive: true });

const workerOut = resolve(publicDir, 'mp3-recorder-worker.js');
const wasmOut = resolve(publicDir, 'vmsg.wasm');

// --- worker：去掉末尾 ESM export，追加 init 调用 ----------------------------
let code = readFileSync(workerSrc, 'utf8');
// 尾部形如 `};export{initMp3MediaEncoder};`，去掉 export 语句保留函数定义。
code = code.replace(/export\s*\{[^}]*initMp3MediaEncoder[^}]*\}\s*;?\s*$/, '');
// 防御：若上面没匹配到（不同版本），再做一次通用 export 清理。
if (/export\s*\{/.test(code.trimEnd().slice(-40))) {
  code = code.replace(/export\s*\{[^}]*\}\s*;?\s*$/, '');
}
const wasmUrlExpr = "new URL('/vmsg.wasm', self.location.href).href";
const appended = `\n// 由 scripts/build-mp3-worker.mjs 注入：启动 MP3 编码器（wasm 同源托管）。\ninitMp3MediaEncoder({ vmsgWasmUrl: ${wasmUrlExpr} });\n`;
writeFileSync(workerOut, code + appended, 'utf8');

// --- wasm：直接拷贝 ---------------------------------------------------------
copyFileSync(wasmSrc, wasmOut);

console.log(`[build-mp3-worker] wrote ${workerOut}`);
console.log(`[build-mp3-worker] wrote ${wasmOut} (${readFileSync(wasmOut).length} bytes)`);
