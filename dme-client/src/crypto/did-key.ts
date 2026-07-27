/**
 * crypto/did-key.ts - X25519 + Ed25519 public key did:key encoding.
 *
 * Encodes public keys as did:key URIs using standard multicodec varints
 * + base58btc multibase encoding. Values round-trip through
 * @atproto/identity DID resolution unchanged.
 *
 * Encoding:
 *   - X25519  multicodec: 0xec01 (varint [0xec, 0x01])
 *   - Ed25519 multicodec: 0xed01 (varint [0xed, 0x01])
 *   - multibase: 'z' + base58btc(multicodec + 32-byte-key)
 *   - did:key:  'did:key:' + multibase
 */

import { base58 } from '@scure/base';

const MULTIBASE_BASE58BTC_PREFIX = 'z';
const DID_KEY_PREFIX = 'did:key:';

const X25519_MULTICODEC_VARINT = new Uint8Array([0xec, 0x01]);
const ED25519_MULTICODEC_VARINT = new Uint8Array([0xed, 0x01]);
const KEY_LENGTH = 32;

/**
 * Encode a public key as a multibase string with the given multicodec prefix.
 */
function encodeMultibase(pubKey: Uint8Array, prefix: Uint8Array): string {
  if (pubKey.length !== KEY_LENGTH) {
    throw new Error(
      `did-key: public key must be ${KEY_LENGTH} bytes, got ${pubKey.length}`,
    );
  }
  const prefixed = new Uint8Array(prefix.length + KEY_LENGTH);
  prefixed.set(prefix, 0);
  prefixed.set(pubKey, prefix.length);
  return MULTIBASE_BASE58BTC_PREFIX + base58.encode(prefixed);
}

/**
 * Decode a multibase string, verifying the expected multicodec prefix.
 */
function decodeMultibase(mb: string, expectedPrefix: Uint8Array): Uint8Array {
  if (!mb.startsWith(MULTIBASE_BASE58BTC_PREFIX)) {
    throw new Error(
      `did-key: expected base58btc multibase prefix "z", got "${mb[0] ?? ''}"`,
    );
  }
  const raw = base58.decode(mb.slice(MULTIBASE_BASE58BTC_PREFIX.length));
  const expectedLen = expectedPrefix.length + KEY_LENGTH;
  if (raw.length !== expectedLen) {
    throw new Error(
      `did-key: expected ${expectedLen} bytes, got ${raw.length}`,
    );
  }
  if (raw[0] !== expectedPrefix[0] || raw[1] !== expectedPrefix[1]) {
    throw new Error(
      `did-key: wrong multicodec prefix (expected 0x${expectedPrefix[0]!.toString(16)} 0x${expectedPrefix[1]!.toString(16)}, got 0x${raw[0]!.toString(16)} 0x${raw[1]!.toString(16)})`,
    );
  }
  return raw.slice(expectedPrefix.length);
}

// ---------------------------------------------------------------------------
// X25519
// ---------------------------------------------------------------------------

/** Encode an X25519 public key as a did:key URI. */
export function encodeX25519DidKey(publicKey: Uint8Array): string {
  return DID_KEY_PREFIX + encodeMultibase(publicKey, X25519_MULTICODEC_VARINT);
}

/** Decode an X25519 did:key URI to the raw 32-byte public key. */
export function decodeX25519DidKey(didKey: string): Uint8Array {
  if (!didKey.startsWith(DID_KEY_PREFIX)) {
    throw new Error(`did-key: not a did:key URI: ${didKey}`);
  }
  return decodeMultibase(
    didKey.slice(DID_KEY_PREFIX.length),
    X25519_MULTICODEC_VARINT,
  );
}

// ---------------------------------------------------------------------------
// Ed25519
// ---------------------------------------------------------------------------

/** Encode an Ed25519 public key as a did:key URI. */
export function encodeEd25519DidKey(publicKey: Uint8Array): string {
  return DID_KEY_PREFIX + encodeMultibase(publicKey, ED25519_MULTICODEC_VARINT);
}

/** Decode an Ed25519 did:key URI to the raw 32-byte public key. */
export function decodeEd25519DidKey(didKey: string): Uint8Array {
  if (!didKey.startsWith(DID_KEY_PREFIX)) {
    throw new Error(`did-key: not a did:key URI: ${didKey}`);
  }
  return decodeMultibase(
    didKey.slice(DID_KEY_PREFIX.length),
    ED25519_MULTICODEC_VARINT,
  );
}

// ---------------------------------------------------------------------------
// Generic dispatcher
// ---------------------------------------------------------------------------

/** Decoded did:key result with key type identification. */
export interface DecodedDidKey {
  keyType: 'x25519' | 'ed25519';
  publicKey: Uint8Array;
}

/**
 * Decode a did:key URI, auto-detecting the key type from the multicodec prefix.
 *
 * @param didKey - did:key URI.
 * @returns Key type and raw public key.
 * @throws if the multicodec prefix is not X25519 or Ed25519.
 */
export function decodeDidKey(didKey: string): DecodedDidKey {
  if (!didKey.startsWith(DID_KEY_PREFIX)) {
    throw new Error(`did-key: not a did:key URI: ${didKey}`);
  }
  const mb = didKey.slice(DID_KEY_PREFIX.length);
  if (!mb.startsWith(MULTIBASE_BASE58BTC_PREFIX)) {
    throw new Error(
      `did-key: expected base58btc multibase prefix "z", got "${mb[0] ?? ''}"`,
    );
  }
  const raw = base58.decode(mb.slice(MULTIBASE_BASE58BTC_PREFIX.length));
  if (raw.length < 2) {
    throw new Error('did-key: multibase payload too short for multicodec prefix');
  }
  if (raw[0] === X25519_MULTICODEC_VARINT[0] && raw[1] === X25519_MULTICODEC_VARINT[1]) {
    return { keyType: 'x25519', publicKey: decodeMultibase(mb, X25519_MULTICODEC_VARINT) };
  }
  if (raw[0] === ED25519_MULTICODEC_VARINT[0] && raw[1] === ED25519_MULTICODEC_VARINT[1]) {
    return { keyType: 'ed25519', publicKey: decodeMultibase(mb, ED25519_MULTICODEC_VARINT) };
  }
  throw new Error(
    `did-key: unsupported multicodec prefix 0x${raw[0]!.toString(16)} 0x${raw[1]!.toString(16)}`,
  );
}
