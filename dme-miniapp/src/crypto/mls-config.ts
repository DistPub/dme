/**
 * crypto/mls-config.ts - Central MLS configuration constants.
 *
 * All DME MLS groups use cipher suite 1 (DHKEM-X25519 / AES128GCM /
 * SHA-256 / Ed25519). The noble crypto provider is used for Safari < 17
 * compatibility (no WebCrypto dependency).
 *
 * ⚠️ 这里**不再**提供 `getMlsImpl()`。它曾经调用
 *    `getCiphersuiteImpl(cs, nobleCryptoProvider)`，而后者内部会
 *    `new HkdfSha256()` / `new CipherSuite()`（来自被 stub 成 false 的 `@hpke/core`），
 *    真机表现为 `undefined is not a constructor (evaluating 'new Ys.HkdfSha256()')`。
 *
 *    CiphersuiteImpl 的唯一合法来源是 `crypto/mls-noble-kdf.ts` 的 `getNobleMlsImpl()`。
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

