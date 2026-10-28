/**
 * crypto/rescue-handshake.ts - 1v1 rescue handshake cryptography.
 *
 * Provides:
 *   - deriveRescueQueueId()   : compute the shared rescue queueId
 *   - encryptRescueMessage()  : seal a RescueMessage for the peer
 *   - decryptRescueMessage()  : open a rescue envelope from the peer
 *
 * The rescue channel is independent of MLS state. It uses the long-term
 * X25519 identity keys (published in each user's DID document) to derive a
 * shared secret and then a queueId. This lets two parties communicate even
 * when their MLS session has silently diverged.
 */

import { x25519, ed25519 } from '@noble/curves/ed25519';
import { gcm } from '@noble/ciphers/aes';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { utf8ToBytes } from '@noble/hashes/utils';

import type { RescueMessage } from '../protocol/rescue';
import { bytesToBase64url, base64urlToBytes } from './utils';

/** AES-GCM nonce length in bytes. */
const GCM_NONCE_LENGTH = 12;

/** HKDF salt for rescue key derivation. */
const RESCUE_HKDF_SALT = 'dme-rescue-v1';

/** Label prefix for domain separation. */
const RESCUE_LABEL = 'dme.rescue.v1';

/** Canonical JSON fields that participate in the signature. */
type SignableRescueFields = Omit<RescueMessage, 'signature'>;

/**
 * Compute the shared X25519 secret between our encryption private key and
 * the peer's encryption public key.
 */
export function computeRescueSharedSecret(
  ourEncPrivateKey: Uint8Array,
  theirEncPublicKey: Uint8Array,
): Uint8Array {
  if (ourEncPrivateKey.length !== 32) {
    throw new Error('rescue: our encryption private key must be 32 bytes');
  }
  if (theirEncPublicKey.length !== 32) {
    throw new Error('rescue: their encryption public key must be 32 bytes');
  }
  return x25519.getSharedSecret(ourEncPrivateKey, theirEncPublicKey);
}

/**
 * Derive the rescue queueId for a 1v1 conversation on a specific date.
 *
 * Inputs:
 *   - sharedSecret : X25519 ECDH output (only both parties can compute this)
 *   - writerDid    : DID of the party that writes to this queueId
 *   - welcomeDate  : YYYY-MM-DD, the day the friendship was established
 *   - today        : YYYY-MM-DD, the current day
 *
 * There are two rescue queueIds per 1v1 conversation:
 *   - rescueQueueId(A): written by A, scanned by B
 *   - rescueQueueId(B): written by B, scanned by A
 *
 * This prevents a device from polling its own rescue message.
 * The queueId changes every day and after every successful rescue handshake
 * (because welcomeDate updates), so stale rescue messages naturally age out.
 */
export function deriveRescueQueueId(
  sharedSecret: Uint8Array,
  writerDid: string,
  welcomeDate: string,
  today: string,
): string {
  const info = `${RESCUE_LABEL}:queueid:${writerDid}:${welcomeDate}:${today}`;
  const derived = hkdf(
    sha256,
    sharedSecret,
    utf8ToBytes(RESCUE_HKDF_SALT),
    utf8ToBytes(info),
    32,
  );
  return bytesToBase64url(derived);
}

/**
 * Derive the AEAD key used to encrypt/decrypt a rescue message.
 *
 * The encryption key depends on writerDid so that the two directions use
 * different keys even though both parties can compute both queueIds.
 */
function deriveRescueMessageKey(
  sharedSecret: Uint8Array,
  writerDid: string,
  welcomeDate: string,
  today: string,
): Uint8Array {
  const info = `${RESCUE_LABEL}:message-key:${writerDid}:${welcomeDate}:${today}`;
  return hkdf(
    sha256,
    sharedSecret,
    utf8ToBytes(RESCUE_HKDF_SALT),
    utf8ToBytes(info),
    32,
  );
}

/**
 * Build the canonical string that gets signed.
 */
function canonicalRescueString(fields: SignableRescueFields): string {
  return JSON.stringify({
    type: fields.type,
    fromDid: fields.fromDid,
    qrData: fields.qrData,
    callbackQueueId: fields.callbackQueueId,
    sentAt: fields.sentAt,
    nonce: fields.nonce,
  });
}

/**
 * Sign the canonical rescue fields with our Ed25519 signing private key.
 */
