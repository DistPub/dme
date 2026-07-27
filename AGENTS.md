# AGENTS.md

- 输出或提示优先用中文。
- 开始回答前先说"帅哥是这样的"

---

# DME 项目知识库

**Generated:** 2026-07-27

## 概述

DME (Decentralized Message Envelope) 是基于 AT Protocol (Bluesky) 的端到端加密私信系统。用户通过 Bluesky 账号登录，在 DID 文档中声明 X25519 + Ed25519 公钥，经 QR 码握手建立 MLS (RFC 9420) 加密会话，密文以 `dme.queue.envelope` 记录写入 PDS，经 Jetstream 被 server 消费索引，客户端轮询盲查获取消息。

三个完全独立的系统，无共享配置，无 workspace：

```
dme/
├── dme-client/     Expo + RN Skia 移动 App（TS strict, Bun）
├── dme-server/     Go AppView - Jetstream 消费 + BadgerDB KV + 批量盲查
└── dme-gateway/    Cloudflare Worker - 反向代理（47 行，0 运行时依赖）
```

## 数据流

```
握手:
  Alice 生成 KeyPackage -> Bob X25519 公钥加密 -> QR 码
  Bob 扫码 -> 创建 MLS 群组 -> Add(Alice) -> Welcome 存入 PDS
  Alice 轮询 Welcome -> joinGroup -> 会话建立

发消息:
  Client MLS encrypt -> PDS createRecord -> Jetstream -> dme-server 存入 BadgerDB (7天TTL)

收消息:
  Client 轮询 batchSize 个 future queueId -> gateway -> dme-server batchGet -> 返回密文 -> 本地解密
```

## 快速定位

| 任务 | 位置 |
|---|---|
| MLS 会话管理 | `dme-client/src/crypto/mls-session.ts` (255 行 MlsSession 类) |
| MLS 密码套件配置 | `dme-client/src/crypto/mls-config.ts` |
| MLS 凭证 | `dme-client/src/crypto/mls-credential.ts` |
| QueueID 派生 | `dme-client/src/crypto/mls-queue-id.ts` |
| KeyPackage 加密 | `dme-client/src/crypto/keypackage.ts` |
| 身份密钥管理 | `dme-client/src/crypto/identity.ts` (Ed25519 + X25519 双密钥) |
| did:key 编解码 | `dme-client/src/crypto/did-key.ts` |
| 握手流程 | `dme-client/src/handshake/handshake.ts` |
| 全局状态 | `dme-client/src/state/AppContext.tsx` (12 字段，11 action) |
| 消息轮询 | `dme-client/src/poll/poller.ts` |
| 存储 schema | `dme-client/src/storage/db.ts` |
| DID 公钥读写 | `dme-client/src/atproto/did.ts` (declareKeys + getRemoteEncryptionKey + getRemoteSigningKey) |
| PDS 记录写入 | `dme-client/src/atproto/pds.ts` |
| 设置页面 | `dme-client/src/ui/SettingsScreen.tsx` |
| HTTP 端点 | `dme-server/internal/server/server.go` (2 个端点) |
| BadgerDB 存储 | `dme-server/internal/store/store.go` |
| Jetstream 消费 | `dme-server/internal/jetstream/consumer.go` |
| 网关代理 | `dme-gateway/src/index.ts` |

## 关键代码符号

| 符号 | 类型 | 位置 | 角色 |
|---|---|---|---|
| `MlsSession` | class | mls-session.ts | MLS 群组会话：创建/加入/加解密/序列化 |
| `getMlsImpl` | func | mls-config.ts | 缓存 CiphersuiteImpl（MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519） |
| `generateKeyPackageForUser` | func | keypackage.ts | 生成 KeyPackage 对 |
| `encryptKeyPackage` | func | keypackage.ts | X25519 ECDH + AES-256-GCM 加密 KeyPackage |
| `deriveMessageQueueId` | func | mls-queue-id.ts | MLS exporter secret 派生盲查 queueId |
| `deriveWelcomeQueueId` | func | mls-queue-id.ts | SHA-256(initKey) 派生 Welcome queueId |
| `createDidCredential` | func | mls-credential.ts | DID -> MLS BasicCredential |
| `DmePoller` | class | poller.ts | 批量轮询 + LRU 去重 + 按 generation 排序 |
| `DmeStorage` | class | db.ts | AsyncStorage 持久化 |
| `AppProvider` | component | AppContext.tsx | 全局状态中心 |
| `declareKeys` | func | did.ts | PLC 操作发布 Ed25519 + X25519 到 DID 文档 |
| `Store` | struct | store.go | BadgerDB Put/Get/GetBatch |
| `Consumer` | struct | consumer.go | Jetstream WebSocket 消费 |
| `Handler` | method | server.go | HTTP 路由 + CORS |

## 约定

- **加密**: MLS (RFC 9420) + ts-mls 库。密码套件 `MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519`
- **DID 双公钥**: `#dme_encryption`(X25519) 加密 KeyPackage + `#dme_signing`(Ed25519) MLS 凭证验证
- **KeyPackage**: 不上 PDS，QR 点对点传递（接收方 X25519 公钥加密），无原子消费问题
- **包管理器**: TS 侧统一 Bun，Go 侧标准 go 工具链
- **TypeScript**: `strict: true`（两个 TS 项目都是）
- **Go**: 1.22，仅 2 个直接依赖（badger/v4 + coder/websocket），无框架
- **加密库**: ts-mls + @noble/curves + @noble/hashes + @noble/ciphers（非 WebCrypto，因 Safari < 17 不支持 X25519）
- **日志**: Go 用 `log/slog` JSON 输出；TS 用 `console.error`/`console.warn`（仅错误和警告）
- **错误处理**: Go 用 `fmt.Errorf("...: %w", err)` 包装；TS 用 `throw new Error("prefix: ...")`
- **命名导出**: TS 统一 `export function/class`，无 default export（除 App.tsx 和 CF Worker）
- **无测试/lint/格式化**: 三个系统均无测试框架、lint 配置、prettier
- **私钥明文存储**: X25519/Ed25519 私钥以 base64 存在 AsyncStorage，无 Secure Enclave（已知限制）

## 命令

```bash
# dme-client
cd dme-client && bun install && bun run dev          # expo start
cd dme-client && bun run web                          # web only

# dme-server
cd dme-server && go run main.go --addr :8080 --db ./dme.db --jetstream wss://jetstream1.us-east.bsky.network

# dme-gateway
cd dme-gateway && cp wrangler.toml.example wrangler.toml && bun install && bun run dev
cd dme-gateway && bun run deploy                      # wrangler deploy
```

## 注意事项

- **Lexicon key**: 实际 JSON 文件中 `"key": "tid"`（AT Protocol 自动生成时间戳 rkey），非 `literal:self`
- **Gateway IP 剥离**: 未显式实现 header 剥离，靠 CF 边缘 IP 隐式隔离（`proxy()` 只转发 body + Content-Type）
- **Skia 渲染范围**: 仅 `SkiaButton` 和屏幕背景 `<Canvas><Fill/></Canvas>` 用 Skia；`MessageBubble` 是原生 RN View/Text
- **Go 模块路径**: `dme/dme-server`（本地路径，非 GitHub）
- **dme.db/**: 运行时自动创建的 BadgerDB 数据目录，已 gitignored
- **secretTree 索引**: ts-mls 的 SecretTree 按树位置索引（0=leaf0, 1=parent, 2=leaf1），`getExpectedGeneration` 内部用 `leafIndex * 2`
- **轮询批量预计算**: poller 默认预计算 3 个 future queueId，可在 Settings 页面调整（1-20）
