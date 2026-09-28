/**
 * handshake/qr-decode.ts - QR decode + KeyPackage decryption logic.
 *
 * This module handles only the decode/decrypt logic. The UI layer
 * (QrScanScreen) handles camera capture and barcode recognition,
 * then passes the raw QR string here for processing.
 *
 * Flow:
 *   1. decodeQrPayload(qrString) -> { encryptedKeyPackage, aliceDid }
 *   2. deserializeEncryptedKeyPackage(encryptedKeyPackage) -> { ephemeralPublicKey, ciphertext }
 *   3. decryptKeyPackage(ephemeralPublicKey, ciphertext, ownPrivateKey) -> KeyPackage
 */

import type { KeyPackage } from 'ts-mls';

import {
  decryptKeyPackage,
  deserializeEncryptedKeyPackage,
} from '../crypto/keypackage';
import { decodeQrPayload } from './qr-encode';

/**
 * Decode a QR string and decrypt the enclosed KeyPackage using the
 * user's own X25519 private key.
 *
 * @param qrString              - The raw string from QR scan.
 * @param ownEncryptionPrivateKey - Bob's X25519 private key (32 bytes).
 * @returns Alice's decrypted KeyPackage and her DID.
 * @throws if the QR string is invalid or decryption fails.
 */
export async function decodeAndDecryptQr(
  qrString: string,
  ownEncryptionPrivateKey: Uint8Array,
): Promise<{ keyPackage: KeyPackage; aliceDid: string }> {
  const payload = decodeQrPayload(qrString);

  const { ephemeralPublicKey, ciphertext } = deserializeEncryptedKeyPackage(
    payload.encryptedKeyPackage,
  );

  const keyPackage = await decryptKeyPackage(
    ephemeralPublicKey,
    ciphertext,
    ownEncryptionPrivateKey,
  );

  return { keyPackage, aliceDid: payload.aliceDid };
}
