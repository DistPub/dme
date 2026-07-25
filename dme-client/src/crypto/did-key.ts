/**
 * crypto/did-key.ts - X25519 public key did:key encoding.
 *
 * Encodes X25519 public keys as did:key URIs and multibase strings using
 * the standard multicodec varint for x25519-pub. The same encoding is
 * used by the @atproto/identity DidResolver when expanding a PLC
 * document's verificationMethods into a DID document's publicKeyMultibase
 * field, so values produced here round-trip through atproto DID
 * resolution unchanged.
 *
 * Encoding:
 *   - Multicodec codepoint for x25519-pub: 0xec (236)
 *   - Uvarint(0xec) = [0xec, 0x01]  (236 >= 128, so two bytes)
 *   - multibase:  'z' + base58btc([0xec, 0x01] + 32-byte-key)
 *   - did:key:    'did:key:' + multibase
 *
 * @scure/base exports the Bitcoin base58 alphabet under the name `base58`
 * (this is base58btc).
 */

import { base58 } from '@scure/base';

/** Multibase prefix for base58btc. */
const MULTIBASE_BASE58BTC_PREFIX = 'z';

/** did:key URI scheme prefix. */
const DID_KEY_PREFIX = 'did:key:';

/**
 * Multicodec varint for x25519-pub (codepoint 0xec = 236).
 *
 * 236 >= 128, so unsigned-varint encoding is two bytes:
 *   low 7 bits (0x6c) + continuation bit -> 0xec
 *   remaining bits (1)                    -> 0x01
 */
const X25519_MULTICODEC_VARINT = new Uint8Array([0xec, 0x01]);

/** Total length of a multicodec-prefixed X25519 public key: 2 + 32. */
const X25519_MULTICODEC_KEY_LENGTH = X25519_MULTICODEC_VARINT.length + 32;

/**
 * Encode an X25519 public key as a multibase string (`z...`).
 *
 * @param pubKey - 32-byte X25519 public key.
 * @returns multibase string, e.g. `z6LSphwcdxk3...`.
 * @throws if pubKey is not exactly 32 bytes.
 */
export function x25519PubToMultibase(pubKey: Uint8Array): string {
  if (pubKey.length !== 32) {
    throw new Error(
      `did-key: X25519 public key must be 32 bytes, got ${pubKey.length}`,
    );
  }
  const prefixed = new Uint8Array(X25519_MULTICODEC_KEY_LENGTH);
  prefixed.set(X25519_MULTICODEC_VARINT, 0);
  prefixed.set(pubKey, X25519_MULTICODEC_VARINT.length);
  return MULTIBASE_BASE58BTC_PREFIX + base58.encode(prefixed);
}

/**
 * Decode a multibase string (`z...`) into an X25519 public key.
 *
 * Verifies the base58btc multibase prefix and the x25519-pub multicodec
 * varint.
 *
 * @param mb - multibase string, e.g. `z6LSphwcdxk3...`.
 * @returns 32-byte X25519 public key.
 * @throws if the string is not a valid X25519 multibase encoding.
 */
export function multibaseToX25519Pub(mb: string): Uint8Array {
  if (!mb.startsWith(MULTIBASE_BASE58BTC_PREFIX)) {
    throw new Error(
      `did-key: expected base58btc multibase prefix "z", got "${mb[0] ?? ''}"`,
    );
  }
  const raw = base58.decode(mb.slice(MULTIBASE_BASE58BTC_PREFIX.length));
  if (raw.length !== X25519_MULTICODEC_KEY_LENGTH) {
    throw new Error(
      `did-key: expected ${X25519_MULTICODEC_KEY_LENGTH} bytes after ` +
        `multicodec prefix, got ${raw.length}`,
    );
  }
  if (
    raw[0] !== X25519_MULTICODEC_VARINT[0] ||
    raw[1] !== X25519_MULTICODEC_VARINT[1]
  ) {
    throw new Error(
      `did-key: not an X25519 multicodec prefix ` +
        `(expected 0xec 0x01, got 0x${raw[0].toString(16)} 0x${raw[1].toString(16)})`,
    );
  }
  return raw.slice(X25519_MULTICODEC_VARINT.length);
}

/**
 * Encode an X25519 public key as a did:key URI (`did:key:z...`).
 *
 * @param pubKey - 32-byte X25519 public key.
 * @returns did:key URI, e.g. `did:key:z6LSphwcdxk3...`.
 */
export function x25519PubToDidKey(pubKey: Uint8Array): string {
  return DID_KEY_PREFIX + x25519PubToMultibase(pubKey);
}

/**
 * Decode a did:key URI (`did:key:z...`) into an X25519 public key.
 *
 * @param didKey - did:key URI.
 * @returns 32-byte X25519 public key.
 * @throws if the URI is not a valid X25519 did:key.
 */
export function didKeyToX25519Pub(didKey: string): Uint8Array {
  if (!didKey.startsWith(DID_KEY_PREFIX)) {
    throw new Error(`did-key: not a did:key URI: ${didKey}`);
  }
  return multibaseToX25519Pub(didKey.slice(DID_KEY_PREFIX.length));
}
