/**
 * handshake/invite.ts - 邀请流程逻辑（MLS 版本，小程序版）。
 *
 * 与 dme-client/src/handshake/invite.ts 逐函数对应，平台差异只有两处：
 *
 *   1. **QR PNG 生成**：web 用 `qrcode` 的 SVG 输出 + `canvas.toBlob()`；
 *      原生用 Skia。小程序两者都没有，改为：
 *        - `generateQrPngBytes`：`qrcode-generator` 拿到模块矩阵 →
 *          `wx.createOffscreenCanvas({type:'2d'})` 逐格 fillRect →
 *          `wx.canvasToTempFilePath` → `FileSystemManager.readFile` 取字节。
 *        - `generateQrMatrix`：直接吐布尔矩阵，供页面 `<Canvas type="2d">` 自绘
 *          （等价 web 的 `generateQrSvgDataUri` 预览用途）。
 *   2. **AT Protocol 调用**：小程序无 `@atproto/api`，因此
 *      `agent.uploadBlob` / `agent.com.atproto.repo.createRecord` /
 *      `RichText.detectFacets` 三处改为 `DmePds` 的薄方法 +
 *      本文件内纯 JS 的 `detectFacetsSubset`。
 *
 * 三种情况（与 web 完全一致）：
 *   1. Bob 没注册 DME -> 文本帖子邀请注册
 *   2. Bob 已注册但不是好友 -> 帖子嵌入 QR 码邀请加好友
 *   3. Bob 已是好友 -> 提示直接去聊天
 *
 * ⚠️ 本文件的 `record.embed` 是 Bluesky **帖子图片附件**
 *    （`app.bsky.embed.images`），不是 DME 的「嵌入模式（embed）」——
 *    后者是 iframe postMessage 桥，本项目明确排除，参见 IMPROVEMENT-PLAN §七。
 */

import type { DmePds } from '../atproto/pds';
import { getRemoteEncryptionKey } from '../atproto/did';
import { resolveHandleToDid } from '../atproto/profile-cache';
import { t } from '../i18n/format';
import type { Language } from '../i18n/translations';
import type { DmeStorage } from '../storage/db';
import { bytesToBase64url } from '../crypto/utils';
import { xrpcPostBytes } from '../platform/http';
import Taro from '@tarojs/taro';
// `qrcode-generator` 是 CJS：`module.exports = qrcode` 且带 `.stringToBytes`。
// 静态 import 后默认导出即为工厂函数（已核对 node_modules/qrcode-generator/qrcode.d.ts）。
import qrcode from 'qrcode-generator';

export type BobStatus = 'not_registered' | 'registered_not_friend' | 'already_friend';

/** QR 每个模块的像素边长（与 web 的 QR_MODULE_SIZE 一致）。 */
export const QR_MODULE_SIZE = 4;
/** QR 静默区模块数（与 web 的 QR_MARGIN_MODULES 一致）。 */
export const QR_MARGIN_MODULES = 4;

// ---------------------------------------------------------------------------
// Bob 状态判定
// ---------------------------------------------------------------------------

/**
 * 检查 Bob 的 DME 状态。
 *
 * 1. 查询 Bob 的 DID 文档是否有 #dme_encryption 公钥
 * 2. 检查本地存储是否已有与 Bob 的对话记录
 */
export async function checkBobDmeStatus(
  storage: DmeStorage | null,
  bobDid: string,
): Promise<BobStatus> {
  let encKey: Uint8Array | null;
  try {
    encKey = await getRemoteEncryptionKey(bobDid);
  } catch (err) {
    console.error('checkBobDmeStatus: DID 解析失败:', err);
    return 'not_registered';
  }

  if (!encKey) {
    return 'not_registered';
  }

  if (storage) {
    const groups = await storage.listGroups();
    if (groups.includes(bobDid)) return 'already_friend';
  }

  return 'registered_not_friend';
}

// ---------------------------------------------------------------------------
// QR 矩阵 / PNG
// ---------------------------------------------------------------------------

/** QR 模块矩阵（true = 黑格）。 */
export interface QrMatrix {
  /** 模块边长（不含静默区）。 */
  moduleCount: number;
  /** 含静默区的总边长（模块数）。 */
  totalModules: number;
  /** `get(row, col)` 返回该格是否为黑。 */
  get(row: number, col: number): boolean;
}

