/**
 * handshake/invite-native.ts - `generateQrPngBytes` 的 native 实现（Skia 离屏渲染）。
 *
 * web 端由同名平台文件 `invite-native.web.ts` 覆盖（Metro 平台后缀解析），
 * 因此 web bundle 不会引入 `@shopify/react-native-skia`，从而无需 CanvasKit
 * WASM / COOP+COEP。禁止把 Skia 逻辑搬到 web 可达的模块里。
 */

import { ImageFormat, Skia } from '@shopify/react-native-skia';
import QRCodeLib from 'qrcode';

import { QR_MARGIN_MODULES, QR_MODULE_SIZE } from './invite-shared';

export async function generateQrPngBytesPlatform(data: string): Promise<Uint8Array | null> {
  const qr = QRCodeLib.create(data, { errorCorrectionLevel: 'L' });
  const moduleCount = qr.modules.size;
  const size = (moduleCount + QR_MARGIN_MODULES * 2) * QR_MODULE_SIZE;

  const surface = Skia.Surface.MakeOffscreen(size, size);
  if (!surface) return null;

  const canvas = surface.getCanvas();
  canvas.clear(Skia.Color('white'));

  const blackPaint = Skia.Paint();
  blackPaint.setColor(Skia.Color('black'));

  for (let row = 0; row < moduleCount; row++) {
    for (let col = 0; col < moduleCount; col++) {
      if (qr.modules.get(row, col)) {
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
