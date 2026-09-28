# AGENTS.md

- 输出或提示优先用中文。
- 开始回答前先说"帅哥是这样的"

---

# dme-client/src/crypto

MLS (RFC 9420) 加密模块。13 个文件。使用 ts-mls + @noble 库（纯 JS，小程序无 WebCrypto）。

## 快速定位

| 任务 | 位置 |
|---|---|
| 改 MLS 密码套件 | `mls-config.ts`（`MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519`） |
| 改 MLS 纯 JS 密码套件组装 | `mls-noble-kdf.ts`（`getNobleMlsImpl()`：**五字段全部手工纯 JS 提供**，唯一合法来源） |
| 改 MLS 随机数 | `rng.ts`（`nobleRng`：`@noble/hashes` 的 `randomBytes` + 兜底） |
| 改 MLS 会话管理 | `mls-session.ts`（MlsSession 类：创建/加入/加人/删人/加解密/序列化） |
| 改 QueueID 派生 | `mls-queue-id.ts`（Welcome queueId + Message queueId） |
| 改 MLS 凭证 | `mls-credential.ts`（DID 凭证 + AuthenticationService） |
| 改 KeyPackage 管理 | `keypackage.ts`（生成/加密/解密/序列化） |
| 改身份密钥管理 | `identity.ts`（Ed25519 签名 + X25519 加密双密钥对） |
| 改身份备份 | `backup.ts`（PBKDF2+AES-GCM 加密/解密 FullBackupData） |
| 改 did:key 编码 | `did-key.ts`（Ed25519 + X25519 编解码） |
| 改文件加密 | `file-crypto.ts`（逐块 AES-256-GCM 加解密 + SHA-256 + queueId 派生） |

## 文件清单

| 文件 | 行数 | 职责 |
|---|---|---|
| `mls-config.ts` | 34 | MLS 常量 + `MLS_CIPHERSUITE_NAME`（`getMlsImpl()` 已删除，见下方禁止项） |
| `mls-noble-kdf.ts` | ~150 | `nobleHkdfSha256`（纯 JS HKDF-SHA256）+ `createNobleHash()` + `createNobleSignature()` + `getNobleMlsImpl()`（**五字段全部手工纯 JS 组装**的 CiphersuiteImpl） |
| `hpke-noble.ts` | ~300 | 纯 JS RFC 9180 HPKE（DHKEM-X25519 / HKDF-SHA256 / AES-128-GCM，base mode），`createNobleHpke()` |
| `rng.ts` | ~40 | `nobleRng`：ts-mls `Rng` 接口的纯 JS 实现 |
| `mls-credential.ts` | 70 | DID 基础 MLS 凭证 + AuthenticationService |
| `mls-queue-id.ts` | 66 | Welcome queueId (SHA-256) + Message queueId (MLS exporter) |
| `mls-session.ts` | 255 | MlsSession 类：createAsFounder / joinViaWelcome / addMember / removeMember / updateOwnLeaf / encrypt / decrypt / serialize / deserialize |
| `keypackage.ts` | 196 | KeyPackage 生成、X25519+AES-256-GCM 加密/解密、MLS wire 编解码、QR 序列化 |
| `identity.ts` | 131 | IdentityKeys（Ed25519 + X25519 双密钥对）+ 导出/导入 |
| `backup.ts` | ~120 | FullBackupData 加密/解密：PBKDF2-SHA256(100k iter)+AES-256-GCM，备份范围含身份密钥+MLS会话+KeyPackage池+群聊元数据 |
| `did-key.ts` | 150 | Ed25519 / X25519 did:key 编解码 |
| `file-crypto.ts` | 59 | 文件逐块加密：generateFileId(16B) / generateFileKey(32B) / encryptChunk / decryptChunk / deriveFileQueueId / computeSha256 |
| `utils.ts` | 45 | bytesToHex / hexToBytes / bytesToBase64url / base64urlToBytes / concatBytes / bytesToBase64 |

