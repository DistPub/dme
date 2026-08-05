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
├── dme-gateway/    Cloudflare Worker - 反向代理 + blob CDN 缓存
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

发文件:
  Client 逐块(5MB) AES-256-GCM 加密 -> 每块 uploadBlob 到 PDS -> MLS 加密 file manifest(含 fileKey) + 标准 blob 引用 -> 创建一条 dme.queue.envelope(含加密 payload + blobRefs) -> Jetstream -> dme-server 存入 BadgerDB

收文件:
  Client poller 解密 MLS manifest -> 从同一 envelope 拿 blobRefs -> 逐片 GET gateway blob CDN
  -> AES-256-GCM 解密 -> SHA-256 验证 -> expo-file-system 存本地
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
| 全局状态 | `dme-client/src/state/AppContext.tsx` (17 字段，28 action) |
| 消息轮询 | `dme-client/src/poll/poller.ts` |
| 存储 schema | `dme-client/src/storage/db.ts` |
| DID 公钥读写 | `dme-client/src/atproto/did.ts` (`declareKeys` + `getRemoteEncryptionKey` + `getRemoteSigningKey` + `getDidMethod` + `generateDidWebUpdate` + `sharedDidResolver`) |
| DID 解析缓存 | `dme-client/src/atproto/did.ts` (`sharedDidResolver`: 单例 `DidResolver` + `MemoryCache`) |
| PDS 记录写入 | `dme-client/src/atproto/pds.ts` (envelope + identity backup + AppView proxy) |
| AppView proxy 配置 | `dme-client/src/config.ts` (DEFAULT_APPVIEW_PROXY) |
| 按钮组件 | `dme-client/src/ui/Button.tsx`（Pressable+Text，numberOfLines=1，替代 SkiaButton） |
| 主页（聊天列表） | `dme-client/src/ui/ChatListScreen.tsx`（标题"隐世"，顶部栏用户头像右侧上下展示昵称+handle；列表行 1:1 头像+昵称+时间+@handle+预览，群聊同样布局 + 头像占位 + creator handle） |
| 设置页面 | `dme-client/src/ui/SettingsScreen.tsx`（Poll Batch Size + AppView Proxy + Server URL + Gateway URL + Sound 开关 + Identity Backup） |
| 消息提示音 | `dme-client/src/utils/sound.ts`（运行时生成 3 声 880Hz WAV；Web 用 Web Audio API，Native 用 expo-av） |
| 创建群聊 | `dme-client/src/ui/CreateGroupScreen.tsx` |
| 群管理 | `dme-client/src/ui/GroupSettingsScreen.tsx`（成员行头像+昵称+@handle；Block 按钮弹模态确认；已 block 成员显示 Unblock） |
| 私聊管理 | `dme-client/src/ui/DmSettingsScreen.tsx`（对方头像+昵称+@handle；Block 按钮弹模态确认；已 block 显示取消屏蔽） |
| 屏蔽列表 | `dme-client/src/ui/BlockListScreen.tsx`（头像+昵称+@handle+Unblock） |
| 表情反应协议 | `dme-client/src/protocol/reaction.ts`（`ReactionMessage` add/remove） |
| 消息 reactions 存储 | `dme-client/src/storage/db.ts`（`Reaction` + `addReaction`/`removeReaction`） |
| 消息气泡 + reactions + 群聊头像 | `dme-client/src/ui/MessageBubble.tsx`（群聊消息双列布局：头像列 + 内容列(昵称+@handle+气泡+reactions)） |
| 表情选择器 | `dme-client/src/ui/EmojiPicker.tsx`（浮层锚定按钮） |
| 消息操作菜单 | `dme-client/src/ui/MessageActionMenu.tsx`（长按/右键浮层：复制/转发/删除） |
| 1:1 / 群聊视图 | `dme-client/src/ui/ChatViewScreen.tsx`（header 左侧 1:1 头像+昵称+@handle + ⋮（跳转私聊管理），群聊 头像占位+[Group] 群名+@creator handle + ⋮（跳转群管理）；群聊消息行双列布局：发言人头像单独成列，收到的消息左侧头像+昵称+@handle，自己发的消息右侧头像） |
| HTTP 端点 | `dme-server/internal/server/server.go` (2 个端点) |
| BadgerDB 存储 | `dme-server/internal/store/store.go` |
| Jetstream 消费 | `dme-server/internal/jetstream/consumer.go` |
| 网关代理 | `dme-gateway/src/index.ts` |
| 文件加密 | `dme-client/src/crypto/file-crypto.ts`（逐块 AES-256-GCM 加解密） |
| 文件协议类型 | `dme-client/src/protocol/types.ts`（`FileManifestMessage` + `FileMeta`） |
| 文件发送/下载 | `dme-client/src/state/AppContext.tsx`（`sendFileMessage` + `downloadFile`） |
| 文件消息气泡 | `dme-client/src/ui/FileMessageBubble.tsx`（图片/视频/音频/文件卡片） |
| PDS URL 解析 | `dme-client/src/atproto/did.ts`（`resolvePdsUrl`） |
| Gateway (blob CDN + batch 代理) | `dme-gateway/src/index.ts`（`/xrpc/dme.file.blob` blob CDN 缓存 + `/xrpc/dme.batch.get` 反代 dme-server，全局 OPTIONS 预检 + CORS） |

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
| `senderProfileCacheRef` | ref | ChatViewScreen.tsx | `useRef<Record<string, {displayName, handle, avatarUrl}>>`，群聊 sender profile 缓存（含头像 URL），`getProfiles` 批量获取 |
| `senderProfiles` | state | ChatViewScreen.tsx | `Record<string, {displayName, handle, avatarUrl}>`，群聊消息发送者的 profile（displayName+handle+avatar），从 cacheRef 同步到 state 驱动渲染 |
| `ownProfile` | state | ChatViewScreen.tsx | `{displayName, handle, avatarUrl} \| null`，当前用户自身 profile，群聊中自己发消息的右侧头像来源，`getProfile({actor: session.did})` 获取 |
| `encryptBackup` | func | backup.ts | PBKDF2+AES-GCM 加密 FullBackupData -> base64url |
| `decryptBackup` | func | backup.ts | 解密 base64url -> FullBackupData |
| `backupIdentity` | action | AppContext.tsx | 密码加密身份+MLS会话+KeyPackage+群聊元数据+屏蔽列表，写入 PDS |
| `restoreIdentityFromBackup` | action | AppContext.tsx | 从 PDS 解密恢复全部数据（含屏蔽列表），reload poller sessions |
| `Button` | component | Button.tsx | Pressable+Text 按钮（numberOfLines=1，支持中文，替代 SkiaButton） |
| `setAppViewProxy` | action | AppContext.tsx | 更新 atproto-proxy header 值（持久化 + 实时更新 DmePds） |
| `sendGroupInvites` | action | AppContext.tsx | 通过1:1通道发送群聊邀请 |
| `respondToGroupInvite` | action | AppContext.tsx | 接受/拒绝群聊邀请 |
| `createGroupFromPendingInvites` | action | AppContext.tsx | 从接受的邀请创建 MLS 群组 |
| `addAcceptedMembersToGroup` | action | AppContext.tsx | 向已有群组添加接受邀请的成员 |
| `dissolveGroup` | action | AppContext.tsx | 群主解散群组 |
| `leaveGroup` | action | AppContext.tsx | 成员主动离开群组 |
| `removeMemberFromGroup` | action | AppContext.tsx | 群主移除成员 |
| `blockMember` | action | AppContext.tsx | 屏蔽某 DID，写入 storage `blockList`，递增 `chatListVersion` 触发 UI 刷新 |
| `unblockMember` | action | AppContext.tsx | 取消屏蔽某 DID，从 storage `blockList` 移除 |
| `refreshBlockList` | action | AppContext.tsx | 从 storage 重新加载 blockList 到 state |
| `blockList` | state | AppContext.tsx | `string[]`，被屏蔽的 DID 列表；`handleIncomingMessage` 入口处检查，命中则跳过存储 |
| `getBlockList`/`addBlockedDid`/`removeBlockedDid`/`setBlockList`/`isBlocked` | method | db.ts | AsyncStorage 屏蔽列表 CRUD（单 key `blockList`，JSON 数组，幂等） |
| `Reaction` | interface | db.ts | 表情反应（emoji + did + createdAt），挂在 `StoredMessage.reactions` |
| `ReactionMessage` | interface | reaction.ts | E2E 加密反应协议消息（add/remove，targetMessageId） |
| `sendReaction` | action | AppContext.tsx | toggle 当前用户对某消息的 emoji 反应，MLS 加密发送 |
| `addReaction`/`removeReaction` | method | db.ts | 更新某条消息的 reactions 列表 |
| `MessageBubble` | component | MessageBubble.tsx | 群聊双列布局：头像列(40px 圆形, expo-image+首字母 fallback) + 内容列(昵称+@handle+气泡+reactions pill)；incoming 头像左+内容右，outgoing 内容左+头像右；1:1 不渲染头像列 |
| `EmojiPicker` | component | EmojiPicker.tsx | 锚定按钮的浮层表情选择器 |
| `MessageActionMenu` | component | MessageActionMenu.tsx | 消息长按/右键浮层菜单（复制/转发/删除） |
| `deleteMessage` | action | AppContext.tsx | 本地删除单条消息，递增 chatListVersion 刷新 |
| `deleteMessage` | method | db.ts | 从 AsyncStorage 过滤删除指定 messageId |
| `playMessageSound` | func | sound.ts | 播放「嘀嘀嘀」提示音；Web 用 Web Audio API 振荡器，Native 用 expo-av 播放运行时生成的 WAV |
| `setActiveConversation` | action | AppContext.tsx | 设置当前活跃会话 ID（ref，不触发重渲染）；ChatView focus 时设置，blur 时清空 |
| `activeConversationRef` | ref | AppContext.tsx | `useRef<string \| null>`，当前 ChatView 的会话 ID，`handleIncomingMessage` 据此判断是否播放提示音 |
| `soundEnabled` | state | AppContext.tsx | `boolean`，提示音开关；`handleIncomingMessage` 在播放前检查，Settings 页 Switch 控制 |
| `setSoundEnabled` | action | AppContext.tsx | 切换提示音开关（持久化到 AsyncStorage + 更新 state） |
| `getSoundEnabled`/`setSoundEnabled` | method | db.ts | AsyncStorage 提示音开关读写（key `soundEnabled`，默认 `true`） |
| `createGroupWithMembers` | func | group-invite.ts | 创建 MLS 群组并添加成员（返回 Welcome + Commit） |
| `Store` | struct | store.go | BadgerDB Put/Get/GetBatch |
| `Consumer` | struct | consumer.go | Jetstream WebSocket 消费 |
| `Handler` | method | server.go | HTTP 路由 + CORS |
| `sendFileMessage` | action | AppContext.tsx | 逐块读取文件 -> AES-256-GCM 加密 -> uploadBlob -> 单条 manifest envelope(含加密 payload + 标准 blob 引用) |
| `downloadFile` | action | AppContext.tsx | 从 fileMeta 取 blobRefs -> 逐片 GET gateway blob CDN -> 解密 -> SHA-256 验证 -> 存本地 |
| `encryptChunk`/`decryptChunk` | func | file-crypto.ts | 单片 AES-256-GCM 加解密，nonce = fileId 前 8 字节 + chunkIndex 4 字节 BE |
| `generateFileId`/`generateFileKey` | func | file-crypto.ts | 随机 16 字节 fileId + 32 字节 fileKey |
| `DmeBlobRef` | interface | types.ts | 标准 ATProtocol blob 引用 `{$type:'blob', ref:{$link}, mimeType, size}`；`blobRef.toJSON()` 产出 |
| `resolvePdsUrl` | func | did.ts | DID 解析 -> `AtprotoPersonalDataServer` serviceEndpoint |
| `FileManifestMessage` | interface | types.ts | E2E 加密文件清单（type: 'file'，含 fileKey/fileId/sha256/mimeType 等） |
| `FileMeta` | interface | types.ts | 本地文件元数据（含 downloadStatus: pending/downloading/ready/failed） |
| `FileMessageBubble` | component | FileMessageBubble.tsx | 文件消息气泡：图片缩略图/视频播放/文件卡片+下载状态 |
| `getServerUrl` | method | pds.ts | 返回 DmePds.serverUrl（直连 server） |
| `getBaseUrl`/`getBlobUrl` | method | pds.ts | 客户端面向端点：`getBaseUrl()` = gateway||server 用于 batch.get；`getBlobUrl(pds,did,cid)` 网关走 file.blob CDN、直连退化为 PDS `com.atproto.sync.getBlob` |
| `updateFileMessageMeta` | method | db.ts | 局部更新某条文件消息的 fileMeta（如 downloadStatus/localPath） |

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

