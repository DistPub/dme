# AGENTS.md

- 输出或提示优先用中文。
- 开始回答前先说"帅哥是这样的"

---

# DME 项目知识库

**Generated:** 2026-07-29

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
| 身份密钥备份 | `dme-client/src/crypto/backup.ts` (PBKDF2+AES-GCM 加密全量备份) |
| did:key 编解码 | `dme-client/src/crypto/did-key.ts` |
| 握手流程 (1:1) | `dme-client/src/handshake/handshake.ts` |
| 群聊邀请协议 | `dme-client/src/handshake/group-invite.ts` |
| 群聊消息类型 | `dme-client/src/protocol/group-message.ts` |
| 全局状态 | `dme-client/src/state/AppContext.tsx` (16 字段，25 action) |
| 消息轮询 | `dme-client/src/poll/poller.ts` |
| 存储 schema | `dme-client/src/storage/db.ts` |
| DID 公钥读写 | `dme-client/src/atproto/did.ts` (`declareKeys` + `getRemoteEncryptionKey` + `getRemoteSigningKey` + `getDidMethod` + `generateDidWebUpdate` + `sharedDidResolver`) |
| DID 解析缓存 | `dme-client/src/atproto/did.ts` (`sharedDidResolver`: 单例 `DidResolver` + `MemoryCache`) |
| PDS 记录写入 | `dme-client/src/atproto/pds.ts` (envelope + identity backup + AppView proxy) |
| AppView proxy 配置 | `dme-client/src/config.ts` (DEFAULT_APPVIEW_PROXY) |
| 按钮组件 | `dme-client/src/ui/Button.tsx`（Pressable+Text，numberOfLines=1，替代 SkiaButton） |
| 主页（聊天列表） | `dme-client/src/ui/ChatListScreen.tsx`（标题"隐世"，顶部栏 +Group/+Friend/头像菜单） |
| 设置页面 | `dme-client/src/ui/SettingsScreen.tsx`（Poll Batch Size + AppView Proxy + Identity Backup） |
| 创建群聊 | `dme-client/src/ui/CreateGroupScreen.tsx` |
| 群管理 | `dme-client/src/ui/GroupSettingsScreen.tsx` |
| 表情反应协议 | `dme-client/src/protocol/reaction.ts`（`ReactionMessage` add/remove） |
| 消息 reactions 存储 | `dme-client/src/storage/db.ts`（`Reaction` + `addReaction`/`removeReaction`） |
| 消息气泡 + reactions | `dme-client/src/ui/MessageBubble.tsx` |
| 表情选择器 | `dme-client/src/ui/EmojiPicker.tsx`（浮层锚定按钮） |
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
| `DmePds` | class | pds.ts | PDS 记录操作 + AppView proxy（agent.configureProxy 设置 atproto-proxy header） |
| `DmeStorage` | class | db.ts | AsyncStorage 持久化（含 appViewProxy 配置） |
| `AppProvider` | component | AppContext.tsx | 全局状态中心 |
| `declareKeys` | func | did.ts | PLC 操作发布 Ed25519 + X25519 到 DID 文档 |
| `getDidMethod` | func | did.ts | 判断 DID 方法类型（plc/web/other） |
| `generateDidWebUpdate` | func | did.ts | 为 did:web 用户生成 DID 文档更新内容（合并 DME 公钥） |
| `sharedDidResolver` | const | did.ts | 单例 `DidResolver`（`plcUrl` + `MemoryCache`），所有 DID 解析统一入口 |
| `markConversationAsRead` | action | AppContext.tsx | 标记某会话所有非自己发送的消息为已读，并递增 `chatListVersion` |
| `resolvedDidsRef` | ref | ChatViewScreen.tsx | `useRef<Set<string>>`，防止群聊 sender handle 重复解析 |
| `encryptBackup` | func | backup.ts | PBKDF2+AES-GCM 加密 FullBackupData -> base64url |
| `decryptBackup` | func | backup.ts | 解密 base64url -> FullBackupData |
| `backupIdentity` | action | AppContext.tsx | 密码加密身份+MLS会话+KeyPackage+群聊元数据，写入 PDS |
| `restoreIdentityFromBackup` | action | AppContext.tsx | 从 PDS 解密恢复全部数据，reload poller sessions |
| `Button` | component | Button.tsx | Pressable+Text 按钮（numberOfLines=1，支持中文，替代 SkiaButton） |
| `setAppViewProxy` | action | AppContext.tsx | 更新 atproto-proxy header 值（持久化 + 实时更新 DmePds） |
| `sendGroupInvites` | action | AppContext.tsx | 通过1:1通道发送群聊邀请 |
| `respondToGroupInvite` | action | AppContext.tsx | 接受/拒绝群聊邀请 |
| `createGroupFromPendingInvites` | action | AppContext.tsx | 从接受的邀请创建 MLS 群组 |
| `addAcceptedMembersToGroup` | action | AppContext.tsx | 向已有群组添加接受邀请的成员 |
| `dissolveGroup` | action | AppContext.tsx | 群主解散群组 |
| `leaveGroup` | action | AppContext.tsx | 成员主动离开群组 |
| `removeMemberFromGroup` | action | AppContext.tsx | 群主移除成员 |
| `Reaction` | interface | db.ts | 表情反应（emoji + did + createdAt），挂在 `StoredMessage.reactions` |
| `ReactionMessage` | interface | reaction.ts | E2E 加密反应协议消息（add/remove，targetMessageId） |
| `sendReaction` | action | AppContext.tsx | toggle 当前用户对某消息的 emoji 反应，MLS 加密发送 |
| `addReaction`/`removeReaction` | method | db.ts | 更新某条消息的 reactions 列表 |
| `MessageBubble` | component | MessageBubble.tsx | 气泡 + reactions pill（合并同 emoji + 计数）+ emoji 触发按钮 |
| `EmojiPicker` | component | EmojiPicker.tsx | 锚定按钮的浮层表情选择器 |
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