/**
 * 纯 JS 生成 QR 模块矩阵。
 *
 * 等价 web 的 `QRCodeLib.create(data, { errorCorrectionLevel: 'L' })`：
 * 纠错等级统一用 **L**（与 web 完全一致，保证同一字符串生成的码可互相识别）。
 *
 * `qrcode-generator` 是 CommonJS + 有类型的包，但其导出形态是
 * `function qrcode(typeNumber, errorCorrectionLevel)` 且带 `.stringToBytes`。
 */
export function generateQrMatrix(data: string): QrMatrix {
  // typeNumber = 0 表示自动选择最小版本（与 web `qrcode` 库行为一致）。
  const qr = qrcode(0, 'L');
  qr.addData(data, 'Byte');
  qr.make();

  const moduleCount = qr.getModuleCount();
  const totalModules = moduleCount + QR_MARGIN_MODULES * 2;

  return {
    moduleCount,
    totalModules,
    get(row: number, col: number): boolean {
      return qr.isDark(row, col);
    },
  };
}

/** 把 QR 矩阵画到一个 2D canvas context 上（白底黑格 + 静默区）。 */
export function paintQrMatrix(
  ctx: CanvasRenderingContext2DLike,
  matrix: QrMatrix,
  moduleSize: number = QR_MODULE_SIZE,
): void {
  const size = matrix.totalModules * moduleSize;

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, size, size);

  ctx.fillStyle = '#000000';
  for (let row = 0; row < matrix.moduleCount; row++) {
    for (let col = 0; col < matrix.moduleCount; col++) {
      if (!matrix.get(row, col)) continue;
      ctx.fillRect(
        (col + QR_MARGIN_MODULES) * moduleSize,
        (row + QR_MARGIN_MODULES) * moduleSize,
        moduleSize,
        moduleSize,
      );
    }
  }
}

/** canvas 2d context 的最小结构（避免依赖 DOM 类型）。 */
export interface CanvasRenderingContext2DLike {
  fillStyle: string;
  fillRect(x: number, y: number, w: number, h: number): void;
}

/**
 * 生成 QR 的 PNG 字节（用于写入 Bluesky 帖子 embed）。
 *
 * web 用 `qrcode` SVG + 浏览器 canvas；小程序用离屏 canvas +
 * `canvasToTempFilePath` + `FileSystemManager.readFile`。
 *
 * @returns PNG 字节；失败返回 null（与 web 行为一致 —— web 失败也返回 null）。
 */
export async function generateQrPngBytes(data: string): Promise<Uint8Array | null> {
  try {
    const matrix = generateQrMatrix(data);
    const size = matrix.totalModules * QR_MODULE_SIZE;

    const canvas = Taro.createOffscreenCanvas({
      type: '2d',
      width: size,
      height: size,
    });
    // Taro 的 OffscreenCanvas.getContext 重载把 '2d' 解析成 DOM Canvas 类型，
    // 但小程序拿到的是原生 context。这里显式窄化到我们实际用到的最小结构。
    const rawCtx = (canvas as unknown as {
      getContext(type: '2d'): unknown;
    }).getContext('2d');
    const ctx = rawCtx as CanvasRenderingContext2DLike | null;
    if (!ctx) return null;

    paintQrMatrix(ctx, matrix, QR_MODULE_SIZE);

    const temp = await Taro.canvasToTempFilePath({
      // Taro 的类型声明要求 DOM `Canvas`；小程序实际传的是离屏 canvas 节点。
      canvas: canvas as unknown as Parameters<typeof Taro.canvasToTempFilePath>[0]['canvas'],
      x: 0,
      y: 0,
      width: size,
      height: size,
      destWidth: size,
      destHeight: size,
      fileType: 'png',
    });

    const filePath = temp.tempFilePath;
    if (!filePath) return null;

    const bytes = await readFileBytes(filePath);
    return bytes;
  } catch (err) {
    console.error('generateQrPngBytes 失败:', err);
    return null;
  }
}

/** 用 FileSystemManager 同步读文件为 Uint8Array。 */
function readFileBytes(filePath: string): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    Taro.getFileSystemManager().readFile({
      filePath,
      success: (res) => {
        const data = res.data;
        if (data instanceof ArrayBuffer) {
          resolve(new Uint8Array(data));
          return;
        }
        // 某些基础库返回 base64 字符串（未指定 encoding 时理论上不会）
        if (typeof data === 'string') {
          resolve(base64ToBytes(data));
          return;
        }
        reject(new Error('readFile 返回了未知类型'));
      },
      fail: (err) => reject(new Error(err.errMsg ?? 'readFile 失败')),
    });
  });
}

