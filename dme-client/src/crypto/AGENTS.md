# AGENTS.md

- 输出或提示优先用中文。
- 开始回答前先说"帅哥是这样的"

---

# dme-client/src/crypto

Double Ratchet + X25519 加密模块。6 个文件，~1100 行。使用 @noble 库（非 WebCrypto，因 Safari < 17 不支持 X25519）。

## 快速定位

| 任务 | 位置 |
|---|---|
| 改加密参数 | `constants.ts` |
| 改 Double Ratchet 算法 | `ratchet.ts` (570 行) |
| 改 QueueID 公式 | `queue-id.ts` |
| 改消息序列化格式 | `envelope.ts` |
| 改身份密钥管理 | `identity.ts` |
| 改 did:key 编码 | `did-key.ts` |

## 加密参数（constants.ts）

| 参数 | 值 |
|---|---|
| DH_CURVE | X25519 |
| RATCHET_KDF | HKDF-SHA256 |
| RATCHET_AEAD | AES-256-GCM |
| KDF_RK_INFO | `"DME-RK"` |
| KEY_LENGTH | 32 bytes |
| GCM_NONCE_LENGTH | 12 bytes |
| KDF_CK_MESSAGE_KEY | `0x01` (HMAC 输入) |
| KDF_CK_NEXT_CHAIN_KEY | `0x02` (HMAC 输入) |
| MKSKIPPED_MAX | 1000 (乱序缓存上限) |
| QUEUEID_HASH | SHA-256 |
| QUEUEID_SALT | `"DME-QueueID-v1"` |
| POLL_MIN/MAX | 5s / 15s |
| QUEUEID_LRU_MAX | 1000 |

## 核心算法

**QueueID 公式**: `SHA-256("DME-QueueID-v1" || dhPub[32] || msgNum[uint32 LE] || chainKey[32])` -> hex 64 字符

**KDF_RK**: `HKDF-SHA256(salt=rootKey, ikm=dhOut, info="DME-RK", len=64)` -> `[rootKey, chainKey]`

**KDF_CK**: `messageKey = HMAC-SHA256(chainKey, 0x01)`, `nextChainKey = HMAC-SHA256(chainKey, 0x02)`

**payload 二进制格式**: `nonce[12] || dhPub[32] || prevCount[uint32 LE] || messageNum[uint32 LE] || ciphertext`

**与 Signal Double Ratchet 差异**: 1) 无 PreKey bundle（共享密钥来自 X3DH QR 握手）2) QueueID 作为 PDS 记录键和 AppView 查找键 3) 无单独消息密钥 ratchet

## 约定

- **@noble 库**: `@noble/curves/ed25519`（X25519）、`@noble/hashes`（SHA-256/HKDF/HMAC）、`@noble/ciphers`（AES-GCM）
- **@scure/base**: base58btc multicodec 编码
- **Uint8Array**: 所有密钥/密文载体，非 Buffer
- **`as const`**: 常量文件中所有字符串常量
- **interface**: 用 `interface` 而非 `type`，`Serialized*` 模式用于 JSON 适配
- **序列化**: `serialize()`/`deserialize()` 将 Uint8Array 转 base64 存 AsyncStorage
- **私钥明文存储**: `dhSelfPriv` 和身份私钥以 base64 存在 AsyncStorage，无 Secure Enclave（@noble 库不支持 non-extractable key，已知限制）
- **非恒定时间比较**: `bytesEqual`（ratchet.ts）用于 DH 公钥比较，非密钥材料，安全但非恒定时间
