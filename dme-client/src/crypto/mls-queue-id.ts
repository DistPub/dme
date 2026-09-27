/**
 * crypto/mls-queue-id.ts - QueueID derivation from MLS state.
 *
 * Two QueueID modes:
 *   1. Welcome queueId - SHA-256 of a KeyPackage initKey. Used for
 *      blind lookup of Welcome messages on the server.
 *   2. Message queueId - MLS exporter secret + sender leaf index +
 *      generation. Used for blind lookup of application messages.
 *
 * Both modes produce opaque hashes so the server never sees plaintext
 * metadata.
 */

import { mlsExporter, type CiphersuiteImpl } from 'ts-mls';
import { sha256 } from '@noble/hashes/sha256';
import { getNobleMlsImpl } from './mls-noble-kdf';
import { bytesToBase64url, bytesToHex } from './utils';
import {
  MESSAGE_QUEUEID_LABEL,
  QUEUEID_LENGTH,
  WELCOME_QUEUEID_LABEL,
} from './mls-config';

/**
 * Derive the Welcome queueId from a KeyPackage initKey.
 *
 * Both Alice (who generated the KeyPackage) and Bob (who received the
 * decrypted KeyPackage) can compute this.
 *
 * @param initKey - X25519 HPKE public key from the KeyPackage (32 bytes).
 * @returns base64url-encoded SHA-256 hash.
 */
export function deriveWelcomeQueueId(initKey: Uint8Array): string {
  const data = new TextEncoder().encode(
    WELCOME_QUEUEID_LABEL + ':' + bytesToHex(initKey),
  );
  return bytesToBase64url(sha256(data));
}

/**
 * Derive a message queueId from the MLS epoch exporter secret.
 *
 * The sender derives it for outgoing messages; the receiver derives it
 * for polling. Both share the same exporterSecret (group secret).
 *
 * @param exporterSecret   - MLS key schedule exporter secret.
 * @param senderLeafIndex  - Sender's leaf index in the ratchet tree.
 * @param generation       - Message generation within the current epoch.
 * @param impl             - Ciphersuite implementation.
 * @returns base64url-encoded derived key.
 */
export async function deriveMessageQueueId(
  exporterSecret: Uint8Array,
  senderLeafIndex: number,
  generation: number,
): Promise<string> {
  const context = new Uint8Array(8);
  const view = new DataView(context.buffer);
  view.setUint32(0, senderLeafIndex);
  view.setUint32(4, generation);
  const impl = await getNobleMlsImpl();
  const derived = await mlsExporter(
    exporterSecret,
    MESSAGE_QUEUEID_LABEL,
    context,
    QUEUEID_LENGTH,
    impl,
  );
  return bytesToBase64url(derived);
}