## 文件发送协议

文件通过 PDS blob 存储 + Gateway CDN 缓存 + MLS manifest 加密信令传输：

| 阶段 | 说明 |
|---|---|
| 加密 | 发送方生成随机 32 字节 fileKey，逐块 5MB AES-256-GCM 加密，nonce = fileId 前 8 字节 + chunkIndex 4 字节大端 |
| 上传 | 每块作为 PDS blob 上传（`agent.uploadBlob`），blobCid 存入 `dme.queue.envelope` record 的 `blobCids` 字段（标准 `{$type:'blob', ref:{$link}, mimeType, size}` 格式，PDS 可识别防 GC） |
| 信令 | file manifest（type: 'file'，含 fileKey/fileId/sha256/mimeType 等）通过 MLS application message 加密，与 blobCids 共存在同一条 envelope 中 |
| 下载 | 接收方从 manifest 拿到 fileKey → 从同一 envelope 的 `blobCids` 取 blob refs → 逐片 GET gateway `/xrpc/dme.file.blob` |
| 缓存 | Gateway 用 `caches.default` 缓存 blob 响应 7 天，群聊中后续成员走 CF 边缘缓存，发送方 PDS 每分片只被打 1 次 |
| 校验 | 解密后拼接 → SHA-256 验证与 manifest 一致 |
| 图片自动下载 | `image/*` 且 ≤ 5MB（1 个 chunk）自动触发下载，其他类型手动点击 |

