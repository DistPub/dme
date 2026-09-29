/**
 * crypto/mls-config.ts - Central MLS configuration constants.
 *
 * All DME MLS groups use cipher suite 1 (DHKEM-X25519 / AES128GCM /
 * SHA-256 / Ed25519). The actual CiphersuiteImpl is assembled by hand in
 * `mls-noble-kdf.ts` using pure-JS @noble primitives, with no dependency on
 * WebCrypto `subtle`.
 */

/** MLS cipher suite - DHKEM-X25519 + AES-128-GCM + SHA-256 + Ed25519. */
export const MLS_CIPHERSUITE_NAME =
  'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519' as const;

/** Prefix for random group IDs. */
export const MLS_GROUP_ID_PREFIX = 'dme-';

/** Label for Welcome queueId derivation (domain separation). */
export const WELCOME_QUEUEID_LABEL = 'dme-welcome';

/** Label for message queueId derivation (domain separation). */
export const MESSAGE_QUEUEID_LABEL = 'DME-lookup';

/** KeyPackage lifetime in days (informational; defaultLifetime used). */
export const KEYPACKAGE_LIFETIME_DAYS = 7;

/** Size of the KeyPackage pool per user. */
export const KEYPACKAGE_POOL_SIZE = 5;

/** QueueID length in bytes. */
export const QUEUEID_LENGTH = 32;
