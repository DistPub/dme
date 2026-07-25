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

/**
 * Encode a HandshakePayload into a base64url string suitable for
 * embedding in a QR code.
 *
 * The payload is JSON-serialized then base64url-encoded. The QR code
 * contains this string directly.
 *
 * @param payload - The handshake payload to encode.
 * @returns base64url-encoded JSON string.
 */
export function encodeHandshakeQR(payload: HandshakePayload): string {
  const json = JSON.stringify(payload);
  const bytes = new TextEncoder().encode(json);
  return bytesToBase64url(bytes);
}

// ---------------------------------------------------------------------------
// Base64url helper
// ---------------------------------------------------------------------------

function bytesToBase64url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