## 核心算法

**密码套件**: `MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519`（ID 1），零额外依赖。

**Message QueueID**: `mlsExporter(exporterSecret, "DME-lookup", senderLeafIndex || generation, 32)` -- 盲查保留，服务器仅见不透明哈希。

**Welcome QueueID**: `SHA-256("dme-welcome:" || keyPackage.initKey)` -- 仅发起方和接收方可计算。

**KeyPackage 加密**: X25519 ECDH + AES-256-GCM，接收方 X25519 公钥加密，确保仅目标可解。

**密钥树索引**: ts-mls 的 `secretTree` 按**树位置**索引（0, 2, 4...），LeafIndex 需乘 2。`getExpectedGeneration(leafIndex)` 内部使用 `leafIndex * 2`。

**文件加密**: 逐块 AES-256-GCM（`@noble/ciphers/aes` 的 `gcm(key, nonce).encrypt/decrypt`），fileKey 随机 32 字节，fileId 随机 16 字节。nonce = fileId 前 8 字节 + chunkIndex 4 字节大端（12 字节）。fileKey 不从 MLS exporter secret 派生（跨 epoch 安全）。fileQueueId 派生（`deriveFileQueueId` = SHA-256("dme-file:" + fileIdHex) -> base64url）已废弃：blob 引用现随 manifest envelope 同一条 record 传输，无需独立 file envelope 盲查。

## 约定

- **@noble 库**: `@noble/curves/ed25519`（Ed25519 + X25519）、`@noble/hashes`（SHA-256/HKDF/HMAC）、`@noble/ciphers`（AES-GCM）
- **CiphersuiteImpl 取用（硬性）**: 所有需要 CiphersuiteImpl 的地方**必须**用 `getNobleMlsImpl()`（`mls-noble-kdf.ts`）。它内部**五个字段全部手工纯 JS 提供**。
  - 🚫 **禁止**调用 `nobleCryptoProvider`、`defaultCryptoProvider`、`getCiphersuiteImpl()`、`getMlsImpl()`（后者已从 `mls-config.ts` 删除）。
  - 🚫 **禁止**「先取 baseImpl 再 spread 覆盖」的写法（曾经就是这么写的，真机必崩）。
  - 原因：`config/index.ts` 把 `@hpke/*` alias 成 `false`。而 ts-mls 的
    `noble/makeKdfImpl.js`、`noble/makeDhKem.js`、`noble/makeAead.js`、`noble/makeHpke.js`
    **都只是 `export * from "../default/....js"`**，其 default 实现里：
    ```js
    import { HkdfSha256, ... } from "@hpke/core";   // → undefined
    return new HkdfSha256();                        // → TypeError
    ```
    `makeKdf()` 是**同步函数**，在 provider 内部立即求值，**早于**任何 spread 覆盖。
    真机报错原文：`TypeError: undefined is not a constructor (evaluating 'new Ys.HkdfSha256()')`。
- **signature 必须走纯 JS**: `createNobleSignature()` 直接写死 `@noble/curves/ed25519`，**不做任何 `crypto.subtle` 探测**（ts-mls 原版会探，探到就走 WebCrypto 崩溃）。
- **ts-mls**: RFC 9420 TypeScript 实现，提供 createGroup / joinGroup / createCommit / processPrivateMessage / createApplicationMessage 等
- **Uint8Array**: 所有密钥/密文载体，非 Buffer
- **序列化**: `serialize()`/`deserialize()` 用 `encodeGroupState`/`decodeGroupState` 转 base64url 存 AsyncStorage
- **私钥明文存储**: X25519/Ed25519 私钥以 base64 存在 AsyncStorage，无 Secure Enclave（已知限制）。支持密码加密备份到 PDS（`backup.ts`）
- **generation 编码**: QueueID 派生时 generation 用 4 字节 uint32 大端编码