### 文件消息类型

| 类型 | 包含 | 用途 |
|---|---|---|
| `FileManifestMessage` | type: 'file', fileId, fileName, fileSize, mimeType, sha256, chunkCount, chunkSize, fileKey | MLS 加密传输的文件清单 |
| `FileMeta` | fileId, fileName, fileSize, mimeType, sha256, chunkCount, chunkSize, fileKey, blobCids?, localPath?, downloadStatus | 本地存储的文件元数据 |

### 下载状态

| 状态 | 含义 |
|---|---|
| `pending` | 刚收到 manifest，尚未开始下载 |
| `downloading` | 正在下载 blob 分片 |
| `ready` | 下载完成，已解密校验并存本地 |
| `failed` | 下载失败（重试 3 次后仍失败） |

## 屏蔽列表

- 入口：主页头像弹出菜单 → `Block List` 屏幕（`BlockListScreen`）
- 私聊管理页可 Block（弹模态确认，标题「屏蔽用户」，模态中 handle 渲染为 `@xxx`）；已 block 显示取消屏蔽（直接执行）
- 群管理页成员行可 Block（弹模态确认，标题「屏蔽成员」，模态中 handle 渲染为 `@xxx`）；已 block 成员显示 Unblock（直接执行）
- 屏蔽列表行展示：头像 + 昵称 + @handle + Unblock 按钮
- `handleIncomingMessage` 入口处检查 `app.blockList`，命中则跳过该消息存储（poller 仍标记 queueId 已处理）
- `ChatViewScreen.loadMessages` 在内存中过滤 `m.fromDid ∈ blockList` 的消息
- `ChatListScreen.loadConversations` 排除被屏蔽发送者的未读计数，preview 显示「已屏蔽」
- 不删除已存储消息、不修改群成员关系、不通知对方、不自动 remove

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

