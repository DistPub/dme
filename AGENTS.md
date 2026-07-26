# AGENTS.md

- 输出或提示优先用中文。
- 开始回答前先说"帅哥是这样的"

---

# DME 项目知识库

**Generated:** 2026-07-26
**Commit:** 2df9dcf
**Branch:** main

## 概述

DME (Decentralized Message Envelope) 是基于 AT Protocol (Bluesky) 的端到端加密私信系统。用户通过 Bluesky 账号登录，在 DID 文档中声明 X25519 公钥，经 QR 码握手建立 Double Ratchet 加密会话，密文以 `dme.queue.envelope` 记录写入 PDS，经 Jetstream 被 server 消费索引，客户端轮询盲查获取消息。

三个完全独立的系统，无共享配置，无 workspace：

```
dme/
├── dme-client/     Expo + RN Skia 移动 App（TS strict, Bun）
├── dme-server/     Go AppView - Jetstream 消费 + BadgerDB KV + 批量盲查
└── dme-gateway/    Cloudflare Worker - 反向代理（47 行，0 运行时依赖）
```

## 数据流

```
Alice 发消息:
  Client encrypt -> PDS createRecord -> Jetstream -> dme-server 存入 BadgerDB (7天TTL)

Bob 收消息:
  Client 轮询 -> gateway (隐式 IP 剥离) -> dme-server batchGet -> 返回密文 -> 本地解密
```

## 快速定位

| 任务 | 位置 |
|---|---|
| 加密算法 | `dme-client/src/crypto/ratchet.ts` (570 行 Double Ratchet) |
| QueueID 派生 | `dme-client/src/crypto/queue-id.ts` |
| 握手流程 | `dme-client/src/handshake/handshake.ts` |
| 全局状态 | `dme-client/src/state/AppContext.tsx` (526 行，14 个 action) |
| 消息轮询 | `dme-client/src/poll/poller.ts` |
| 存储 schema | `dme-client/src/storage/db.ts` |
| DID 公钥读写 | `dme-client/src/atproto/did.ts` |
| PDS 记录写入 | `dme-client/src/atproto/pds.ts` |
| HTTP 端点 | `dme-server/internal/server/server.go` (2 个端点) |
| BadgerDB 存储 | `dme-server/internal/store/store.go` |
| Jetstream 消费 | `dme-server/internal/jetstream/consumer.go` |
| 网关代理 | `dme-gateway/src/index.ts` |

## 关键代码符号

| 符号 | 类型 | 位置 | 角色 |
|---|---|---|---|
| `DoubleRatchet` | class | ratchet.ts | encrypt/decrypt 状态机核心 |
| `deriveQueueId` | func | queue-id.ts | SHA-256 消息查找键派生 |
| `DmeHandshake` | class | handshake.ts | X3DH 握手 initiate/accept |
| `DmePoller` | class | poller.ts | 定时轮询 + LRU 去重 |
| `DmeStorage` | class | db.ts | AsyncStorage 持久化 |
| `AppProvider` | component | AppContext.tsx | 全局状态中心 |
| `IdentityKey` | interface | identity.ts | X25519 身份密钥对 |
| `encryptMessage` | func | envelope.ts | 消息加密 + DmeEnvelope 构造 |
| `Store` | struct | store.go | BadgerDB Put/Get/GetBatch |
| `Consumer` | struct | consumer.go | Jetstream WebSocket 消费 |
| `Handler` | method | server.go | HTTP 路由 + CORS |

## 约定

- **包管理器**: TS 侧统一 Bun，Go 侧标准 go 工具链
- **TypeScript**: `strict: true`（两个 TS 项目都是）
- **Go**: 1.22，仅 2 个直接依赖（badger/v4 + coder/websocket），无框架
- **加密库**: @noble/curves + @noble/hashes + @noble/ciphers（非 WebCrypto，因 Safari < 17 不支持 X25519）
- **日志**: Go 用 `log/slog` JSON 输出；TS 用 `console.log`（生产代码中 37 处）
- **错误处理**: Go 用 `fmt.Errorf("...: %w", err)` 包装；TS 用 `throw new Error("prefix: ...")`
- **命名导出**: TS 统一 `export function/class`，无 default export（除 App.tsx 和 CF Worker）
- **无测试/lint/格式化**: 三个系统均无测试框架、lint 配置、prettier

## 反模式（禁止）

- **`as any`**: 3 处在 UI 文件中解析 DID 文档（ChatListScreen:106, ChatViewScreen:67, QrScanScreen:46）— 应做类型收窄
- **空 catch 块**: 8 处 `} catch {}` 静默吞错（ChatListScreen:113, ChatViewScreen:71, QrScanScreen:51 等）
- **`_ =` 丢弃错误**: Go server.go 中 4 处 `_ = json.NewEncoder(w).Encode(...)`
- **硬编码 URL**: `config.ts` 和 `did.ts` 中重复硬编码 `plc.directory`
- **私钥明文存储**: X25519 私钥以 base64 存在 AsyncStorage，无 Secure Enclave
- **`console.log` 泄露**: poller.ts 中 15 处 console.log 输出 queueId 和明文预览

## 死代码

| 文件 | 说明 |
|---|---|
| `src/handshake/wait.ts` | `waitForHandshake()` 0 处引用，实际用 30s 间隔轮询替代 |
| `src/ui/TextInputOverlay.tsx` | 0 处引用，所有屏幕直接用 RN TextInput |
| `@atproto/crypto` 依赖 | package.json 中有但源码无 import |
| `qr` 依赖 | package.json 中有但源码无 import |

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
- **RootStackParamList**: 在 6 个文件中重复定义，未集中导出
- **Go 模块路径**: `github.com/dme/dme-server` 不可外部解析，仅本地使用
- **dme.db/**: 运行时自动创建的 BadgerDB 数据目录，已 gitignored