function signRescueFields(
  fields: SignableRescueFields,
  signingPrivateKey: Uint8Array,
): string {
  const message = utf8ToBytes(canonicalRescueString(fields));
  const signature = ed25519.sign(message, signingPrivateKey);
  return bytesToBase64url(signature);
}

/**
 * Verify a rescue signature with the peer's Ed25519 signing public key.
 */
function verifyRescueSignature(
  fields: SignableRescueFields,
  signatureBase64url: string,
  signingPublicKey: Uint8Array,
): boolean {
  try {
    const message = utf8ToBytes(canonicalRescueString(fields));
    const signature = base64urlToBytes(signatureBase64url);
    return ed25519.verify(signature, message, signingPublicKey);
  } catch {
    return false;
  }
}

/**
 * Create a fresh nonce for a rescue message.
 */
export function createRescueNonce(): string {
  return bytesToBase64url(crypto.getRandomValues(new Uint8Array(16)));
}

/**
 * Seal a RescueMessage for the peer.
 *
 * The plaintext is the canonical JSON of the message. It is signed, then
 * encrypted with an AEAD key derived from the shared secret and dates.
 *
 * @returns base64url-encoded ciphertext (nonce || encrypted).
 */
export function encryptRescueMessage(
  message: SignableRescueFields,
  sharedSecret: Uint8Array,
  writerDid: string,
  welcomeDate: string,
  today: string,
  signingPrivateKey: Uint8Array,
): string {
  const signed: RescueMessage = {
    ...message,
    signature: signRescueFields(message, signingPrivateKey),
  };

  const plaintext = utf8ToBytes(JSON.stringify(signed));
  const key = deriveRescueMessageKey(sharedSecret, writerDid, welcomeDate, today);
  const nonce = crypto.getRandomValues(new Uint8Array(GCM_NONCE_LENGTH));
  const encrypted = gcm(key, nonce).encrypt(plaintext);

  const payload = new Uint8Array(nonce.length + encrypted.length);
  payload.set(nonce, 0);
  payload.set(encrypted, nonce.length);

  return bytesToBase64url(payload);
}

export interface DecryptedRescueMessage {
  message: RescueMessage;
  /** The date (YYYY-MM-DD) used to decrypt the message. */
  decryptedWithToday: string;
}

/**
 * Try to open a rescue ciphertext.
 *
 * Because both sender and receiver know the same sharedSecret and welcomeDate,
 * but the sender also knows which `today` it used, we try the provided today
 * first. If decryption fails we do NOT fall back to other dates — stale
 * messages must be rejected.
 *
 * After decryption the signature is verified and the sentAt freshness is
 * checked (must be within the same day).
 */
export function decryptRescueMessage(
  ciphertextBase64url: string,
  sharedSecret: Uint8Array,
  writerDid: string,
  welcomeDate: string,
  today: string,
  theirSigningPublicKey: Uint8Array,
): DecryptedRescueMessage {
  const ciphertext = base64urlToBytes(ciphertextBase64url);
  if (ciphertext.length < GCM_NONCE_LENGTH) {
    throw new Error('rescue: ciphertext too short');
  }

  const nonce = ciphertext.slice(0, GCM_NONCE_LENGTH);
  const encrypted = ciphertext.slice(GCM_NONCE_LENGTH);

  const key = deriveRescueMessageKey(sharedSecret, writerDid, welcomeDate, today);
  let plaintext: Uint8Array;
  try {
    plaintext = gcm(key, nonce).decrypt(encrypted);
  } catch {
    throw new Error('rescue: decryption failed');
  }

  let parsed: RescueMessage;
  try {
    parsed = JSON.parse(new TextDecoder().decode(plaintext)) as RescueMessage;
  } catch {
    throw new Error('rescue: malformed plaintext');
  }

  if (parsed.type !== 'need_rescue') {
    throw new Error('rescue: unexpected message type');
  }

  const { signature, ...signable } = parsed;
  if (
    !signature ||
    !verifyRescueSignature(signable as SignableRescueFields, signature, theirSigningPublicKey)
  ) {
    throw new Error('rescue: signature verification failed');
  }

  const sentAtDate = parsed.sentAt.slice(0, 10);
  if (sentAtDate !== today) {
    throw new Error('rescue: message is not from today');
  }

  return { message: parsed, decryptedWithToday: today };
}