## 消息提示音

新消息到达时播放「嘀嘀嘀」3 声 880Hz 提示音，声音由 `src/utils/sound.ts` 运行时生成（无音频文件依赖）。

| 平台 | 实现 |
|---|---|
| Web | Web Audio API 振荡器（`AudioContext` + `OscillatorNode`），无文件 |
| Native | 运行时生成 WAV base64 -> `expo-file-system` 写入临时文件 -> `expo-av` 播放 |

触发逻辑（`handleIncomingMessage` 中，收到 `kind: 'text'` 或 `kind: 'group_invite'` 消息后）：

| 用户状态 | 新消息来源 | 是否播放 |
|---|---|---|
| 不在任何聊天页面 | 任意会话 | ✅ 播放 |
| 在会话 A 的聊天界面 | 会话 A | ✅ 播放 |
| 在会话 A 的聊天界面 | 会话 B | ❌ 不播放 |

- `activeConversationRef`（`useRef`）追踪当前 ChatView 的会话 ID，ChatView focus 时设置、blur 时清空，不触发重渲染
- `soundEnabled`（`boolean` state）控制全局开关，Settings 页 Switch 切换，默认 `true`，持久化到 AsyncStorage
- 系统消息（`kind: 'group_system'`）和表情反应（`type: 'reaction'`）不触发提示音

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
- **消息操作菜单**: 长按（原生）/右键（web）消息气泡弹出 `MessageActionMenu`（复制/转发/删除）；复制走 `expo-clipboard`，转发跳 ChatList 选择目标后 `sendMessage` 再 `replace` 跳 ChatView，删除仅本地删除（PDS 密文不变）
- **消息提示音**: `playMessageSound()`（`src/utils/sound.ts`）播放「嘀嘀嘀」3 声 880Hz；Web 用 Web Audio API 振荡器，Native 用 `expo-av` 播放运行时生成的 WAV（写入 `expo-file-system` 临时文件，首次生成后缓存）；`handleIncomingMessage` 对 `kind: 'text'` 和 `kind: 'group_invite'` 消息触发，`kind: 'group_system'` 和 `type: 'reaction'` 不触发；`activeConversationRef`（ref，不触发重渲染）追踪当前 ChatView 会话 ID 决定是否播放，`soundEnabled`（state）控制全局开关
- **成员离开**: MLS 禁止自身 removeMember，通过 `group_member_left` 通知其他成员，群主收到后执行 removeMember
- **Skia 渲染范围**: 仅屏幕背景 `<Canvas><Fill/></Canvas>` 用 Skia；按钮用原生 `Button`（Pressable+Text，支持中文）；头像用 `expo-image`
- **AppView proxy**: PDS 写入通过 `agent.configureProxy()` 设置全局 `atproto-proxy` header，默认值 `did:web:fatesky.hukoubook.com#fatesky_appview`，可在 Settings 页面自定义
- **头像渲染**: `expo-image` 替代 `react-native` Image，`contentFit="cover"` + `overflow: 'hidden'`，加载失败回退 handle 首字母
- **DID 解析**: 统一使用 `atproto/did.ts` 导出的 `sharedDidResolver` 单例（带 `MemoryCache`），禁止直接 `new DidResolver({})` 或绕过缓存直接 fetch PLC directory
- **Profile 批量获取**: 多个 DID 的 profile（avatar + displayName + handle）必须用 `app.bsky.actor.getProfiles({ actors: string[] })` 批量接口，禁止 `Promise.all(dids.map(d => getProfile(d)))` 逐个请求；`getProfiles` 失败时 fallback 到 `sharedDidResolver`（仅 handle）；每个屏幕用 `useRef` 缓存已解析的 profile，跨 focus 保留；**首屏加载**（ChatListScreen 等）须先读本地缓存同步构造 rows 立即渲染，再异步调 `getProfiles`/handle 解析，拿到后用 `setX(prev => prev.map(...))` 函数式更新，禁止同步 `await` 网络请求阻塞首屏渲染
- **群聊消息布局**: 群聊消息行采用双列布局：头像列（40px 圆形 `expo-image`，加载失败回退首字母）单独成列，内容列（昵称+@handle+消息气泡+reactions）单独成列；收到的消息头像在左、内容在右，自己发的消息内容在左、头像在右；1:1 聊天不渲染头像列
- **React hooks 依赖**: UI 屏幕严禁把整个 `AppContext` value 对象放入 `useEffect`/`useCallback`/`useFocusEffect` 依赖数组；必须在组件顶部解构 `storage`/`session`/`markConversationAsRead`/`chatListVersion` 等具体字段后再依赖
- **会话列表加载**: `ChatListScreen.loadConversations` 用 `Promise.all` 并行解析各会话 handle，避免 for 循环串行 await 阻塞 JS 线程
- **未读标记**: 进入 ChatView 时调用 `markConversationAsRead`；poller 推送新消息后，`chatListVersion` 变化触发的 `useEffect` 中会同步调用 `storage.markMessagesAsRead(conversationId)`，确保用户在 ChatView 已看到的消息返回列表时不显示未读
- **未读 badge 布局**: 1:1 会话列表行未读 badge 浮在头像右上角（`position: absolute, top: -4, right: -4`，红底 + 白边分隔环）；群聊行 badge 紧跟群名文字（内联，不靠右推开）
- **身份备份**: PBKDF2-SHA256(100k iter)+AES-256-GCM 加密，备份范围含身份密钥+MLS会话+KeyPackage池+群聊元数据+屏蔽列表，PDS `dme.backup.identity` record（rkey=self, putRecord upsert）
- **did:web 支持**: did:web 用户无法 PLC 操作，Setup 页提供 did.json 全文（DME 新增部分绿色高亮）供用户手动更新后检测
- **Web 模态对话框**: `Alert.alert` 在 Web 端无效（无 polyfill），确认弹窗用 React Native `Modal` 组件（`transparent` + `animationType="fade"`），跨平台统一；模态遮罩用 `View` + `StyleSheet.absoluteFill` 的 `TouchableOpacity` 做背景层，卡片 `View` 独立放上层，避免 `TouchableOpacity` 包裹卡片导致 `TextInput` 点击冒泡关闭模态
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
- **Gateway**: Cloudflare Worker，职责 `/xrpc/dme.file.blob`（blob CDN，7 天 `caches.default` 缓存，代理 PDS `com.atproto.sync.getBlob`） + `/xrpc/dme.batch.get`（反代到 `DME_SERVER_URL`，隐藏客户端 IP）。全局 OPTIONS 预检 + `Access-Control-Allow-Origin:*`（含 `proxy()` 响应），以支持浏览器 / Expo web 直连。`wrangler.toml` 的 `DME_SERVER_URL` 变量指向 dme-server。Gateway 留空 → 客户端直连 server，blob 走 PDS `com.atproto.sync.getBlob`。群聊后续成员走 CF 边缘缓存，发送方 PDS 每分片只被打 1 次。
- **SkiaButton 已废弃**: 所有屏幕改用 `Button.tsx`（Pressable+Text），`SkiaButton.tsx` 保留但无引用
- **主页顶部栏**: ChatListScreen 顶部栏仅保留 +Group、+Friend 两个直接按钮 + 用户头像；Scan/Settings/Block List/Logout 收入头像弹出菜单
- **expo-image**: 新增依赖 `expo-image@~2.0.7`（Expo 52 兼容），替代 `react-native` Image 用于头像渲染
- **备份恢复**: 恢复后 MLS 会话+KeyPackage池+群聊元数据+屏蔽列表完整恢复，无需重新握手；消息历史不备份
- **退出登录**: ChatListScreen 头像菜单点击 Logout 弹模态对话框，要求用户输入密码先备份（`backupIdentity`）再退出；退出时 `storage.clear()` 删除设备上所有 `dme:<did>:` 前缀的 AsyncStorage 数据；不备份则取消留在当前会话
- **Go 模块路径**: `dme/dme-server`（本地路径，非 GitHub）
- **dme.db/**: 运行时自动创建的 BadgerDB 数据目录，已 gitignored
- **secretTree 索引**: ts-mls 的 SecretTree 按树位置索引（0=leaf0, 1=parent, 2=leaf1），`getExpectedGeneration` 内部用 `leafIndex * 2`
- **轮询批量预计算**: poller 默认预计算 3 个 future queueId，可在 Settings 页面调整（1-20）
- **群聊消息存储**: 通过 `StoredMessage.conversationId` 指定存储到群聊而非1:1，`kind` 字段区分消息类型；`group_invite_request` 在 ChatListScreen 预览渲染为 `@handle邀请你加入群聊：{groupName}`，在 ChatViewScreen 渲染为居中紧凑卡片 `群聊邀请：{groupName}` + Accept/Decline 按钮，顶部邀请队列显示 `From @handle`
- **群主离线**: 只有群主能 addMember/removeMember，群主离线时无法管理成员
- **群聊创建者**: 群主不能离开群组（MLS 限制 removeMember 不能移除 committer），只能解散
- **浏览器调试现场保护**: 当用户要求「看控制台日志」时，直接使用 `browsermcp_browser_get_console_logs` 抓取当前页面日志，禁止 `browsermcp_browser_navigate` 刷新或跳转页面，避免破坏报错现场
- **ChatViewScreen 依赖陷阱**: `useFocusEffect` 不可依赖整个 `AppContext` value 对象，否则 `chatListVersion` 递增会导致 effect 重新 fire -> 再次触发 `markConversationAsRead` -> 无限 `Maximum update depth exceeded` 循环
- **DID 解析并发**: `ChatViewScreen`/`ChatListScreen`/`GroupSettingsScreen`/`CreateGroupScreen` 中批量解析 DID 时必须用 `Promise.all`，禁止 for 循环内串行 `await`
- **Web emoji 反应触发**: Web 无 `onLongPress`，每条文本消息气泡旁固定 emoji 按钮（incoming 右下/outgoing 左下）唤起 `EmojiPicker` 浮层
- **expo-av**: 新增依赖 `expo-av@~15.0.0`（Expo 52 兼容，已 deprecated 但仍可用），用于 Native 端播放提示音；Web 端用 Web Audio API 无需此依赖
- **expo-document-picker**: 新增依赖 `expo-document-picker@~57.0.1`（Expo 52 兼容），用于文件选择（`getDocumentAsync({type: '*/*'})`），返回 `{uri, name, mimeType, size}`
- **Web 消息操作菜单**: Web 无 `onLongPress`，但气泡 `ref` 挂 `contextmenu` 事件监听器捕获右键，调用 `measureInWindow` 取坐标后弹出 `MessageActionMenu`；原生走 `onLongPress` 同一路径
- **文件发送**: 逐块 5MB AES-256-GCM 加密，每块作为 PDS blob 上传，blobCids 字段引用（标准 `{$type:'blob', ref:{$link}, mimeType, size}` 格式，PDS 可识别防 GC）。fileKey 随机生成放在 MLS manifest 中，与 blobCids 共存在同一条 `dme.queue.envelope` 中（单 record）。Gateway 用 `caches.default` 缓存 blob 下载，群聊后续成员走 CF 边缘缓存。下载时 blob fetch 失败指数退避重试 2s/4s/8s，最多 3 次。图片 ≤ 5MB 自动下载，其他类型手动
- **文件消息存储**: `StoredMessage.kind = 'file'`，`fileMeta` 字段含完整元数据。`updateFileMessageMeta` 局部更新下载状态和本地路径。发送方消息立即标记 `downloadStatus: 'ready'`（文件已在本机），接收方初始 `downloadStatus: 'pending'`
- **文件消息 UI**: `FileMessageBubble` 按 mimeType 分支渲染（image → expo-image 缩略图，video → ▶ 按钮，audio → 🔊 图标，其他 → 📎 + 文件名 + 大小）。下载状态：pending → 点击下载，downloading → ActivityIndicator，ready → 点击打开，failed → 重试按钮
- **文件消息预览**: ChatListScreen 最近消息 `kind === 'file'` 显示 `📎 filename`
- **文件分片完整性**: 每片独立 AES-256-GCM 加密，nonce 由 fileId 前 8 字节 + chunkIndex 4 字节大端组成，同一 fileKey 下 nonce 不重复。解密后拼接整文件 SHA-256 与 manifest 比对
- **文件大小限制**: 无硬限制，逐块 5MB 读取加密，内存 O(5MB)。>500MB 弹警告确认。无断点续传，任一 uploadBlob 失败则整个发送失败
