/**
 * polyfills/encoding.ts - UTF-8 编解码 + base64 的小程序实现。
 *
 * 小程序运行时不提供 TextEncoder / TextDecoder / btoa / atob。
 * 项目内使用点（已 grep 全量核对）：
 *   - TextEncoder/Decoder：crypto/{mls-queue-id,file-crypto,mls-credential,backup}.ts、
 *     handshake/qr-encode.ts、poll/poller.ts（共 8 处）
 *   - btoa/atob：crypto/utils.ts、crypto/identity.ts、storage/db.ts（共 7 处）
 *
 * 注意：btoa/atob 必须按「二进制字节 → 字符码位」语义实现（原代码把二进制串
 * 逐字节塞进 btoa），**不是** UTF-8 语义。这里手写 base64，避免依赖差异。
 */

// ---------------------------------------------------------------------------
// UTF-8
// ---------------------------------------------------------------------------

/** 字符串 → UTF-8 字节。 */
export function utf8ToBytes(str: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < str.length; i++) {
    let code = str.charCodeAt(i);
    // 处理代理对（emoji 等 BMP 外字符）
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < str.length) {
      const next = str.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = (code - 0xd800) * 0x400 + (next - 0xdc00) + 0x10000;
        i += 1;
      }
    }
    if (code < 0x80) {
      out.push(code);
    } else if (code < 0x800) {
      out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return new Uint8Array(out);
}

/** UTF-8 字节 → 字符串。 */
export function bytesToUtf8(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  while (i < bytes.length) {
    const b0 = bytes[i];
    let code: number;
    let extra: number;
    if (b0 < 0x80) {
      code = b0;
      extra = 0;
    } else if ((b0 & 0xe0) === 0xc0) {
      code = b0 & 0x1f;
      extra = 1;
    } else if ((b0 & 0xf0) === 0xe0) {
      code = b0 & 0x0f;
      extra = 2;
    } else {
      code = b0 & 0x07;
      extra = 3;
    }
    for (let j = 0; j < extra; j++) {
      code = (code << 6) | (bytes[i + 1 + j] & 0x3f);
    }
    i += 1 + extra;

    if (code > 0xffff) {
      code -= 0x10000;
      out += String.fromCharCode(0xd800 + (code >> 10), 0xdc00 + (code & 0x3ff));
    } else {
      out += String.fromCharCode(code);
    }
  }
  return out;
}

/** TextEncoder 兼容实现。 */
export class TextEncoderPolyfill {
  readonly encoding = 'utf-8';

  encode(input = ''): Uint8Array {
    return utf8ToBytes(input);
  }
}

/** TextDecoder 兼容实现（仅支持 utf-8）。 */
export class TextDecoderPolyfill {
  readonly encoding: string;

  constructor(label = 'utf-8') {
    this.encoding = label;
  }

  decode(input?: ArrayBuffer | ArrayBufferView): string {
    if (!input) return '';
    const bytes =
      input instanceof ArrayBuffer
        ? new Uint8Array(input)
        : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    return bytesToUtf8(bytes);
  }
}

// ---------------------------------------------------------------------------
// base64（二进制语义，与浏览器 btoa/atob 行为一致）
// ---------------------------------------------------------------------------

const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_LOOKUP = (() => {
  const table = new Int16Array(256).fill(-1);
  for (let i = 0; i < B64_CHARS.length; i++) table[B64_CHARS.charCodeAt(i)] = i;
  return table;
})();

/** 二进制字符串（每个字符 0-255）→ base64。等价于 btoa。 */
export function btoaBinary(binary: string): string {
  let out = '';
  for (let i = 0; i < binary.length; i += 3) {
    const b0 = binary.charCodeAt(i) & 0xff;
    const b1 = i + 1 < binary.length ? binary.charCodeAt(i + 1) & 0xff : NaN;
    const b2 = i + 2 < binary.length ? binary.charCodeAt(i + 2) & 0xff : NaN;

    out += B64_CHARS[b0 >> 2];
    if (Number.isNaN(b1)) {
      out += B64_CHARS[(b0 & 0x03) << 4];
      out += '==';
      break;
    }
    out += B64_CHARS[((b0 & 0x03) << 4) | (b1 >> 4)];
    if (Number.isNaN(b2)) {
      out += B64_CHARS[(b1 & 0x0f) << 2];
      out += '=';
      break;
    }
    out += B64_CHARS[((b1 & 0x0f) << 2) | (b2 >> 6)];
    out += B64_CHARS[b2 & 0x3f];
  }
  return out;
}

/** base64 → 二进制字符串（每个字符 0-255）。等价于 atob。 */
export function atobBinary(b64: string): string {
  const cleaned = b64.replace(/[^A-Za-z0-9+/]/g, '');
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < cleaned.length; i++) {
    const v = B64_LOOKUP[cleaned.charCodeAt(i)];
    if (v < 0) continue;
    buffer = (buffer << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out += String.fromCharCode((buffer >> bits) & 0xff);
    }
  }
  return out;
}

/**
 * 安装全局 TextEncoder / TextDecoder / btoa / atob。
 *
 * ⚠️ 不能用 `typeof g.TextEncoder === 'undefined'` 判断：构建后注入的
 *    「全局占位」（`scripts/inject-polyfills.mjs`）会在 app 启动最早阶段
 *    先放一个空函数占位（目的是让 @noble 在模块求值时能取到全局对象引用），
 *    此时 TextEncoder 已存在但**实现是空的**。
 *
 *    因此这里改为检查「是否为本 polyfill 的真实实现」——通过原型上的方法
 *    判断，避免占位函数把真正的实现挡住。
 */
function isRealTextEncoder(v: unknown): boolean {
  return (
    typeof v === 'function' &&
    typeof (v as { prototype?: { encode?: unknown } }).prototype?.encode === 'function'
  );
}

function isRealTextDecoder(v: unknown): boolean {
  return (
    typeof v === 'function' &&
    typeof (v as { prototype?: { decode?: unknown } }).prototype?.decode === 'function'
  );
}

export function installEncodingPolyfills(): void {
  const g = globalThis as unknown as Record<string, unknown>;
  if (!isRealTextEncoder(g.TextEncoder)) g.TextEncoder = TextEncoderPolyfill;
  if (!isRealTextDecoder(g.TextDecoder)) g.TextDecoder = TextDecoderPolyfill;
  // btoa/atob 占位函数无副作用，直接用可用性 + 标记判断：赋值覆盖即可。
  // （占位函数是 no-op，必须被真实实现替换）
  g.btoa = btoaBinary;
  g.atob = atobBinary;
}