/** base64 → Uint8Array（仅在 readFile 返回字符串时兜底）。 */
function base64ToBytes(b64: string): Uint8Array {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const cleaned = b64.replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array(Math.floor((cleaned.length * 3) / 4));
  let o = 0;
  let buffer = 0;
  let bits = 0;
  for (const ch of cleaned) {
    const v = chars.indexOf(ch);
    if (v < 0) continue;
    buffer = (buffer << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (buffer >> bits) & 0xff;
    }
  }
  return out.slice(0, o);
}

// ---------------------------------------------------------------------------
// 帖子文案（与 web 逐字符一致）
// ---------------------------------------------------------------------------

export function generateInvitePostText(bobHandle: string, lang: Language): string {
  return [
    t(lang, 'post.inviteLine1', { handle: bobHandle }),
    '',
    t(lang, 'post.inviteLine2'),
    '',
    t(lang, 'post.hashtag'),
  ].join('\n');
}

export function generateAddFriendPostText(bobHandle: string, lang: Language): string {
  return [
    t(lang, 'post.addFriendLine1', { handle: bobHandle }),
    '',
    t(lang, 'post.hashtag'),
  ].join('\n');
}

// ---------------------------------------------------------------------------
// RichText.detectFacets 的纯 JS 子集
// ---------------------------------------------------------------------------

/** 一条 facet（与 Bluesky `app.bsky.richtext.facet` 结构一致）。 */
export interface Facet {
  index: { byteStart: number; byteEnd: number };
  features: Array<
    | { $type: 'app.bsky.richtext.facet#mention'; did: string }
    | { $type: 'app.bsky.richtext.facet#link'; uri: string }
    | { $type: 'app.bsky.richtext.facet#tag'; tag: string }
  >;
}

/** facet feature 的 $type 常量。 */
const FEATURE_MENTION = 'app.bsky.richtext.facet#mention';
const FEATURE_LINK = 'app.bsky.richtext.facet#link';
const FEATURE_TAG = 'app.bsky.richtext.facet#tag';

/**
 * facet 检测正则 —— 对照官方 `@atproto/api` 的 `detection.js` / `util.js`：
 *   MENTION_REGEX = /(^|\s|\()(@)([a-zA-Z0-9.-]+)(\b)/g   （+ isValidDomain 校验）
 *   TAG_REGEX     = /(^|\s)[#＃]((?!\ufe0f)[^\s<零宽>]*[^\d\s<标点><零宽>]+[^\s<零宽>]*)?/gu
 *
 * 刻意**不逐字移植**官方 TAG_REGEX：它用了 `\p{P}`（Unicode property escape，
 * ES2018 语法），es5ify 管线对 src 正则的降级存在不确定性 —— 改用
 * 「正则粗扫 + 手工修剪」的等价实现（见 detectFacetsSubset 内注释）。
 */

