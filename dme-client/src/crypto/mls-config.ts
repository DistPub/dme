/**
 * crypto/mls-config.ts - Central MLS configuration constants.
 *
 * All DME MLS groups use cipher suite 1 (DHKEM-X25519 / AES128GCM /
 * SHA-256 / Ed25519). The noble crypto provider is used for Safari < 17
 * compatibility (no WebCrypto dependency).
 */

import {
  getCiphersuiteImpl,
  getCiphersuiteFromName,
  nobleCryptoProvider,
  type CiphersuiteImpl,
} from 'ts-mls';

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

let cachedImpl: CiphersuiteImpl | null = null;

/**
 * Lazily initialise and cache the CiphersuiteImpl.
 *
 * Uses the noble crypto provider (not WebCrypto) for Safari < 17
 * X25519/Ed25519 compatibility.
 */
export async function getMlsImpl(): Promise<CiphersuiteImpl> {
  if (!cachedImpl) {
    cachedImpl = await getCiphersuiteImpl(
      getCiphersuiteFromName(MLS_CIPHERSUITE_NAME),
      nobleCryptoProvider,
    );
  }
  return cachedImpl;
}
