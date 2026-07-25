/**
 * crypto/constants.ts - DME 协议加密常量。
 *
 * Double Ratchet 状态机参数 + QueueID 派生参数。
 */

// ---------------------------------------------------------------------------
// Double Ratchet
// ---------------------------------------------------------------------------

export const RATCHET_KDF = 'HKDF-SHA256' as const;
export const RATCHET_AEAD = 'AES-256-GCM' as const;
export const DH_CURVE = 'X25519' as const;
export const KDF_RK_INFO = 'DME-RK' as const;
export const KEY_LENGTH = 32;
export const GCM_NONCE_LENGTH = 12;
export const GCM_TAG_LENGTH = 16;
export const KDF_CK_MESSAGE_KEY: Uint8Array = new Uint8Array([0x01]);
export const KDF_CK_NEXT_CHAIN_KEY: Uint8Array = new Uint8Array([0x02]);
export const MKSKIPPED_MAX = 1000;

// ---------------------------------------------------------------------------
// QueueID 派生
// ---------------------------------------------------------------------------

export const QUEUEID_HASH = 'SHA-256' as const;
export const QUEUEID_SALT = 'DME-QueueID-v1' as const;

// ---------------------------------------------------------------------------
// DID document
// ---------------------------------------------------------------------------

export const DME_ENCRYPTION_KEY_ID = '#dme_encryption' as const;
export const DME_ENCRYPTION_KEY_TYPE = 'Multikey' as const;

// ---------------------------------------------------------------------------
// 轮询参数
// ---------------------------------------------------------------------------

export const POLL_MIN_INTERVAL_MS = 5 * 1000;
export const POLL_MAX_INTERVAL_MS = 15 * 1000;
export const QUEUEID_LRU_MAX = 1000;
