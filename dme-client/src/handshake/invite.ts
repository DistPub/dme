/**
 * handshake/invite.ts - 邀请流程逻辑。
 *
 * 三种情况:
 *   1. Bob 没注册 DME → 文本帖子邀请注册
 *   2. Bob 已注册但不是好友 → 帖子嵌入 QR 码邀请加好友
 *   3. Bob 已是好友 → 提示直接去聊天
 */

import { Agent, RichText } from '@atproto/api';
import { ImageFormat, Skia } from '@shopify/react-native-skia';
import QRCodeLib from 'qrcode';

import type { DmeDidManager } from '../atproto/did';
import type { DmeStorage } from '../storage/db';

export type BobStatus = 'not_registered' | 'registered_not_friend' | 'already_friend';

const QR_MODULE_SIZE = 4;
const QR_MARGIN_MODULES = 4;

export async function checkBobDmeStatus(
  didManager: DmeDidManager,
  storage: DmeStorage | null,
  bobDid: string,
): Promise<BobStatus> {
  try {
    await didManager.getRemoteEncryptionKey(bobDid);
  } catch (err) {
    console.error('checkBobDmeStatus: Bob has no DME key, treating as not_registered:', err);
    return 'not_registered';
  }

  if (storage) {
    const ratchet = await storage.getRatchet(bobDid);
    if (ratchet) return 'already_friend';
  }

  return 'registered_not_friend';
}

export function generateQrPngBytes(data: string): Uint8Array | null {
  const qr = QRCodeLib.create(data, { errorCorrectionLevel: 'L' });
  const modules = qr.modules;
  const moduleCount = modules.size;

  const totalModules = moduleCount + QR_MARGIN_MODULES * 2;
  const size = totalModules * QR_MODULE_SIZE;

  const surface = Skia.Surface.MakeOffscreen(size, size);
  if (!surface) return null;

  const canvas = surface.getCanvas();
  canvas.clear(Skia.Color('white'));

  const blackPaint = Skia.Paint();
  blackPaint.setColor(Skia.Color('black'));

  for (let row = 0; row < moduleCount; row++) {
    for (let col = 0; col < moduleCount; col++) {
      if (modules.get(row, col)) {
        canvas.drawRect(
          Skia.XYWHRect(
            (col + QR_MARGIN_MODULES) * QR_MODULE_SIZE,
            (row + QR_MARGIN_MODULES) * QR_MODULE_SIZE,
            QR_MODULE_SIZE,
            QR_MODULE_SIZE,
          ),
          blackPaint,
        );
      }
    }
  }

  const image = surface.makeImageSnapshot();
  const bytes = image.encodeToBytes(ImageFormat.PNG);
  surface.dispose();

  return bytes as Uint8Array;
}

export function generateInvitePostText(bobHandle: string): string {
  return [
    `@${bobHandle} 想要通过 DME 与你进行端到端加密通信。`,
    '',
    '请安装 DME 客户端并注册一个账号，然后在 DME 中使用 Scan 功能扫描后续的二维码来建立加密对话。',
    '',
    '#DME #加密通信',
  ].join('\n');
}

export function generateAddFriendPostText(bobHandle: string): string {
  return [
    `@${bobHandle} 扫描下方二维码，通过 DME 建立端到端加密对话。`,
    '',
    '#DME #加密通信',
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
        alt: 'DME 加密通信二维码',
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
