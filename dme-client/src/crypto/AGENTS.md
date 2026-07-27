# AGENTS.md

- 输出或提示优先用中文。
- 开始回答前先说"帅哥是这样的"

---

# dme-client/src/crypto

MLS (RFC 9420) 加密模块。8 个文件。使用 ts-mls + @noble 库（非 WebCrypto，因 Safari < 17 不支持 X25519）。

## 快速定位

| 任务 | 位置 |
|---|---|
| 改 MLS 密码套件 | `mls-config.ts`（`MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519`） |
| 改 MLS 会话管理 | `mls-session.ts`（MlsSession 类：创建/加入/加人/删人/加解密/序列化） |
| 改 QueueID 派生 | `mls-queue-id.ts`（Welcome queueId + Message queueId） |
| 改 MLS 凭证 | `mls-credential.ts`（DID 凭证 + AuthenticationService） |
| 改 KeyPackage 管理 | `keypackage.ts`（生成/加密/解密/序列化） |
| 改身份密钥管理 | `identity.ts`（Ed25519 签名 + X25519 加密双密钥对） |
| 改 did:key 编码 | `did-key.ts`（Ed25519 + X25519 编解码） |

## 文件清单

| 文件 | 行数 | 职责 |
|---|---|---|
| `mls-config.ts` | 44 | MLS 常量 + `getMlsImpl()` 缓存 CiphersuiteImpl |
| `mls-credential.ts` | 70 | DID 基础 MLS 凭证 + AuthenticationService |
| `mls-queue-id.ts` | 66 | Welcome queueId (SHA-256) + Message queueId (MLS exporter) |
| `mls-session.ts` | 255 | MlsSession 类：createAsFounder / joinViaWelcome / addMember / removeMember / updateOwnLeaf / encrypt / decrypt / serialize / deserialize |
| `keypackage.ts` | 196 | KeyPackage 生成、X25519+AES-256-GCM 加密/解密、MLS wire 编解码、QR 序列化 |
| `identity.ts` | 131 | IdentityKeys（Ed25519 + X25519 双密钥对）+ 导出/导入 |
| `did-key.ts` | 150 | Ed25519 / X25519 did:key 编解码 |
| `utils.ts` | 26 | bytesToHex / bytesToBase64url / base64urlToBytes |

## 核心算法

**密码套件**: `MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519`（ID 1），零额外依赖。

**Message QueueID**: `mlsExporter(exporterSecret, "DME-lookup", senderLeafIndex || generation, 32)` -- 盲查保留，服务器仅见不透明哈希。

**Welcome QueueID**: `SHA-256("dme-welcome:" || keyPackage.initKey)` -- 仅发起方和接收方可计算。

**KeyPackage 加密**: X25519 ECDH + AES-256-GCM，接收方 X25519 公钥加密，确保仅目标可解。

**密钥树索引**: ts-mls 的 `secretTree` 按**树位置**索引（0, 2, 4...），LeafIndex 需乘 2。`getExpectedGeneration(leafIndex)` 内部使用 `leafIndex * 2`。

## 约定

- **@noble 库**: `@noble/curves/ed25519`（Ed25519 + X25519）、`@noble/hashes`（SHA-256/HKDF）、`@noble/ciphers`（AES-GCM）
- **ts-mls**: RFC 9420 TypeScript 实现，提供 createGroup / joinGroup / createCommit / processPrivateMessage / createApplicationMessage 等
- **Uint8Array**: 所有密钥/密文载体，非 Buffer
- **序列化**: `serialize()`/`deserialize()` 用 `encodeGroupState`/`decodeGroupState` 转 base64url 存 AsyncStorage
- **私钥明文存储**: X25519/Ed25519 私钥以 base64 存在 AsyncStorage，无 Secure Enclave（已知限制）
- **generation 编码**: QueueID 派生时 generation 用 4 字节 uint32 大端编码