/** 匹配 `@handle`：前导允许行首 / 空白 / `(`（与官方 MENTION_REGEX 一致）。 */
const MENTION_RE = /(^|\s|\()@([a-zA-Z0-9.-]+)/g;
/** 匹配裸 URL（http/https）。 */
const LINK_RE = /https?:\/\/[^\s<>"'()]+/g;
/** tag 扫描：行首或空白后的 `#` / 全角 `＃`（与官方 TAG_REGEX 的前导一致）。 */
const TAG_SCAN_RE = /(^|\s)[#＃]/g;

/**
 * 官方 TAG_REGEX 排除的零宽字符集（\uFE0F emoji modifier 之外的 6 个）。
 * tag 本体扫描在这些字符处截断。
 */
const ZERO_WIDTH = '\u00AD\u2060\u200A\u200B\u200C\u200D\u20E2';

/**
 * 尾部标点集合 —— 官方用 `/\p{P}+$/gu` 剥尾部标点。这里用显式集合近似
 * （ASCII 标点 + 全部常用中西文标点；官方的 \p{P} 不含 `$+<=>^`|~` 等
 * \p{S} 符号类，但多剥这几个对帖子场景更符合直觉）。
 */
const TRAILING_PUNCT =
  '!"#%&\'()*+,-./:;<=>?@[\\]^_`{|}~' +
  '。，、；：！？…—·（）《》〈〉「」『』【】“”‘’［］｛｝～';

function stripTrailingPunct(s: string): string {
  while (s.length > 0 && TRAILING_PUNCT.includes(s.charAt(s.length - 1))) {
    s = s.slice(0, -1);
  }
  return s;
}

/**
 * 官方 tag 校验：必须至少含一个「非数字、非标点」字符 ——
 * `#123`、`#!!!` 这类不产出 facet；`#隐世`、`#3体` 通过。
 */
function hasNonDigitPunct(s: string): boolean {
  for (const ch of s) {
    if (!TRAILING_PUNCT.includes(ch) && (ch < '0' || ch > '9')) return true;
  }
  return false;
}

/**
 * handle 形态校验（官方 isValidDomain 的近似：官方拿完整 TLD 列表比对，
 * 这里退化为「结尾是 .<≥2 字母>」，`.test` 结尾按官方特判放行）。
 */
function isPlausibleHandle(h: string): boolean {
  if (h.endsWith('.test')) return true;
  return /^[a-zA-Z0-9.-]+(\.[a-zA-Z]{2,})$/.test(h);
}

/**
 * 计算字符串在 UTF-8 编码下的字节长度区间。
 *
 * ⚠️ Bluesky facet 的 `byteStart` / `byteEnd` 是 **UTF-8 字节偏移**，
 * 不是 JS 的 UTF-16 码元下标 —— 中文/emoji 会错位，必须精确换算。
 */
function utf8ByteRanges(text: string): number[] {
  // ranges[i] = 第 i 个 UTF-16 码元起始处的 UTF-8 字节偏移
  const ranges: number[] = new Array(text.length + 1);
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    ranges[i] = bytes;
    const code = text.codePointAt(i) as number;
    if (code > 0xffff) {
      // 代理对：占 4 字节，且多消耗一个码元
      bytes += 4;
      ranges[i + 1] = bytes;
      i++;
      ranges[i + 1] = bytes;
      continue;
    }
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else bytes += 3;
  }
  ranges[text.length] = bytes;
  return ranges;
}

/**
 * `RichText.detectFacets` 的纯 JS 子集。
 *
 * 支持三类 facet：`#tag`（本地识别）、`http(s)://` 链接（本地识别）、
 * `@handle`（需调用方提供解析器把 handle 变成 DID）。
 *
 * ⚠️ 这是本项目移植范围内**唯一需要新写的算法**（小程序无 `@atproto/api`），
 * 因此单独抽出、边界清晰、便于人工核对。
 *
 * @param text          - 帖子正文
 * @param resolveHandle - 可选的 handle → DID 解析器；缺省时**不**产出 mention facet
 */
export async function detectFacetsSubset(
  text: string,
  resolveHandle?: (handle: string) => Promise<string | null>,
): Promise<Facet[]> {
  const ranges = utf8ByteRanges(text);
  const facets: Facet[] = [];

  // ---- #tag（等价官方 TAG_REGEX 分支） -------------------------------------
  // 粗扫 `#` 位置 → 手工收集到下一个空白/零宽字符 → 修剪 + 校验。
  // 官方流程：tag.trim() → 剥 \p{P} 尾标点 → 空或 >64 丢弃 → 不做大小写转换。
  TAG_SCAN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TAG_SCAN_RE.exec(text)) !== null) {
    const hashStart = m.index + m[1].length;
    // 收集 tag 本体：直到空白或零宽字符（官方字符集 [^\s<零宽>]）
    let end = hashStart + 1;
    while (
      end < text.length &&
      !/\s/.test(text.charAt(end)) &&
      !ZERO_WIDTH.includes(text.charAt(end))
    ) {
      end++;
    }
    let tag = text.slice(hashStart + 1, end);
    tag = stripTrailingPunct(tag);
    if (!tag || tag.length > 64 || !hasNonDigitPunct(tag)) continue;
    facets.push({
      index: { byteStart: ranges[hashStart], byteEnd: ranges[hashStart + 1 + tag.length] },
      features: [{ $type: FEATURE_TAG, tag }],
    });
  }

  // ---- http(s) link -----------------------------------------------------
  LINK_RE.lastIndex = 0;
  while ((m = LINK_RE.exec(text)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    facets.push({
      index: { byteStart: ranges[start], byteEnd: ranges[end] },
      features: [{ $type: FEATURE_LINK, uri: m[0] }],
    });
  }

  // ---- @handle mention --------------------------------------------------
  // 官方 detectFacets(agent) 会产出 did 为 handle 占位的 facet，再逐个调
  // resolveHandle 替换。这里等价实现：resolveHandle(handle) → did；
  // 解析失败**丢弃该 facet**（web 端是保留 did:'' —— 那会触发 PDS lexicon
  // 校验失败导致整帖发不出去，小程序侧丢弃更稳，正常解析成功时两者一致）。
  MENTION_RE.lastIndex = 0;
  const pending: Array<{ start: number; end: number; handle: string }> = [];
  while ((m = MENTION_RE.exec(text)) !== null) {
    const handle = m[2];
    if (!isPlausibleHandle(handle)) continue; // 官方 isValidDomain 校验的近似
    const start = m.index + m[1].length;
    const end = start + 1 + handle.length;
    pending.push({ start, end, handle });
  }
  if (resolveHandle) {
    for (const p of pending) {
      try {
        const did = await resolveHandle(p.handle);
        if (!did) continue;
        facets.push({
          index: { byteStart: ranges[p.start], byteEnd: ranges[p.end] },
          features: [{ $type: FEATURE_MENTION, did }],
        });
      } catch {
        /* 解析失败就不产出 facet，正常解析成功时与 web 行为一致 */
      }
    }
  }

  // 按起始位置排序（Bluesky 要求 facets 有序）
  facets.sort((a, b) => a.index.byteStart - b.index.byteStart);
  return facets;
}

// ---------------------------------------------------------------------------
// 发布邀请帖
// ---------------------------------------------------------------------------

export interface InvitePostResult {
  uri: string;
  cid: string;
}

/** 帖子 record 的集合 NSID。 */
const POST_COLLECTION = 'app.bsky.feed.post';

/**
 * 发布 DME 邀请帖（等价 web 的 `createDmeInvitePost`）。
 *
 * 差异说明：
 *   - `agent.uploadBlob` → `pds.uploadBlob`（Taro.request octet-stream 直传）
 *   - `agent.com.atproto.repo.createRecord` → `pds.createRecord`
 *   - `RichText.detectFacets(agent)` → `detectFacetsSubset` + `resolveHandleToDid`
 *
 * @param pds        - 已登录的 `DmePds`
 * @param text       - 帖子正文（用户可在预览里编辑）
 * @param qrPngBytes - QR PNG 字节；null 表示纯文本帖
 * @param lang       - 语言（用于 `post.qrAlt` 替代文本）
 */
export async function createDmeInvitePost(
  pds: DmePds,
  text: string,
  qrPngBytes: Uint8Array | null,
  lang: Language,
): Promise<InvitePostResult> {
  // mention 解析：等价 web 的 RichText.detectFacets(agent)（其内部对每个
  // mention facet 调 com.atproto.identity.resolveHandle）。⚠️ 之前漏传了
  // resolver，导致邀请帖里的 @handle 从不产出 mention facet。
  const facets = await detectFacetsSubset(text, (handle) => resolveHandleToDid(handle, pds));

  const record: Record<string, unknown> = {
    $type: POST_COLLECTION,
    text,
    facets,
    createdAt: new Date().toISOString(),
  };

  if (qrPngBytes && qrPngBytes.length > 0) {
    const blob = await pds.uploadBlob(qrPngBytes, 'image/png');
    record.embed = {
      $type: 'app.bsky.embed.images',
      images: [
        {
          alt: t(lang, 'post.qrAlt'),
          image: blob,
        },
      ],
    };
  }

  const result = await pds.createRecord(POST_COLLECTION, record);
  return { uri: result.uri, cid: result.cid };
}

// ---------------------------------------------------------------------------
// 内部：给 pds.uploadBlob 用的字节直传（保留在此以便单元核对）
// ---------------------------------------------------------------------------

/**
 * 直传字节到 PDS（`com.atproto.repo.uploadBlob`）。
 *
 * 独立导出便于在页面里直接复用；等价于 `pds.uploadBlob`。
 */
export async function uploadBlobDirect(
  pdsUrl: string,
  bytes: Uint8Array,
  encoding: string,
  accessJwt: string,
): Promise<unknown> {
  const url = `${pdsUrl.replace(/\/+$/, '')}/xrpc/com.atproto.repo.uploadBlob`;
  return xrpcPostBytes<{ blob: unknown }>(url, bytes, encoding, {
    headers: accessJwt ? { Authorization: `Bearer ${accessJwt}` } : {},
  });
}

/** 供页面把 QR 字符串转成 base64url（与 web `encodeQrPayload` 输出一致）。 */
export function bytesToQrString(bytes: Uint8Array): string {
  return bytesToBase64url(bytes);
}

