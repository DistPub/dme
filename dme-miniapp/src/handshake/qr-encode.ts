/**
 * handshake/qr-encode.ts - QR payload encoding for MLS KeyPackage exchange.
 *
 * Encodes an encrypted KeyPackage + Alice's DID into a compact base64url
 * string suitable for QR rendering by the UI layer.
 *
 * QR content format (compact for QR capacity):
 *   1. JSON: { "aliceDid": string, "encKp": string(base64url) }
 *   2. base64url-encode the entire JSON string
 *
 * The encrypted KeyPackage (encKp) is the output of
 * serializeEncryptedKeyPackage(): ephemeralPublicKey[32] || ciphertext.
 */

import { bytesToBase64url, base64urlToBytes } from '../crypto/utils';

/** Payload encoded into the QR code. */
export interface QrPayload {
  /** Serialized encrypted KeyPackage (ephemeralPublicKey || ciphertext). */
  encryptedKeyPackage: Uint8Array;
  /** Alice's DID, so Bob knows who is inviting. */
  aliceDid: string;
}

/** Inner JSON shape (kept compact for QR capacity). */
interface QrJson {
  aliceDid: string;
  encKp: string;
}

/**
 * Encode a QrPayload to a base64url string for QR rendering.
 *
 * @param payload - The QrPayload to encode.
 * @returns base64url-encoded JSON string.
 */
export function encodeQrPayload(payload: QrPayload): string {
  const json: QrJson = {
    aliceDid: payload.aliceDid,
    encKp: bytesToBase64url(payload.encryptedKeyPackage),
  };
  const bytes = new TextEncoder().encode(JSON.stringify(json));
  return bytesToBase64url(bytes);
}

/**
 * Decode a base64url QR string back into a QrPayload.
 *
 * @param data - base64url-encoded JSON string from QR scan.
 * @returns The decoded QrPayload.
 * @throws if the string is not valid QR payload JSON.
 */
export function decodeQrPayload(data: string): QrPayload {
  const bytes = base64urlToBytes(data);
  const json = new TextDecoder().decode(bytes);
  const parsed = JSON.parse(json) as Partial<QrJson>;

  if (!parsed.aliceDid || typeof parsed.aliceDid !== 'string') {
    throw new Error('decodeQrPayload: missing or invalid aliceDid');
  }
  if (!parsed.encKp || typeof parsed.encKp !== 'string') {
    throw new Error('decodeQrPayload: missing or invalid encKp');
  }

  return {
    encryptedKeyPackage: base64urlToBytes(parsed.encKp),
    aliceDid: parsed.aliceDid,
  };
}
