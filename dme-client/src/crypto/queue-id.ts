/**
 * crypto/queue-id.ts - QueueID derivation.
 *
 * The QueueID is a deterministic hash of the current ratchet state
 * (DH public key + message number + chain key). It serves as the lookup
 * key when polling the DME AppView: the sender writes an envelope at
 * the QueueID, and the receiver polls for that same QueueID.
 *
 * Formula:
 *   QueueID = SHA-256("DME-QueueID-v1" || dhPub || messageNum(uint32_le) || chainKey)
 *
 * The salt "DME-QueueID-v1" provides domain separation from other uses
 * of SHA-256 in the protocol.
 */

import { sha256 } from '@noble/hashes/sha256';
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils';

import { QUEUEID_SALT } from './constants';

/**
 * Encode a non-negative integer as a 4-byte little-endian Uint8Array.
 * This gives QueueID derivation a fixed-width representation of the
 * message number, preventing collisions between e.g. msg 1 + extra byte
 * and msg 257.
 */
function intToBytesLE(value: number): Uint8Array {
  if (value < 0 || !Number.isInteger(value)) {
    throw new RangeError('intToBytesLE: value must be a non-negative integer');
  }
  if (value > 0xffffffff) {
    throw new RangeError('intToBytesLE: value exceeds uint32 range');
  }
  const out = new Uint8Array(4);
  // Write in little-endian order
  out[0] = value & 0xff;
  out[1] = (value >>> 8) & 0xff;
  out[2] = (value >>> 16) & 0xff;
  out[3] = (value >>> 24) & 0xff;
  return out;
}

/**
 * Derive a QueueID from the current ratchet state.
 *
 * @param dhPub       - Sender's current DH public key (32 bytes).
 * @param messageNum  - Current message number in the chain.
 * @param chainKey    - Current chain key (32 bytes).
 * @returns Hex-encoded SHA-256 hash (64 characters).
 */
export function deriveQueueId(
  dhPub: Uint8Array,
  messageNum: number,
  chainKey: Uint8Array,
): string {
  const data = concatBytes(
    utf8ToBytes(QUEUEID_SALT),
    dhPub,
    intToBytesLE(messageNum),
    chainKey,
  );
  const hash = sha256(data);
  return bytesToHex(hash);
}

/**
 * Convert a Uint8Array to a lowercase hex string.
 * Local copy to avoid an extra import from @noble/hashes/utils when
 * only the hex encoding is needed.
 */
function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i]!.toString(16).padStart(2, '0');
  }
  return hex;
}
