/**
 * handshake/invite-native.web.ts - `invite-native.ts` 的 web 覆盖实现。
 *
 * 仅返回 null：web 端 QR PNG 由 `invite.ts` 的 SVG→canvas 路径生成，不需要
 * Skia。此文件让 Metro 在 web 打包时选择无 Skia 版本，从而 web bundle 不含
 * `@shopify/react-native-skia`，无需 CanvasKit WASM / COOP+COEP。
 */

export async function generateQrPngBytesPlatform(_data: string): Promise<Uint8Array | null> {
  return null;
}
