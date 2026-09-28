import { sha256 } from '@noble/hashes/sha256';
import { gcm } from '@noble/ciphers/aes';
import { bytesToHex, hexToBytes, bytesToBase64url, base64urlToBytes, concatBytes } from './utils';

const CHUNK_SIZE = 5 * 1024 * 1024; // 5MB

/** Generate a random 16-byte file ID. */
export function generateFileId(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(16));
}

/** Generate a random 32-byte file encryption key. */
export function generateFileKey(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

/** Derive a file envelope queueId from a fileId (hex string). */
export async function deriveFileQueueId(fileIdHex: string): Promise<string> {
  const data = new TextEncoder().encode('dme-file:' + fileIdHex);
  return bytesToBase64url(sha256(data));
}

/** Derive a 12-byte AES-GCM nonce from fileId + chunkIndex. */
function deriveNonce(fileId: Uint8Array, chunkIndex: number): Uint8Array {
  const nonce = new Uint8Array(12);
  nonce.set(fileId.slice(0, 8), 0);  // first 8 bytes of fileId
  const view = new DataView(nonce.buffer);
  view.setUint32(8, chunkIndex, false);  // big-endian chunk index at bytes 8-11
  return nonce;
}

/** Encrypt one chunk with AES-256-GCM. Returns ciphertext Uint8Array. */
export async function encryptChunk(
  plaintext: Uint8Array,
  fileKey: Uint8Array,
  fileId: Uint8Array,
  chunkIndex: number,
): Promise<Uint8Array> {
  const nonce = deriveNonce(fileId, chunkIndex);
  const ciphertext = gcm(fileKey, nonce).encrypt(plaintext);
  return ciphertext;
}

/** Decrypt one chunk with AES-256-GCM. Returns plaintext Uint8Array. */
export async function decryptChunk(
  ciphertext: Uint8Array,
  fileKey: Uint8Array,
  fileId: Uint8Array,
  chunkIndex: number,
): Promise<Uint8Array> {
  const nonce = deriveNonce(fileId, chunkIndex);
  const plaintext = gcm(fileKey, nonce).decrypt(ciphertext);
  return plaintext;
}

/** Compute SHA-256 of data, return hex string. */
export function computeSha256(data: Uint8Array): string {
  return bytesToHex(sha256(data));
}