## 消息反应

表情反应通过已有 MLS session（1:1 或群聊）加密传输，`type: 'reaction'` JSON 消息：

| 字段 | 说明 |
|---|---|
| `targetMessageId` | 被反应消息的 id（即 MLS queueId） |
| `emoji` | 表情字符串 |
| `action` | `add` / `remove` |
| `conversationId` | 会话 ID（群聊 groupId 或好友 did） |

- 本地先 toggle `StoredMessage.reactions`（`Reaction[]`）再发送，接收端 `handleIncomingMessage` 的 `reaction` 分支直接更新目标消息，不存为文本
- `MessageBubble` 按 emoji 聚合渲染 pill，相同 emoji 合并并显示计数（>1 时小字），当前用户参与的高亮
- Web 无长按：每条文本气泡旁固定 emoji 按钮触发 `EmojiPicker`（`measureInWindow` 锚定浮层）

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
- **表情反应**: `ReactionMessage`（`type: 'reaction'`）走 MLS session 加密，挂 `StoredMessage.reactions`，不存为文本消息
- **成员离开**: MLS 禁止自身 removeMember，通过 `group_member_left` 通知其他成员，群主收到后执行 removeMember
- **Skia 渲染范围**: 仅屏幕背景 `<Canvas><Fill/></Canvas>` 用 Skia；按钮用原生 `Button`（Pressable+Text，支持中文）；头像用 `expo-image`
- **AppView proxy**: PDS 写入通过 `agent.configureProxy()` 设置全局 `atproto-proxy` header，默认值 `did:web:fatesky.hukoubook.com#fatesky_appview`，可在 Settings 页面自定义
- **头像渲染**: `expo-image` 替代 `react-native` Image，`contentFit="cover"` + `overflow: 'hidden'`，加载失败回退 handle 首字母
- **DID 解析**: 统一使用 `atproto/did.ts` 导出的 `sharedDidResolver` 单例（带 `MemoryCache`），禁止直接 `new DidResolver({})` 或绕过缓存直接 fetch PLC directory
- **React hooks 依赖**: UI 屏幕严禁把整个 `AppContext` value 对象放入 `useEffect`/`useCallback`/`useFocusEffect` 依赖数组；必须在组件顶部解构 `storage`/`session`/`markConversationAsRead`/`chatListVersion` 等具体字段后再依赖
- **会话列表加载**: `ChatListScreen.loadConversations` 用 `Promise.all` 并行解析各会话 handle，避免 for 循环串行 await 阻塞 JS 线程
- **未读标记**: 进入 ChatView 时调用 `markConversationAsRead`；poller 推送新消息后，`chatListVersion` 变化触发的 `useEffect` 中会同步调用 `storage.markMessagesAsRead(conversationId)`，确保用户在 ChatView 已看到的消息返回列表时不显示未读
- **未读 badge 布局**: 聊天列表行的未读 badge 紧跟 handle/groupName 文字，不靠右 `space-between` 推开
- **身份备份**: PBKDF2-SHA256(100k iter)+AES-256-GCM 加密，备份范围含身份密钥+MLS会话+KeyPackage池+群聊元数据，PDS `dme.backup.identity` record（rkey=self, putRecord upsert）
- **did:web 支持**: did:web 用户无法 PLC 操作，Setup 页提供 did.json 全文（DME 新增部分绿色高亮）供用户手动更新后检测
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

