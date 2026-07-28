# AGENTS.md

- 输出或提示优先用中文。
- 开始回答前先说"帅哥是这样的"

---

# DME 项目知识库

**Generated:** 2026-07-28

## 概述

DME (Decentralized Message Envelope) 是基于 AT Protocol (Bluesky) 的端到端加密私信系统。用户通过 Bluesky 账号登录，在 DID 文档中声明 X25519 + Ed25519 公钥，经 QR 码握手建立 MLS (RFC 9420) 加密会话，密文以 `dme.queue.envelope` 记录写入 PDS，经 Jetstream 被 server 消费索引，客户端轮询盲查获取消息。支持 1v1 和群组聊天。

三个完全独立的系统，无共享配置，无 workspace：

```
dme/
├── dme-client/     Expo + RN Skia 移动 App（TS strict, Bun）
├── dme-server/     Go AppView - Jetstream 消费 + BadgerDB KV + 批量盲查
└── dme-gateway/    Cloudflare Worker - 反向代理（47 行，0 运行时依赖）
```

## 数据流

```
握手 (1:1):
  Alice 生成 KeyPackage -> Bob X25519 公钥加密 -> QR 码
  Bob 扫码 -> 创建 MLS 群组 -> Add(Alice) -> Welcome 存入 PDS
  Alice 轮询 Welcome -> joinGroup -> 会话建立

建群:
  Alice 通过1:1通道发送 group_invite_request 给 Bob/Carol
  成员接受后通过1:1通道发送 group_invite_response (含 KeyPackage)
  Alice 收到响应后点击 Create -> 创建 MLS 群组 -> addMember(accept)
  Alice 通过1:1通道发送 group_welcome + group_commit 给各成员
  成员收到 Welcome -> joinViaWelcome -> 加入群组

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
| 握手流程 (1:1) | `dme-client/src/handshake/handshake.ts` |
| 群聊邀请协议 | `dme-client/src/handshake/group-invite.ts` |
| 群聊消息类型 | `dme-client/src/protocol/group-message.ts` |
| 全局状态 | `dme-client/src/state/AppContext.tsx` (15 字段，16 action) |
| 消息轮询 | `dme-client/src/poll/poller.ts` |
| 存储 schema | `dme-client/src/storage/db.ts` |
| DID 公钥读写 | `dme-client/src/atproto/did.ts` (declareKeys + getRemoteEncryptionKey + getRemoteSigningKey) |
| PDS 记录写入 | `dme-client/src/atproto/pds.ts` |
| 设置页面 | `dme-client/src/ui/SettingsScreen.tsx` |
| 创建群聊 | `dme-client/src/ui/CreateGroupScreen.tsx` |
| 群管理 | `dme-client/src/ui/GroupSettingsScreen.tsx` |
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
| `sendGroupInvites` | action | AppContext.tsx | 通过1:1通道发送群聊邀请 |
| `respondToGroupInvite` | action | AppContext.tsx | 接受/拒绝群聊邀请 |
| `createGroupFromPendingInvites` | action | AppContext.tsx | 从接受的邀请创建 MLS 群组 |
| `addAcceptedMembersToGroup` | action | AppContext.tsx | 向已有群组添加接受邀请的成员 |
| `dissolveGroup` | action | AppContext.tsx | 群主解散群组 |
| `leaveGroup` | action | AppContext.tsx | 成员主动离开群组 |
| `removeMemberFromGroup` | action | AppContext.tsx | 群主移除成员 |
| `createGroupWithMembers` | func | group-invite.ts | 创建 MLS 群组并添加成员（返回 Welcome + Commit） |
| `Store` | struct | store.go | BadgerDB Put/Get/GetBatch |
| `Consumer` | struct | consumer.go | Jetstream WebSocket 消费 |
| `Handler` | method | server.go | HTTP 路由 + CORS |

## 群聊协议

群聊消息通过已有 1:1 MLS 通道传输（JSON 编码），消息类型：

| 类型 | 发送方 | 接收方 | 用途 |
|---|---|---|---|
| `group_invite_request` | 群主 | 成员 | 发送群聊邀请 |
| `group_invite_response` | 成员 | 群主 | 接受/拒绝邀请（含 KeyPackage） |
| `group_welcome` | 群主 | 接受者 | 分发 MLS Welcome（含 Welcome bytes） |
| `group_commit` | 群主 | 已有成员 | 分发 Commit（addMember 产生，更新 ratchet tree） |
| `group_metadata_update` | 群主 | 所有成员 | 广播成员列表更新 |
| `group_dissolved` | 群主 | 所有成员 | 群组解散通知 |
| `group_member_removed` | 群主 | 被移除成员 | 移除通知 |
| `group_member_left` | 离开成员 | 其他成员 | 离开通知 |

## 群组生命周期状态

| 状态 | 含义 | 行为 |
|---|---|---|
| 正常 | 活跃群组 | 可发送/接收消息 |
| `dissolved: true` | 群主解散 | 保留消息，禁止发送 |
| `removed: true` | 被群主移除 | 保留消息，禁止发送 |
| `left: true` | 主动离开 | 保留消息，禁止发送 |

## 约定

- **加密**: MLS (RFC 9420) + ts-mls 库。密码套件 `MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519`
- **DID 双公钥**: `#dme_encryption`(X25519) 加密 KeyPackage + `#dme_signing`(Ed25519) MLS 凭证验证
- **KeyPackage**: 不上 PDS，通过1:1通道或 QR 点对点传递（接收方 X25519 公钥加密）
- **群聊 KeyPackage**: 接受邀请时生成，通过1:1通道发送给群主，群主用来 addMember
- **群聊 Commit**: 每次 addMember 产生的 Commit 必须通过1:1通道发给已有成员（poller 只轮询 application 消息，不轮询 handshake Commit）
- **成员离开**: MLS 禁止自身 removeMember，通过 `group_member_left` 通知其他成员，群主收到后执行 removeMember
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
cd dme-server && go run main.go --addr :8080 --db ./dme.db --jetstream wss://jetstream2.fr.hose.cam
#   --addr      HTTP 监听地址（默认 :8080）
#   --db        BadgerDB 数据目录（默认 ./dme.db，自动创建，已 gitignored）
#   --jetstream Jetstream WSS（按区域选：us-east 1, us-west 2, eu 3）

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
- **群聊消息存储**: 通过 `StoredMessage.conversationId` 指定存储到群聊而非1:1，`kind` 字段区分消息类型
- **群主离线**: 只有群主能 addMember/removeMember，群主离线时无法管理成员
- **群聊创建者**: 群主不能离开群组（MLS 限制 removeMember 不能移除 committer），只能解散
- **浏览器调试现场保护**: 当用户要求「看控制台日志」时，直接使用 `browsermcp_browser_get_console_logs` 抓取当前页面日志，禁止 `browsermcp_browser_navigate` 刷新或跳转页面，避免破坏报错现场
