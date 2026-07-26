/**
 * handshake/qr-encode.ts - QR code encoding for handshake payloads.
 *
 * Encodes a HandshakePayload into a base64url string suitable for
 * rendering as a QR code by the UI layer (react-native-qrcode-skia).
 *
 * QR matrix rendering is intentionally NOT done here: this module must
 * stay free of DOM/React-Native-specific APIs so it can run in any JS
 * runtime. The UI layer consumes the returned string and draws the QR.
 */

import type { HandshakePayload } from './handshake';
import { bytesToBase64url } from '../crypto/utils';

export function encodeHandshakeQR(payload: HandshakePayload): string {
  const json = JSON.stringify(payload);
  const bytes = new TextEncoder().encode(json);
  return bytesToBase64url(bytes);
}
