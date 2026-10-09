/**
 * handshake/invite.ts - 邀请流程逻辑（MLS 版本）。
 *
 * 三种情况:
 *   1. Bob 没注册 DME -> 文本帖子邀请注册
 *   2. Bob 已注册但不是好友 -> 帖子嵌入 QR 码邀请加好友
 *   3. Bob 已是好友 -> 提示直接去聊天
 *
 * QR 内容由 prepareInviteQr() 生成（加密 KeyPackage），帖子创建逻辑
 * 保持不变（com.atproto.repo.createRecord）。
 */

import { Agent, RichText } from '@atproto/api';
import QRCodeLib from 'qrcode';
import { Platform } from 'react-native';

import { getRemoteEncryptionKey } from '../atproto/did';
import { t } from '../i18n/format';
import type { Language } from '../i18n/translations';
import type { DmeStorage } from '../storage/db';
import { QR_MARGIN_MODULES, QR_MODULE_SIZE } from './invite-shared';
import { generateQrPngBytesPlatform } from './invite-native';
import type { BobStatus } from './invite-shared';

export type { BobStatus } from './invite-shared';

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

export async function generateQrPngBytes(data: string): Promise<Uint8Array | null> {
  if (Platform.OS === 'web') {
    const qr = QRCodeLib.create(data, { errorCorrectionLevel: 'L' });
    const moduleCount = qr.modules.size;
    const size = (moduleCount + QR_MARGIN_MODULES * 2) * QR_MODULE_SIZE;
    return rasterizeSvgToPng(await renderQrSvg(data, size, moduleCount), size);
  }

  return generateQrPngBytesPlatform(data);
}

function renderQrSvg(data: string, size: number, moduleCount: number): Promise<string> {
  return QRCodeLib.toString(data, {
    type: 'svg',
    errorCorrectionLevel: 'L',
    margin: Math.max(1, Math.round(moduleCount / 8)),
    width: size,
  });
}

function rasterizeSvgToPng(svg: string, size: number): Promise<Uint8Array | null> {
  return new Promise((resolve) => {
    const img = new window.Image();
    const svgBlob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(svgBlob);
    img.onload = (): void => {
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        URL.revokeObjectURL(url);
        resolve(null);
        return;
      }
      ctx.fillStyle = 'white';
      ctx.fillRect(0, 0, size, size);
      ctx.drawImage(img, 0, 0, size, size);
      URL.revokeObjectURL(url);
      canvas.toBlob((blob) => {
        if (!blob) {
          resolve(null);
          return;
        }
        blob.arrayBuffer().then((buf) => resolve(new Uint8Array(buf))).catch(() => resolve(null));
      }, 'image/png');
    };
    img.onerror = (): void => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    img.src = url;
  });
}

/**
 * Render a QR code as an SVG data URI (pure JS, no Skia/canvas).
 *
 * Skia's offscreen surface needs a graphics context that is missing on some
 * web builds, so this is the safe cross-platform path for on-screen previews.
 */
export async function generateQrSvgDataUri(data: string, size: number): Promise<string> {
  const moduleCount = QRCodeLib.create(data, { errorCorrectionLevel: 'L' }).modules.size;
  const svg = await renderQrSvg(data, size, moduleCount);
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

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

export interface InvitePostResult {
  uri: string;
  cid: string;
}

export async function createDmeInvitePost(
  agent: Agent,
  text: string,
  qrPngBytes: Uint8Array | null,
  lang: Language,
): Promise<InvitePostResult> {
  const rt = new RichText({ text });
  await rt.detectFacets(agent);

  const record: Record<string, unknown> = {
    $type: 'app.bsky.feed.post',
    text: rt.text,
    facets: rt.facets,
    createdAt: new Date().toISOString(),
  };

  if (qrPngBytes && qrPngBytes.length > 0) {
    const blob = await agent.uploadBlob(qrPngBytes, { encoding: 'image/png' });
    record.embed = {
      $type: 'app.bsky.embed.images',
      images: [{
        alt: t(lang, 'post.qrAlt'),
        image: blob.data.blob,
      }],
    };
  }

  const result = await agent.com.atproto.repo.createRecord({
    repo: agent.assertDid,
    collection: 'app.bsky.feed.post',
    record,
  });

  return { uri: result.data.uri, cid: result.data.cid };
}