- **Lexicon key**: envelope 用 `"key": "tid"`（AT Protocol 自动生成时间戳 rkey）；backup 用 `"key": "literal"`（rkey 固定 `"self"`，putRecord upsert）
- **Gateway IP 剥离**: 未显式实现 header 剥离，靠 CF 边缘 IP 隐式隔离（`proxy()` 只转发 body + Content-Type）
- **SkiaButton 已废弃**: 所有屏幕改用 `Button.tsx`（Pressable+Text），`SkiaButton.tsx` 保留但无引用
- **主页顶部栏**: ChatListScreen 顶部栏仅保留 +Group、+Friend 两个直接按钮 + 用户头像；Scan/Settings/Logout 收入头像弹出菜单
- **expo-image**: 新增依赖 `expo-image@~2.0.7`（Expo 52 兼容），替代 `react-native` Image 用于头像渲染
- **备份恢复**: 恢复后 MLS 会话+KeyPackage池+群聊元数据完整恢复，无需重新握手；消息历史不备份
- **Go 模块路径**: `dme/dme-server`（本地路径，非 GitHub）
- **dme.db/**: 运行时自动创建的 BadgerDB 数据目录，已 gitignored
- **secretTree 索引**: ts-mls 的 SecretTree 按树位置索引（0=leaf0, 1=parent, 2=leaf1），`getExpectedGeneration` 内部用 `leafIndex * 2`
- **轮询批量预计算**: poller 默认预计算 3 个 future queueId，可在 Settings 页面调整（1-20）
- **群聊消息存储**: 通过 `StoredMessage.conversationId` 指定存储到群聊而非1:1，`kind` 字段区分消息类型
- **群主离线**: 只有群主能 addMember/removeMember，群主离线时无法管理成员
- **群聊创建者**: 群主不能离开群组（MLS 限制 removeMember 不能移除 committer），只能解散
- **浏览器调试现场保护**: 当用户要求「看控制台日志」时，直接使用 `browsermcp_browser_get_console_logs` 抓取当前页面日志，禁止 `browsermcp_browser_navigate` 刷新或跳转页面，避免破坏报错现场
- **ChatViewScreen 依赖陷阱**: `useFocusEffect` 不可依赖整个 `AppContext` value 对象，否则 `chatListVersion` 递增会导致 effect 重新 fire → 再次触发 `markConversationAsRead` → 无限 `Maximum update depth exceeded` 循环
- **DID 解析并发**: `ChatViewScreen`/`ChatListScreen`/`GroupSettingsScreen`/`CreateGroupScreen` 中批量解析 DID 时必须用 `Promise.all`，禁止 for 循环内串行 `await`
- **Web emoji 反应触发**: Web 无 `onLongPress`，每条文本消息气泡旁固定 emoji 按钮（incoming 右下/outgoing 左下）唤起 `EmojiPicker` 浮层
