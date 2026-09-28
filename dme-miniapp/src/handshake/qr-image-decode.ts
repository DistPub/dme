/**
 * handshake/qr-image-decode.ts - 从图片里识别 QR 内容（小程序版）。
 *
 * 与 dme-client/src/ui/QrScanScreen.tsx 里 `pickQrString()` 的
 * canvas + jsQR 逻辑等价，但把「取像素」这步抽出来适配小程序 canvas 2d：
 *
 *   web：  new Image() → canvas.drawImage → ctx.getImageData → jsQR(data, w, h)
 *   小程序：canvas.createImage() → img.src = tempFilePath →
 *          ctx.drawImage → ctx.getImageData → jsQR(data, w, h)
 *
 * ⚠️ 小程序 canvas 2d 的 `getImageData` 返回的是 `{ data, width, height }`
 *    结构，`data` 是 **RGBA Uint8ClampedArray**（与 DOM 一致），可直接喂 jsQR。
 */

import jsQR from 'jsqr';
import Taro from '@tarojs/taro';

/** 小程序 canvas 2d 节点（我们用到的最小结构）。 */
export interface MiniappCanvas2D {
  width: number;
  height: number;
  getContext(type: '2d'): unknown;
  createImage?(): MiniappImage;
}

/** `canvas.createImage()` 返回的图片对象。 */
interface MiniappImage {
  src: string;
  width?: number;
  height?: number;
  onload: (() => void) | null;
  onerror: (() => void) | null;
}

/** canvas 2d context 中我们用到的方法。 */
interface Ctx2DLike {
  drawImage(img: MiniappImage, x: number, y: number, w: number, h: number): void;
  getImageData(x: number, y: number, w: number, h: number): {
    data: Uint8ClampedArray;
    width: number;
    height: number;
  };
}

/** 解码画布的最大边长（过大图先缩放，兼顾速度与识别率）。 */
const MAX_DECODE_SIDE = 1000;

/**
 * 从本地图片路径识别 QR 内容。
 *
 * @param canvas     - 已挂载的 `<Canvas type="2d">` 节点
 * @param tempFilePath - 图片临时路径（`wx.chooseMedia` 的产物）
 * @returns QR 字符串；未识别到返回 null
 */
export async function decodeQrFromImageData(
  canvas: MiniappCanvas2D,
  tempFilePath: string,
): Promise<string | null> {
  const ctx = canvas.getContext('2d') as unknown as Ctx2DLike | null;
  if (!ctx) return null;
  if (typeof canvas.createImage !== 'function') {
    throw new Error('当前基础库不支持 canvas.createImage（需 2.7.0+）');
  }

  const img = canvas.createImage();
  if (!img) return null;

  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('图片加载失败'));
    img.src = tempFilePath;
  });

  // 按最大边等比缩放（避免超大图 getImageData 卡死且降低识别率）
  const naturalW = img.width ?? canvas.width;
  const naturalH = img.height ?? canvas.height;
  if (!naturalW || !naturalH) return null;

  const scale = Math.min(1, MAX_DECODE_SIDE / Math.max(naturalW, naturalH));
  const w = Math.max(1, Math.round(naturalW * scale));
  const h = Math.max(1, Math.round(naturalH * scale));

  canvas.width = w;
  canvas.height = h;

  ctx.drawImage(img, 0, 0, w, h);
  const imageData = ctx.getImageData(0, 0, w, h);

  const code = jsQR(imageData.data, imageData.width, imageData.height);
  if (code?.data) return code.data;

  // 一次失败时尝试原尺寸再解一次（缩放可能破坏小模块的可辨识度）
  if (scale < 1) {
    canvas.width = naturalW;
    canvas.height = naturalH;
    ctx.drawImage(img, 0, 0, naturalW, naturalH);
    const raw = ctx.getImageData(0, 0, naturalW, naturalH);
    const retry = jsQR(raw.data, raw.width, raw.height);
    if (retry?.data) return retry.data;
  }

  await Taro.showToast({ title: '未识别到二维码', icon: 'none' });
  return null;
}
