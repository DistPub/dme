# AGENTS.md

- 输出或提示优先用中文。
- 开始回答前先说"帅哥是这样的"

---

# DME 项目知识库

## 概述

DME (Decentralized Message Envelope) 是基于 AT Protocol (Bluesky) 的端到端加密私信系统。用户通过 Bluesky 账号登录，在 DID 文档中声明 X25519 + Ed25519 公钥，经 QR 码握手建立 MLS (RFC 9420) 加密会话，密文以 `dme.queue.envelope` 记录写入 PDS，经 Jetstream 被 server 消费索引，客户端轮询盲查获取消息。支持 1v1 和群组聊天。

四个完全独立的系统，无共享配置，无 workspace：

```
dme/
├── dme-client/     Expo + RN Skia 移动 App（TS strict, Bun）
├── dme-miniapp/    微信小程序端（Taro 4 + React 18，复刻 dme-client 全部功能）
├── dme-server/     Go AppView - Jetstream 消费 + BadgerDB KV + 批量盲查
├── dme-gateway/    Cloudflare Worker - 反向代理 + blob CDN 缓存
```

## dme-miniapp 概要（微信小程序端）

dme-client 的微信小程序移植版，**Taro 4.2 + React 18 + TypeScript**，编译目标 `weapp`。功能对齐 dme-client 14 屏（唯一排除项：web 的 iframe embed 嵌入模式）。

- **加密栈全纯 JS**：ts-mls + @noble/*（版本锁定 1.x，禁止升 2.x），`@hpke/*` 在 `config/index.ts` stub 成 `false`；CiphersuiteImpl 唯一来源是 `src/crypto/mls-noble-kdf.ts` 的 `getNobleMlsImpl()`（五字段全部手工组装，复用 dme-client 同名实现）
- **网络**：`Taro.request` 自写轻量 XRPC 客户端（`src/platform/http.ts`，不用 `@atproto/api`）；资料获取经 PDS `appViewGet()` + `atproto-proxy`，禁止直连 `public.api.bsky.app`
- **页面分包**：主包 6 页（login/setup/chat-list/settings/about/block-list）+ 分包 `pkg-chat` 8 页（chat-view/qr-scan/qr-display/create-group/group-settings/dm-settings/image-viewer/video-viewer），加密栈体量大后置加载
- **平台适配层** `src/platform/`（storage 复刻 AsyncStorage / http XRPC / clipboard / `recorder.ts` 按住说话录音封装）+ `src/polyfills/`（`wx.getRandomValues` 64KB 缓冲池、TextEncoder/base64 shim）
- **小程序增强**：邀请帖 QR 可 `showShareImageMenu` 直享微信聊天 / `useShareAppMessage` 卡片转发；`wx.scanCode` 摄像头扫码 + jsqr 相册识别双路径
- **构建管线**（`scripts/deploy.mjs`，顺序不可换）：`taro build → es5ify.mjs（ES5 降级，CI 拒收 ?. ??）→ strip-hpke-dead-code.mjs → verify → inject-polyfills.mjs`；产物冒烟 `verify-artifact.mjs`；上传走 miniprogram-ci（需 IP 白名单）。真机合法域名白名单仅 4 个：`network.hukoubook.com` / `dme.mymutual.fans` / `e2ee.hukoubook.com` / `plc.directory`
- **详细文档**：`dme-miniapp/AGENTS.md`（硬性约束、平台坑、与 dme-client 的模块对应关系、构建自检清单）——改小程序代码前必读

## Web 嵌入模式：Chat Active 状态通知（2026-10-02 落地）

fatesky web 端在 `/messages` 路由 keep-mounted 一个 iframe 嵌入 DME。iframe 被 `display:none` 隐藏时 DME 自身无法感知，因此 fatesky 通过 postMessage 协议主动同步「用户是否正在看 /messages 页面」。

### 协议变更

- `dme-client/src/embed/protocol.ts` 的 `DME_MSG` 新增 `CHAT_ACTIVE: 'DME_CHAT_ACTIVE'`。
- fatesky → DME 的消息格式：`{ protocol: 'dme-embed/v1', type: 'DME_CHAT_ACTIVE', payload: { active: boolean } }`。

### DME 行为

- `dme-client/src/embed/bridge.ts` 维护模块级 `isChatActive` 状态；校验 `payload.active` 为 boolean 后更新；提供 `onChatActiveChange` / `offChatActiveChange` / `getIsChatActive`。
- `dme-client/src/state/AppContext.tsx`：
  - 订阅 chat active 变化，`false → true` 且当前有打开会话时，调用 `markConversationAsRead(activeConversationRef.current)`，触发 `DME_UNREAD` 重新上报。
  - `handleIncomingMessage` 收到新消息后，仅在以下条件同时满足时标记为已读：
    - 处于 embed 模式（`isEmbedContext()`）
    - fatesky 报告 `chatActiveRef.current === true`
    - DME 当前打开的就是该消息所属会话（`activeConversationRef.current === msg.groupId`）
    - 浏览器标签页可见（`document.visibilityState === 'visible'`）
  - 任一条件不满足则消息计入未读，fatesky 侧显示红点。
- 不做 `document.visibilitychange` 兜底，一切以 fatesky 发送的 `DME_CHAT_ACTIVE` 为准。
- 仅影响 `dme-client` web 嵌入模式，未改动 `dme-miniapp` / `dme-server` / `dme-gateway`。

---

## 登录：PDS + 2FA 兼容（2026-10-01 落地）

登录页（两端）统一支持 AT Protocol 邮箱二步验证（`authFactorToken`），账号未开 2FA 时行为与之前完全一致：

| 项 | 实现 |
|---|---|
| DmeSession.login | 新增 `authFactorToken?: string` 参数，直接透传到 `com.atproto.server.createSession` |
| 2FA 错误识别 | `isAuthFactorTokenRequired(err)`：正则匹配响应体里的 `AuthFactorTokenRequired` |
| AppContext 状态流 | `loginStep: 'idle' \| 'loggingIn' \| 'awaiting2FA'` + `loginFormSnapshot`；触发 2FA 时保存当前表单、二次提交带 token；`cancel2FA()` 回退到 idle |
| UI | 2FA 状态显示验证码输入框（**不限长度**、不限数字——目前没有统一标准），PDS/Handle/Password 输入框置灰，主按钮变「验证并登录」，提供「返回修改密码」按钮 |
| 验证码长度限制 | **故意去掉** `maxLength`/`maxlength` 与 `number-pad` 键盘：2FA 验证码长度无统一标准，可能是 6 位以上或非纯数字 |
| PDS 前端白名单 | **完全移除**：原 `pages/login/index.tsx` 里的 `PDS_ALLOWLIST` 硬编码拦截非白名单 PDS，与用户实际输入矛盾（2026-10-01 真机实测）。合法域名校验是微信后台的事，前端不再做 |
| requestPlcSignature 空 body | `atproto/did.ts` 的 `requestPlcOperationSignature` 是无输入体 procedure，原 `xrpcPostJson(url, {}, ...)` 会被 PDS 拒绝（`400 InvalidRequest: A request body was provided when none was expected`，2026-10-01 真机踩坑，与 `refreshSession`/`deleteSession` 同类）。**改用 `xrpcPostEmpty` 完全不携带 body**。dme-client 用 `@atproto/api` 的 `agent.com.atproto.identity.requestPlcOperationSignature()`，SDK 内部已正确处理 |
| React hooks 顺序 | 登录页的 `useCallback` 必须在所有提前 return 之前声明（2026-10-01 真机触发 `Minified React error #310`）；不要把任何 hook 写在 `if (loading) return ...` 这类提前 return 之后 |

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
  Client 先存本地副本+乐观消息(uploading) -> 逐块(5MB) AES-256-GCM 加密 -> 每块 XHR 上传 PDS(字节级进度)
  -> MLS 加密 file manifest(含 fileKey) + 标准 blob 引用 -> 创建一条 dme.queue.envelope(含加密 payload + blobRefs)
  -> 删除乐观消息写入最终消息(uploaded) -> Jetstream -> dme-server 存入 BadgerDB

收文件:
  Client poller 解密 MLS manifest -> 从同一 envelope 拿 blobRefs -> 逐片流式 GET gateway blob CDN(字节级进度)
  -> AES-256-GCM 解密 -> SHA-256 验证 -> expo-file-system 存本地
```

## 快速定位

| 任务 | 位置 |
|---|---|
| MLS 会话管理 | `dme-client/src/crypto/mls-session.ts` (255 行 MlsSession 类) |
| MLS 密码套件配置 | `dme-client/src/crypto/mls-config.ts`（常量 + `MLS_CIPHERSUITE_NAME`） |
| MLS 纯 JS 密码套件组装 | `dme-client/src/crypto/mls-noble-kdf.ts`（`getNobleMlsImpl`：hash/kdf/signature/hpke/rng 五字段全部手工纯 JS 组装） |
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
| DID 公钥读写 | `dme-client/src/atproto/did.ts` (`declareKeys` + `getRemoteEncryptionKey` + `getRemoteSigningKey` + `getDidMethod` + `generateDidWebUpdate`)；`sharedDidResolver` 单例在 `atproto/resolver.ts` |
| DID 解析缓存 | `dme-client/src/atproto/profile-cache.ts`（24h TTL + AsyncStorage 持久化 + 内存热缓存 + 请求去重）；底层解析用 `atproto/resolver.ts` 的 `sharedDidResolver` |
| DID Resolver 单例 | `dme-client/src/atproto/resolver.ts` (`sharedDidResolver`: `DidResolver` + `MemoryCache`) |
| PDS 记录写入 + 批量查询 | `dme-client/src/atproto/pds.ts` (envelope + identity backup + AppView proxy，**网关模式下自动发送 `dme-server` header 指定目标 server**) |
| AppView proxy 配置 | `dme-client/src/config.ts` (DEFAULT_APPVIEW_PROXY) |
| 网关默认地址 | `dme-client/src/config.ts` (DEFAULT_DME_GATEWAY_URL = `https://e2ee.hukoubook.com`) |
| 按钮组件 | `dme-client/src/ui/Button.tsx`（Pressable+Text，numberOfLines=1，替代 SkiaButton；支持 `onPressIn`） |
| 多语言 (i18n) | `dme-client/src/i18n/I18nContext.tsx`（`I18nProvider` + `useI18n`）+ `i18n/translations.ts`（zh/en 字典，202 key）+ `i18n/format.ts`（`t()` 内插） |
| Web 页面标题 | `dme-client/src/utils/web-title.ts`（`setWebTitle` + `useWebTitle`，Web 注入 `document.title = "<标题> - DME"`，Native no-op） |
| 主页（聊天列表） | `dme-client/src/ui/ChatListScreen.tsx`（标题 i18n `chatlist.title`，默认中文「隐世」；顶部栏用户头像右侧上下展示昵称+handle；列表行 1:1 头像+昵称+时间+@handle+预览，群聊同样布局 + 头像占位 + creator handle；时间/预览文案走 `t()`） |
| 设置页面 | `dme-client/src/ui/SettingsScreen.tsx`（Language 语言切换（zh/en）+ Poll Batch Size + AppView Proxy + Server URL + Gateway URL + Sound 开关 + Identity Backup；顶部返回按钮 + 标题栏） |
| 消息提示音 | `dme-client/src/utils/sound.ts`（运行时生成 3 声 880Hz WAV；Web 用 Web Audio API `AudioContext` + `decodeAudioData`，Native 用 expo-av；`unlockWebAudio()` 首次手势静音解锁） |
| 创建群聊 | `dme-client/src/ui/CreateGroupScreen.tsx` |
| 群管理 | `dme-client/src/ui/GroupSettingsScreen.tsx`（成员行头像+昵称+@handle；Block 按钮弹模态确认；已 block 成员显示 Unblock） |
| 私聊管理 | `dme-client/src/ui/DmSettingsScreen.tsx`（对方头像+昵称+@handle；Block 按钮弹模态确认；已 block 显示取消屏蔽） |
| 屏蔽列表 | `dme-client/src/ui/BlockListScreen.tsx`（头像+昵称+@handle+Unblock） |
| 表情反应协议 | `dme-client/src/protocol/reaction.ts`（`ReactionMessage` add/remove） |
| 消息 reactions 存储 | `dme-client/src/storage/db.ts`（`Reaction` + `addReaction`/`removeReaction`） |
| 消息气泡 + reactions + 群聊头像 | `dme-client/src/ui/MessageBubble.tsx`（群聊消息双列布局：头像列 + 内容列(昵称+@handle+气泡+reactions)） |
| 表情选择器 | `dme-client/src/ui/EmojiPicker.tsx`（浮层锚定按钮） |
| 消息操作菜单 | `dme-client/src/ui/MessageActionMenu.tsx`（长按/右键浮层：复制/转发/删除） |
| 1:1 / 群聊视图 | `dme-client/src/ui/ChatViewScreen.tsx`（header 左侧 1:1 头像+昵称+@handle + ⋮（跳转私聊管理），群聊 头像占位+[Group] 群名+@creator handle + ⋮（跳转群管理）；群聊消息行双列布局：发言人头像单独成列，收到的消息左侧头像+昵称+@handle，自己发的消息右侧头像；FlatList `inverted={true}` + newest-first 分页，进入自动显示最新消息；Web 标签页标题经 `useWebTitle` 动态设为昵称/群名） |
| HTTP 端点 | `dme-server/internal/server/server.go` (2 个端点) |
| BadgerDB 存储 | `dme-server/internal/store/store.go` |
| Jetstream 消费 | `dme-server/internal/jetstream/consumer.go` |
| 文件加密 | `dme-client/src/crypto/file-crypto.ts`（逐块 AES-256-GCM 加解密） |
| 文件协议类型 | `dme-client/src/protocol/types.ts`（`FileManifestMessage` + `FileMeta`） |
| 文件发送/下载/重试上传 | `dme-client/src/state/AppContext.tsx`（`sendFileMessage` + `retryUploadFileMessage` + `downloadFile`，字节级进度） |
| 文件消息气泡 | `dme-client/src/ui/FileMessageBubble.tsx`（群聊双列布局：头像列 + 内容列(昵称+@handle+文件卡片/图片缩略图/音频播放卡片+reactions)，上传/下载状态与进度百分比，与 `MessageBubble` 同款；1:1 不渲染头像列） |
| 图片查看器 | `dme-client/src/ui/ImageViewerScreen.tsx`（全屏查看，点击或 ✕ 关闭） |
| 视频播放/全屏查看 | `dme-client/src/ui/VideoViewerScreen.tsx`（expo-video 的 VideoView + useVideoPlayer，web 自动播放 muted，解码不支持时回退下载） |
| 文件导出/下载到设备 | `dme-client/src/utils/file-export.ts`（exportFileToDevice：web 用 anchor download，native 用 Share） |
| About 页面 | `dme-client/src/ui/AboutScreen.tsx` |
| Web 文件缓存 | `dme-client/src/utils/file-cache.ts`（IndexedDB 持久化 + `useFileUri`） |
| PDS URL 解析 | `dme-client/src/atproto/did.ts`（`resolvePdsUrl`） |
| Gateway (blob CDN + batch 代理) | `dme-gateway/src/index.ts`（`/xrpc/dme.file.blob` blob CDN 缓存 + `/xrpc/dme.batch.get` 反代 dme-server，**支持 `dme-server` header 动态切目标**，全局 OPTIONS 预检 + CORS，**允许 `dme-server`、`Authorization` header**，预检缓存 24h） |
| 小程序页面路由/分包 | `dme-miniapp/src/app.config.ts`（主包 6 页 + 分包 pkg-chat 8 页） |
| 小程序平台适配层 | `dme-miniapp/src/platform/`（`storage.ts` 复刻 AsyncStorage / `http.ts` XRPC 客户端 / `clipboard.ts` / `recorder.ts` 按住说话录音） |
| 小程序 polyfills | `dme-miniapp/src/polyfills/`（`random.ts` wx.getRandomValues 缓冲池 / `encoding.ts` TextEncoder+base64 shim）+ `scripts/inject-polyfills.mjs`（构建后全局占位注入） |
| 小程序全局状态 | `dme-miniapp/src/state/AppContext.tsx`（裁剪自 dme-client，剔除 embed；核心引用 state+ref 双写防 await 读旧值） |
| 小程序按住说话 | `dme-miniapp/src/pages/pkg-chat/chat-view/index.tsx`（🎤/⌨️ 模式切换 + touch 手势，上滑取消/60s 上限）+ `src/platform/recorder.ts`（getRecorderManager 单例状态机）；录音走 `sendFileMessage` 文件通道，接收端复用 FileMessageBubble 音频播放卡 |
| 小程序 atproto 层 | `dme-miniapp/src/atproto/`（重写自 dme-client，走 platform/http；`pds.ts` 含 uploadBlob octet-stream 直传 / createRecord / resolveHandle） |
| 小程序邀请帖+QR | `dme-miniapp/src/handshake/invite.ts`（复刻 web 邀请帖 + `detectFacetsSubset` 纯 JS facet 检测）+ `qr-image-decode.ts`（jsqr 相册识别） |
| 小程序构建/部署 | `dme-miniapp/scripts/deploy.mjs`（build: taro→es5ify→strip-hpke→inject-polyfills；upload: miniprogram-ci）+ `verify-artifact.mjs` 产物冒烟 |

## 网关代理

`dme-gateway/src/index.ts`：Cloudflare Worker，两个端点——`/xrpc/dme.file.blob`（blob CDN：流式转发 PDS `com.atproto.sync.getBlob`，≤100MB 写 `caches.default` 7 天缓存）+ `/xrpc/dme.batch.get`（反代 `DME_SERVER_URL`）。全局 OPTIONS 预检 + CORS（允许 `dme-server`、`Authorization` header，预检缓存 24h）。请求头 `dme-server` 可动态覆盖目标 server 地址（无需重新部署）；客户端 `DmePds.batchGetEnvelopes` 在网关模式下自动携带该 header（值 = `serverUrl`）。详见「注意事项 - Gateway」。

## 关键代码符号

| 符号 | 类型 | 位置 | 角色 |
|---|---|---|---|
| `MlsSession` | class | mls-session.ts | MLS 群组会话：创建/加入/加解密/序列化 |
| `getNobleMlsImpl` | func | mls-noble-kdf.ts | 组装完整 CiphersuiteImpl，hash/kdf/signature/hpke/rng 五字段全部纯 JS，不依赖 WebCrypto `subtle`；规避 iOS Safari Ed25519/X25519 不支持问题 |
| `nobleHkdfSha256` | const | mls-noble-kdf.ts | 纯 JS HKDF-SHA256，实现 ts-mls 的 `Kdf` 接口（extract/expand/size） |
| `createNobleSignature` | func | mls-noble-kdf.ts | 纯 JS Ed25519 签名实现，不做 `crypto.subtle` 探测 |
| `createNobleHpke` | func | hpke-noble.ts | 纯 JS HPKE 实现（DHKEM-X25519 / HKDF-SHA256 / AES-128-GCM） |
| `nobleRng` | const | rng.ts | 纯 JS 随机数源，兼容 ts-mls `Rng` 接口 |
| `generateKeyPackageForUser` | func | keypackage.ts | 生成 KeyPackage 对 |
| `encryptKeyPackage` | func | keypackage.ts | X25519 ECDH + AES-256-GCM 加密 KeyPackage |
| `deriveMessageQueueId` | func | mls-queue-id.ts | MLS exporter secret 派生盲查 queueId |
| `deriveWelcomeQueueId` | func | mls-queue-id.ts | SHA-256(initKey) 派生 Welcome queueId |
| `createDidCredential` | func | mls-credential.ts | DID -> MLS BasicCredential |
| `DmePoller` | class | poller.ts | 批量轮询 + LRU 去重 + 按 generation 排序；`polling` 标志防 `pollOnce` 重入，`inFlightQueueIds` Set 防跨轮重复投递（`markQueueIdProcessed` 在 onMessage/onWelcome 之前调用，避免竞态窗口） |
| `DmePds` | class | pds.ts | PDS 记录操作 + AppView proxy（agent.configureProxy 设置 atproto-proxy header）；网关模式 `batchGetEnvelopes` 自动加 `dme-server` header 指定目标 server |
| `DmeStorage` | class | db.ts | AsyncStorage 持久化（含 appViewProxy 配置）；`hasMessage(conversationId, messageId)` 幂等检查 |
| `hasMessage` | method | db.ts | 判断某会话是否已存指定 messageId（`handleIncomingMessage` text/file 入口处做幂等检查，防重复存储与误播提示音） |
| `AppProvider` | component | AppContext.tsx | 全局状态中心 |
| `declareKeys` | func | did.ts | PLC 操作发布 Ed25519 + X25519 到 DID 文档 |
| `getDidMethod` | func | did.ts | 判断 DID 方法类型（plc/web/other） |
| `generateDidWebUpdate` | func | did.ts | 为 did:web 用户生成 DID 文档更新内容（合并 DME 公钥） |
| `sharedDidResolver` | const | resolver.ts | 单例 `DidResolver`（`plcUrl` + `MemoryCache`），所有 DID 解析统一入口 |
| `resolveHandleCached` | func | profile-cache.ts | DID -> handle（24h 缓存，失败回退 did） |
| `getProfileCached` | func | profile-cache.ts | 单条 profile 获取（24h 缓存） |
| `getProfilesCached` | func | profile-cache.ts | 批量 profile 获取（24h 缓存 + 批量 miss 合并） |
| `getRemoteEncryptionKeyCached` | func | profile-cache.ts | 读取对方 X25519 公钥（24h 缓存） |
| `resolvePdsUrlCached` | func | profile-cache.ts | DID -> PDS URL（24h 缓存） |
| `markConversationAsRead` | action | AppContext.tsx | 标记某会话所有非自己发送的消息为已读，并递增 `chatListVersion` |
| `senderProfileCacheRef` | ref | ChatViewScreen.tsx | `useRef<Record<string, {displayName, handle, avatarUrl}>>`，群聊 sender profile 缓存（含头像 URL），`getProfilesCached` 批量获取 |
| `senderProfiles` | state | ChatViewScreen.tsx | `Record<string, {displayName, handle, avatarUrl}>`，群聊消息发送者的 profile（displayName+handle+avatar），从 cacheRef 同步到 state 驱动渲染 |
| `ownProfile` | state | ChatViewScreen.tsx | `{displayName, handle, avatarUrl} \| null`，当前用户自身 profile，群聊中自己发消息的右侧头像来源，`getProfileCached(agent, session.did)` 获取 |
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
| `playMessageSound` | func | sound.ts | 播放「嘀嘀嘀」提示音；Web 用 Web Audio API（`AudioContext` + `decodeAudioData` 播放运行时生成的 WAV buffer），Native 用 expo-av 播放运行时生成的 WAV |
| `unlockWebAudio` | func | sound.ts | 首次用户手势时用 `AudioContext` 播放 1-sample 静音 buffer 解锁音频（ChatListScreen 会话行 `onTap` 调用）；iOS Safari 可靠解锁 |
| `setActiveConversation` | action | AppContext.tsx | 设置当前活跃会话 ID（ref，不触发重渲染）；ChatView focus 时设置，blur 时清空 |
| `activeConversationRef` | ref | AppContext.tsx | `useRef<string \| null>`，当前 ChatView 的会话 ID，`handleIncomingMessage` 据此判断是否播放提示音 |
| `chatActiveRef` | ref | AppContext.tsx | `useRef<boolean>`，web 嵌入模式下由 fatesky 的 `DME_CHAT_ACTIVE` 消息驱动；`handleIncomingMessage` 结合 `activeConversationRef` 与 `document.visibilityState` 决定是否 mark read |
| `onChatActiveChange` | func | bridge.ts | 注册 fatesky chat-active 状态变化回调 |
| `offChatActiveChange` | func | bridge.ts | 移除已注册的 chat-active 状态变化回调 |
| `getIsChatActive` | func | bridge.ts | 返回当前已知的 chat-active 状态（默认 false） |
| `soundEnabled` | state | AppContext.tsx | `boolean`，提示音开关；`handleIncomingMessage` 在播放前检查，Settings 页 Switch 控制 |
| `setSoundEnabled` | action | AppContext.tsx | 切换提示音开关（持久化到 AsyncStorage + 更新 state） |
| `getSoundEnabled`/`setSoundEnabled` | method | db.ts | AsyncStorage 提示音开关读写（key `soundEnabled`，默认 `true`） |
| `createGroupWithMembers` | func | group-invite.ts | 创建 MLS 群组并添加成员（返回 Welcome + Commit） |
| `Store` | struct | store.go | BadgerDB Put/Get/GetBatch |
| `Consumer` | struct | consumer.go | Jetstream WebSocket 消费 |
| `Handler` | method | server.go | HTTP 路由 + CORS |
| `sendFileMessage` | action | AppContext.tsx | 先存本地副本+乐观消息(tempId, uploadStatus:'uploading') -> uploadFileChunks 分片加密上传 -> MLS manifest envelope -> 删除临时消息写入最终消息(id=queueId, uploadStatus:'uploaded') |
| `retryUploadFileMessage` | action | AppContext.tsx | 重试上传失败文件：从本地副本重读分片重新上传，成功后同样替换为最终消息 |
| `uploadFileChunks` | func | AppContext.tsx | 分片加密上传 helper，内部调 `uploadBlobWithProgress`，按字节算 uploadProgress |
| `uploadBlobWithProgress` | func | AppContext.tsx | XMLHttpRequest 直传 PDS `com.atproto.repo.uploadBlob`（带 Authorization + atproto-proxy header），`upload.onprogress` 报告字节级进度（fetch 无上传进度故绕过 agent.uploadBlob） |
| `downloadFile` | action | AppContext.tsx | 从 fileMeta 取 blobCids -> `response.body.getReader()` 流式读取（字节级 downloadProgress，总量来自 blobCids[].size）-> 解密 -> SHA-256 验证 -> 存本地 |
| `encryptChunk`/`decryptChunk` | func | file-crypto.ts | 单片 AES-256-GCM 加解密，nonce = fileId 前 8 字节 + chunkIndex 4 字节 BE |
| `generateFileId`/`generateFileKey` | func | file-crypto.ts | 随机 16 字节 fileId + 32 字节 fileKey |
| `DmeBlobRef` | interface | types.ts | 标准 ATProtocol blob 引用 `{$type:'blob', ref:{$link}, mimeType, size}`；`blobRef.toJSON()` 产出 |
| `resolvePdsUrl` | func | did.ts | DID 解析 -> `AtprotoPersonalDataServer` serviceEndpoint |
| `FileManifestMessage` | interface | types.ts | E2E 加密文件清单（type: 'file'，含 fileKey/fileId/sha256/mimeType 等） |
| `FileMeta` | interface | types.ts | 本地文件元数据（downloadStatus + uploadStatus + uploadProgress/downloadProgress） |
| `FileMessageBubble` | component | FileMessageBubble.tsx | 群聊双列布局（头像列 + 内容列：昵称+@handle+文件卡片/图片缩略图/视频播放/音频图标+下载状态+reactions），与 `MessageBubble` 同款；1:1 不渲染头像列 |
| `ImageViewerScreen` | component | ImageViewerScreen.tsx | 全屏图片查看器，点击或 ✕ 关闭 |
| `exportFileToDevice` | func | file-export.ts | Web 用 anchor.click 下载，native 用 Share.share；支持 IndexedDB blob URI 和普通 blob URI 源 |
| `VideoViewerScreen` | component | VideoViewerScreen.tsx | 全屏视频播放器（expo-video）+ web 解码预检 + unsupported 时回退下载 |
| `useFileUri` | hook | file-cache.ts | 解析 `indexeddb://` / 普通 URI 为可渲染 blob URL，管理生命周期 |
| `cacheFile` | func | file-cache.ts | Web 端把文件字节持久化到 IndexedDB |
| `getCachedFileBytes` | func | file-cache.ts | Web 端从 IndexedDB 读取原始字节（上传/重试的数据源） |
| `loadRecentMessages` | func | ChatViewScreen.tsx | 进入聊天时加载最近 50 条消息，数据按 newest-first 倒序 |
| `loadOlderMessages` | func | ChatViewScreen.tsx | 用户滑到顶部时加载更早 50 条，append 到倒序数组末尾 |
| `messagesRef` | ref | ChatViewScreen.tsx | `useRef<StoredMessage[]>`，供 `chatListVersion` effect 读取当前 messages 长度做 merge |
| `getMessagesPaginated` | method | db.ts | 按 `beforeId`/`limit` 返回倒序消息切片 + `hasMore`，当前仍基于完整 JSON 数组切片 |
| `getMessagesAfter` | method | db.ts | 返回指定消息 id 之后的新增消息（正序）|
| `getServerUrl` | method | pds.ts | 返回 DmePds.serverUrl（直连 server） |
| `getBaseUrl`/`getBlobUrl` | method | pds.ts | 客户端面向端点：`getBaseUrl()` = gateway||server 用于 batch.get；`getBlobUrl(pds,did,cid)` 网关走 file.blob CDN、直连退化为 PDS `com.atproto.sync.getBlob` |
| `updateFileMessageMeta` | method | db.ts | 局部更新某条文件消息的 fileMeta（如 downloadStatus/localPath） |
| `I18nProvider` | component | I18nContext.tsx | 语言 Context Provider（`language`/`setLanguage`/`t`），挂载在 App 根部（AppProvider 外层），启动从 AsyncStorage key `dme:language` 读取偏好，默认 `zh` |
| `useI18n` | hook | I18nContext.tsx | 读取 `{ language, setLanguage, t }`；未包裹 Provider 时抛错 |
| `t` | func | format.ts | `t(lang, key, params?)` 纯函数翻译：查字典（en 缺失回退 zh，再回退 key），按 `{name}` 占位符内插参数 |
| `Language` / `LANGUAGES` | type / const | translations.ts | `'zh' \| 'en'`；`LANGUAGES` 为 Settings 语言选项 `[{code:'zh',label:'中文'},{code:'en',label:'English'}]` |
| `setWebTitle` | func | web-title.ts | 设置浏览器标签标题为 `"<title> - DME"`，仅 Web 生效（`Platform.OS==='web'` 且有 `document`），Native no-op |
| `useWebTitle` | hook | web-title.ts | 通过 `useFocusEffect` 在页面聚焦/`title` 变化时重设标题（用于会话名异步解析、群设置返回不重挂载、语言切换场景），Native no-op |
| `generateQrSvgDataUri` | func | invite.ts | 用 `qrcode` 库 `toString(type:'svg')` 生成 QR SVG 并编码为 data URI，供 Web/跨平台预览（绕过 Skia 图形上下文缺失） |
| `generateQrPngBytes` | func | invite.ts | 生成 QR PNG 字节（**async**）：Web 走 SVG->`<img>`->canvas 光栅化，Native 走 Skia 离屏 Surface |

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
| 上传 | 先保存本地副本（web->IndexedDB / native->documentDirectory）并写入 `uploadStatus:'uploading'` 乐观消息；每块经 `uploadBlobWithProgress`（XHR）上传 PDS（字节级 uploadProgress），blobCid 存入 `dme.queue.envelope` record 的 `blobCids` 字段（标准 `{$type:'blob', ref:{$link}, mimeType, size}` 格式，PDS 可识别防 GC）；成功后删除临时消息写入最终消息 |
| 信令 | file manifest（type: 'file'，含 fileKey/fileId/sha256/mimeType 等）通过 MLS application message 加密，与 blobCids 共存在同一条 envelope 中 |
| 下载 | 接收方从 manifest 拿到 fileKey -> 从同一 envelope 的 `blobCids` 取 blob refs -> 流式 GET gateway `/xrpc/dme.file.blob`（`response.body.getReader()` 字节级 downloadProgress） |
| 缓存 | Gateway 用 `caches.default` 缓存 blob 响应 7 天（≤100MB，waitUntil 后台写入不阻塞响应），群聊中后续成员走 CF 边缘缓存，发送方 PDS 每分片只被打 1 次 |
| 校验 | 解密后拼接 -> SHA-256 验证与 manifest 一致 |
| 图片自动下载 | `image/*` 且 ≤ 5MB（1 个 chunk）自动触发下载，其他类型手动点击 |

### 文件消息类型

| 类型 | 包含 | 用途 |
|---|---|---|
| `FileManifestMessage` | type: 'file', fileId, fileName, fileSize, mimeType, sha256, chunkCount, chunkSize, fileKey | MLS 加密传输的文件清单 |
| `FileMeta` | fileId, fileName, fileSize, mimeType, sha256, chunkCount, chunkSize, fileKey, downloadStatus, uploadStatus?, uploadProgress?, downloadProgress?, blobCids?, localPath? | 本地存储的文件元数据 |

### 下载状态

| 状态 | 含义 |
|---|---|
| `pending` | 刚收到 manifest，尚未开始下载（点击触发下载） |
| `downloading` | 正在流式下载 blob 分片（字节级 downloadProgress） |
| `ready` | 下载完成，已解密校验并存本地 |
| `failed` | 下载失败（重试 3 次后仍失败），显示重试按钮 |

### 上传状态（仅发送方）

| 状态 | 含义 |
|---|---|
| `uploading` | 正在上传（乐观消息已入库，本地副本已保存，XHR 字节级 uploadProgress） |
| `uploaded` | 上传成功（最终消息，id 替换为 MLS queueId） |
| `failed` | 上传失败（仅置状态不抛异常），可点击重试从本地副本重传 |

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
- `MessageBubble`/`FileMessageBubble` 按 emoji 聚合渲染 pill，相同 emoji 合并并显示计数（>1 时小字），当前用户参与的高亮
- Web 无长按：每条文本/文件气泡旁固定 emoji 按钮触发 `EmojiPicker`（`measureInWindow` 锚定浮层）

## 消息提示音

新消息到达时播放「嘀嘀嘀」3 声 880Hz 提示音，声音由 `src/utils/sound.ts` 运行时生成（无音频文件依赖）。

| 平台 | 实现 |
|---|---|
| Web | Web Audio API：`AudioContext` + `decodeAudioData` 解码运行时生成的 WAV buffer，`createBufferSource()` 播放；首次手势时 `unlockWebAudio()` 播放 1-sample 静音 buffer 解锁（iOS Safari 唯一可靠方式） |
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
- `unlockWebAudio()` 在 ChatListScreen 会话行 `onTap` 首次手势时调用（Web Audio API 在用户手势前无法播放）；未解锁时 `playWeb` 静默 return，等解锁后再响，避免 iPhone 进聊天页「滴滴滴」误响

## 群组生命周期状态

| 状态 | 含义 | 行为 |
|---|---|---|
| 正常 | 活跃群组 | 可发送/接收消息 |
| `dissolved: true` | 群主解散 | 保留消息，禁止发送 |
| `removed: true` | 被群主移除 | 保留消息，禁止发送 |
| `left: true` | 主动离开 | 保留消息，禁止发送 |

## 多语言 (i18n)

客户端支持 简体中文 (`zh`) / English (`en`) 双语，运行时切换，无需重启。

| 组成 | 位置 | 说明 |
|---|---|---|
| Provider | `src/i18n/I18nContext.tsx` | `I18nProvider` 持有 `language` state；挂载在 `App.tsx` 最外层（`AppProvider` 之外，因 `AppContext` 也要用 `t()`）。启动从 AsyncStorage key `dme:language` 读取偏好，默认 `zh`；`setLanguage` 写回 AsyncStorage 并更新 state |
| Hook | `src/i18n/I18nContext.tsx` | `useI18n()` 返回 `{ language, setLanguage, t }`；`t` 已被当前语言柯里化，组件内直接 `t('key')` |
| 字典 + 类型 | `src/i18n/translations.ts` | `Language = 'zh' \| 'en'`；`LANGUAGES` 为语言选项；`zh`/`en` 两个 `Record<string,string>` 字典（各 202 key，键命名 `<screen>.<name>`，通用键归 `common.*`） |
| 格式化 | `src/i18n/format.ts` | 纯函数 `t(lang, key, params?)`：查 `en` -> 回退 `zh` -> 回退 key 本身；`{name}` 占位符按 `String(v)` 替换 |

- **切换入口**：Settings 页顶部 `Language` 区块，`LANGUAGES` 渲染为一排按钮，当前语言 `variant="primary"`；`setLanguage(code)` 立即生效（`t` 依赖 `language` 重建，全 UI 重渲染）。
- **覆盖范围**：全部 UI 屏幕（Login/Setup/ChatList/ChatView/CreateGroup/GroupSettings/DmSettings/BlockList/Settings/QrDisplay/QrScan/ImageViewer/VideoViewer）+ 消息气泡 / 操作菜单 / 表情 / 文件卡片 + 群系统消息文案 + 时间格式化 + Bluesky 邀请帖正文与 QR alt 文本。
- **非 UI 文案**：
  - 群聊系统消息（accepted/rejected/joined/membersUpdated/dissolved/removed/memberLeft/youInvited/youLeft/newGroup）在**生成时**用当前 `language` 渲染并存入 `plaintext`（历史消息保持生成时的语言，不随切换改变）；`AppContext` 的 `handleIncomingMessage` 等 `useCallback` 依赖数组含 `language`。
  - 邀请帖 `generateInvitePostText` / `generateAddFriendPostText` / `createDmeInvitePost` 接收 `lang` 参数，正文与 `post.qrAlt` 走 `t(lang, ...)`。
- **新增文案流程**：同时在 `zh` 和 `en` 字典登记同一 key（否则 en 回退 zh），组件内用 `useI18n().t('key')` 或 `t('key', { name })` 取用，禁止硬编码中/英文。
- **参数内插**：`t('chatlist.timeMinutes', { n: 5 })` -> 字典 `'{n}分钟前'`；复杂拼接（如屏蔽模态的 displayName/handle 组合）在调用处算好再作为参数传入。

## Web 页面标题

Web 端浏览器标签标题统一为 `"<页面标题> - DME"`，由 `src/utils/web-title.ts` 管理；Native 为 no-op。

| 场景 | 机制 |
|---|---|
| 静态路由 | `App.tsx` 的 `ROUTE_TITLE_KEYS: Record<keyof RootStackParamList, string>` 把路由名映射到 i18n key，`NavigationContainer` 的 `onStateChange={updateTitle}` 在每次导航后 `setWebTitle(t(key))`；`documentTitle={{ enabled: false }}` 关闭 RN Navigation 自带标题 |
| 会话级动态标题 | `ChatView`（昵称/群名）、`GroupSettings`、`DmSettings` 的标题依赖异步解析的 profile / per-screen state，加入 `SCREEN_MANAGED_TITLES` 集合，由屏幕自身 `useWebTitle(...)` 管理（不走集中映射） |
| 语言切换 | `NavigationRoot` 里 `useEffect(() => updateTitle(), [t])` 在 `t` 变化时重设标题（用 `tRef` 避免 `onStateChange` 捕获旧闭包） |
| 返回不重挂载 | `useWebTitle` 基于 `useFocusEffect`：从 GroupSettings/DmSettings 返回时屏幕实例未重挂载，聚焦仍会重设标题 |


## 约定

- **加密**: MLS (RFC 9420) + ts-mls 库。密码套件 `MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519`
- **DID 双公钥**: `#dme_encryption`(X25519) 加密 KeyPackage + `#dme_signing`(Ed25519) MLS 凭证验证
- **KeyPackage**: 不上 PDS，通过1:1通道或 QR 点对点传递（接收方 X25519 公钥加密）
- **群聊 KeyPackage**: 接受邀请时生成，通过1:1通道发送给群主，群主用来 addMember
- **群聊 Commit**: 每次 addMember 产生的 Commit 必须通过1:1通道发给已有成员（poller 只轮询 application 消息，不轮询 handshake Commit）
- **表情反应**: `ReactionMessage`（`type: 'reaction'`）走 MLS session 加密，挂 `StoredMessage.reactions`，不存为文本消息
- **消息操作菜单**: 长按（原生）/右键（web）消息气泡弹出 `MessageActionMenu`（复制/转发/删除）；复制走 `expo-clipboard`，转发跳 ChatList 选择目标后 `sendMessage` 再 `replace` 跳 ChatView，删除仅本地删除（PDS 密文不变）
- **消息提示音**: `playMessageSound()`（`src/utils/sound.ts`）播放「嘀嘀嘀」3 声 880Hz；Web 用 Web Audio API（`AudioContext` + `decodeAudioData` 解码运行时生成的 WAV buffer 后 `createBufferSource()` 播放），Native 用 `expo-av` 播放运行时生成的 WAV（写入 `expo-file-system` 临时文件，首次生成后缓存）；`unlockWebAudio()` 在 ChatListScreen 会话行 `onTap` 首次手势时播放 1-sample 静音 buffer 解锁（iOS Safari 唯一可靠方式，未解锁时静默 return 等解锁）；`handleIncomingMessage` 对 `kind: 'text'` 和 `kind: 'group_invite'` 消息触发，`kind: 'group_system'` 和 `type: 'reaction'` 不触发；`activeConversationRef`（ref，不触发重渲染）追踪当前 ChatView 会话 ID 决定是否播放，`soundEnabled`（state）控制全局开关
- **成员离开**: MLS 禁止自身 removeMember，通过 `group_member_left` 通知其他成员，群主收到后执行 removeMember
- **i18n**: 全部 UI 文案走 `useI18n().t('key')` / `t('key', {params})`，禁止硬编码中英文字符串；字典键命名 `<screen>.<name>`（通用键 `common.*`），新增 key 必须同时登记 `zh` 与 `en`；`en` 缺失时回退 `zh` 再回退 key，占位符用 `{name}`；群聊系统消息与邀请帖正文在**生成时**按当前 `language` 渲染后存入 `plaintext`（历史消息不随语言切换改变）
- **Web 页面标题**: `document.title` 统一为 `"<标题> - DME"`，仅 Web 生效；静态路由经 `App.tsx` 的 `ROUTE_TITLE_KEYS` 集中映射，会话级动态标题（ChatView/GroupSettings/DmSettings）由屏幕自身 `useWebTitle` 管理，语言切换时通过 `useEffect([t])` 重设
- **Skia 渲染范围**: 屏幕背景 `<Canvas><Fill/></Canvas>` 用 Skia；按钮用原生 `Button`（Pressable+Text，支持中文）；头像用 `expo-image`；**QR 预览/生成不再用 Skia**——Web 上 Skia `<QRCode>` 与 `Skia.Surface.MakeOffscreen` 需要图形上下文，部分 Web 环境缺失会导致预览空白或崩溃，故预览改走 `generateQrSvgDataUri`（`qrcode` 库 SVG -> data URI -> `expo-image` 渲染），上传帖子的 PNG 字节 `generateQrPngBytes` 在 Web 上走 SVG->`<img>`->canvas 光栅化，Native 才走 Skia
- **AppView proxy**: PDS 写入通过 `agent.configureProxy()` 设置全局 `atproto-proxy` header，默认值 `did:web:fatesky.hukoubook.com#fatesky_appview`，可在 Settings 页面自定义
- **头像渲染**: `expo-image` 替代 `react-native` Image，`contentFit="cover"` + `overflow: 'hidden'`，加载失败回退 handle 首字母
- **DID 解析**: 统一使用 `atproto/resolver.ts` 导出的 `sharedDidResolver` 单例（带 `MemoryCache`），禁止直接 `new DidResolver({})` 或绕过缓存直接 fetch PLC directory
- **DID/Profile 24h 缓存**: UI 显示相关请求必须走 `atproto/profile-cache.ts`（`resolveHandleCached` / `getProfileCached` / `getProfilesCached`），24h TTL + AsyncStorage 持久化 + 内存热缓存；登陆、加好友、文件下载等**功能性请求**必须跳过缓存，直接使用 `atproto/did.ts` 的 `getRemoteEncryptionKey` / `resolvePdsUrl`
- **Profile 批量获取**: 多个 DID 的 profile（avatar + displayName + handle）必须用 `atproto/profile-cache.ts` 的 `getProfilesCached(dids)` 批量接口，内部走 `app.bsky.actor.getProfiles({ actors: string[] })`，禁止 `Promise.all(dids.map(d => getProfile(d)))` 逐个请求；缓存 miss 时 fallback 到 `sharedDidResolver`（仅 handle）；每个屏幕用 `useRef` 缓存已解析的 profile，跨 focus 保留；**首屏加载**（ChatListScreen 等）须先读本地缓存同步构造 rows 立即渲染，再异步调 `getProfilesCached`/`resolveHandleCached` 解析，拿到后用 `setX(prev => prev.map(...))` 函数式更新，禁止同步 `await` 网络请求阻塞首屏渲染
- **Sender profile effect 模式**: `ChatViewScreen` 解析群聊发送者 profile 的 `useEffect` 必须先按当前 `messages` 的 senderDids 把 `senderProfileCacheRef`（ref）已有条目镜像进 `senderProfiles` state，再对缺失 DID 发起 `getProfilesCached`/`resolveHandleCached`，完成时用 `mountedRef`（仅组件卸载翻 false）守卫而非 per-run `cancelled`（绑定 `messages` 变化的 cancelled 会让被 superseded 但已写 cache 的结果永远不进 state，导致名字塌缩成 DID、`@handle` 不渲染——即进入群聊时 `loadRecentMessages` 与 `markConversationAsRead`→`markMessagesAsRead`→`setChatListVersion` merge 两次 `messages` 变更引发的 race）。模块级 `profileInFlight`+`profileMemoryCache` 负责去重，重复调用同 DID 是 no-op
- **群聊消息布局**: 群聊消息行（文本 `MessageBubble` 与文件 `FileMessageBubble` 共用同一布局）采用双列布局：头像列（40px 圆形 `expo-image`，加载失败回退首字母）单独成列，内容列（昵称+@handle+消息气泡+reactions）单独成列；收到的消息头像在左、内容在右，自己发的消息内容在左、头像在右；1:1 聊天不渲染头像列。`ChatViewScreen.renderItem` 用 `senderIdentityFor(item)` helper 统一计算 `senderDisplayName`/`senderHandle`/`senderAvatarUrl`，文本与文件分支共用，禁止各写一份三元
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
- **加密库**: ts-mls + @noble/curves + @noble/hashes + @noble/ciphers（非 WebCrypto，因 Safari < 17 不支持 X25519）；**iOS Safari 兼容**：ts-mls 的 `nobleCryptoProvider` 内部仍会探测 `crypto.subtle` 并走 WebCrypto Ed25519/X25519，iOS < 17.4 会抛 `NotSupportedError`。`getNobleMlsImpl()`（`mls-noble-kdf.ts`）手工组装完整 CiphersuiteImpl，hash/kdf/signature/hpke/rng 五个字段全部使用 @noble 纯 JS 实现，不调用 `nobleCryptoProvider`/`getCiphersuiteImpl()`；所有取 CiphersuiteImpl 处必须用 `getNobleMlsImpl()`
- **消息去重与 poller 重入保护**: `DmePoller.pollOnce` 用 `polling` 布尔标志防止重入（同一实例并发只跑一次）；轮询处理时用 `inFlightQueueIds`（Set）跳过本轮已投递的 queueId，且 `markQueueIdProcessed` 在 `onMessage`/`onWelcome` **之前**调用（先标记后处理，避免回调 await 期间被下一轮重复处理）；`handleIncomingMessage` 的 text/file 分支入口调用 `msgStorage.hasMessage(conversationId, queueId)` 做幂等检查，已存在则跳过存储（群聊文本 default 分支同样检查），防止重复存储与误播提示音
- **输入框多行自适应**: `ChatViewScreen` 输入框 `multiline`，`onContentSizeChange` 动态调高度（clamp 44–240px）；Enter 发送仅在**非触屏**设备（`navigator.maxTouchPoints === 0`）的 web 端生效（`onKeyPress` 且 `!shiftKey`），触屏设备回车换行；发送后 `keepInputFocused()` 保持焦点（web 用 `requestAnimationFrame` 补一次），发送按钮外层 `View` 挂 `mousedown` preventDefault 防止点按钮时 web 失焦（`Button` 支持 `onPressIn`）
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
cd dme-client && bun run build:web                    # expo export -p web && workbox generateSW（产物 dist/ 含 sw.js/manifest.json/icons，离线 PWA）

# dme-server
cd dme-server && go run main.go --addr :8080 --db ./dme.db --jetstream wss://jetstream2.fr.hose.cam
#   --addr      HTTP 监听地址（默认 :8080）
#   --db        BadgerDB 数据目录（默认 ./dme.db，自动创建，已 gitignored）
#   --jetstream Jetstream WSS（按区域选：us-east 1, us-west 2, eu 3）
# 也可用环境变量配置（命令行参数优先）：
#   DME_SERVER_ADDR              HTTP 监听地址（默认 :8080）
#   DME_SERVER_DB_PATH           BadgerDB 数据目录（默认 ./dme.db）
#   DME_SERVER_JETSTREAM_URL     Jetstream WSS（默认 wss://jetstream1.us-east.bsky.network）
#   DME_SERVER_ENVELOPE_TTL      信封 TTL（默认 168h / 7天）

# dme-gateway
cd dme-gateway && cp wrangler.toml.example wrangler.toml && bun install && bun run dev
cd dme-gateway && bun run deploy                      # wrangler deploy

# dme-miniapp（微信小程序）
cd dme-miniapp && npm install && npm run dev:weapp    # 开发（微信开发者工具打开 dist/）
cd dme-miniapp && npx tsc --noEmit                    # 类型检查
# 生产构建 + 上传必须走 deploy.mjs（含 ES5 降级 + @hpke 死代码剔除 + polyfill 注入），
# 命令、沙箱前缀 CODEBUDDY_SAFE_DELETE_ENABLED=0、上传 IP 白名单等详见 dme-miniapp/AGENTS.md
```

## 注意事项

- **Lexicon key**: envelope 用 `"key": "tid"`（AT Protocol 自动生成时间戳 rkey）；backup 用 `"key": "literal"`（rkey 固定 `"self"`，putRecord upsert）
- **Gateway**: Cloudflare Worker，职责 `/xrpc/dme.file.blob`（blob CDN：流式转发 PDS `com.atproto.sync.getBlob`，15s 上游超时（AbortController，失败返回 504），≤100MB 才写 `caches.default` 7 天缓存且经 `ctx.waitUntil` 后台写入不阻塞响应、缓存失败不影响下载；禁止 `arrayBuffer()` 全量缓冲+`clone()`，大文件会撞 Worker 128MB 内存/CPU 限额表现为请求无响应） + `/xrpc/dme.batch.get`（反代到 `DME_SERVER_URL`，隐藏客户端 IP）。全局 OPTIONS 预检 + CORS（**允许 `dme-server`、`Authorization` header**，预检缓存 24h），以支持浏览器 / Expo web 直连。`wrangler.toml` 的 `DME_SERVER_URL` 变量指向 dme-server。**请求头 `dme-server` 可动态覆盖目标 server 地址**（如 `curl -H "dme-server: https://dme.example.com" ...`），无需重新部署。Gateway 留空 → 客户端直连 server，blob 走 PDS `com.atproto.sync.getBlob`。群聊后续成员走 CF 边缘缓存，发送方 PDS 每分片只被打 1 次。**匿名性**：代码层显式只转发 `Content-Type`，不透传 `CF-Connecting-IP`/`X-Forwarded-For`/`User-Agent` 等；Wrangler 注入中间件 `strip-cf-connecting-ip-header.js` 再次兜底删除 `CF-Connecting-IP`。dme-server 仅见 CF 边缘 IP。
- **SkiaButton 已废弃**: 所有屏幕改用 `Button.tsx`（Pressable+Text），`SkiaButton.tsx` 保留但无引用
- **主页顶部栏**: ChatListScreen 顶部栏仅保留 +Group、+Friend 两个直接按钮 + 用户头像；Scan/Settings/Block List/Logout 收入头像弹出菜单
- **expo-image**: 新增依赖 `expo-image@~2.0.7`（Expo 52 兼容），替代 `react-native` Image 用于头像渲染
- **i18n Provider 层级**: `I18nProvider` 必须包在 `AppProvider` 外层（`AppContext` 内部用 `t()` 渲染群系统消息文案）；`AppProvider` 里 `useI18n()` 取 `language`，凡生成文案的 `useCallback` 依赖数组须含 `language`
- **i18n 字典键数**: `zh` 与 `en` 字典各 202 key，键命名 `<screen>.<name>`，新增时两语言同时登记；`en` 缺失回退 `zh`，再回退 key
- **QR 渲染去 Skia**: 预览与 PNG 生成在 Web 上绕过 Skia（`Skia.Surface.MakeOffscreen` 需图形上下文，部分 Web 环境缺失致预览空白/崩溃）；`generateQrSvgDataUri` 走 `qrcode` SVG -> data URI -> `expo-image`，`generateQrPngBytes` 在 Web 走 SVG->`<img>`->canvas，Native 才用 Skia。`generateQrPngBytes` 现为 **async**（返回 `Promise<Uint8Array | null>`）
- **Bluesky 邀请帖多语言**: 邀请帖正文（`generateInvitePostText` / `generateAddFriendPostText`）与 embed 图片 alt（`post.qrAlt`）随发帖时 `language` 渲染，需显式传 `lang` 参数
- **Web 页面标题**: `document.title` 统一 `"<标题> - DME"`，仅 Web 生效；静态路由由 `App.tsx` 的 `ROUTE_TITLE_KEYS` + `onStateChange` 集中管理，会话级动态标题（ChatView/GroupSettings/DmSettings）加入 `SCREEN_MANAGED_TITLES` 由屏幕自身 `useWebTitle` 管理；RN Navigation 自带标题以 `documentTitle={{ enabled: false }}` 关闭
- **备份恢复**: 恢复后 MLS 会话+KeyPackage池+群聊元数据+屏蔽列表完整恢复，无需重新握手；消息历史不备份
- **退出登录**: ChatListScreen 头像菜单点击 Logout 弹模态对话框，要求用户输入密码先备份（`backupIdentity`）再退出；退出时 `storage.clear()` 删除设备上所有 `dme:<did>:` 前缀的 AsyncStorage 数据；不备份则取消留在当前会话
- **Go 模块路径**: `dme/dme-server`（本地路径，非 GitHub）
- **dme.db/**: 运行时自动创建的 BadgerDB 数据目录，已 gitignored
- **dme-server 环境变量**: 支持 `DME_SERVER_ADDR`、`DME_SERVER_DB_PATH`、`DME_SERVER_JETSTREAM_URL`、`DME_SERVER_ENVELOPE_TTL` 四个环境变量，命令行参数优先覆盖
- **secretTree 索引**: ts-mls 的 SecretTree 按树位置索引（0=leaf0, 1=parent, 2=leaf1），`getExpectedGeneration` 内部用 `leafIndex * 2`
- **轮询批量预计算**: poller 默认预计算 3 个 future queueId，可在 Settings 页面调整（1-20）
- **群聊消息存储**: 通过 `StoredMessage.conversationId` 指定存储到群聊而非1:1，`kind` 字段区分消息类型；`group_invite_request` 在 ChatListScreen 预览渲染为 `@handle邀请你加入群聊：{groupName}`，在 ChatViewScreen 渲染为居中紧凑卡片 `群聊邀请：{groupName}` + Accept/Decline 按钮，顶部邀请队列显示 `From @handle`
- **群主离线**: 只有群主能 addMember/removeMember，群主离线时无法管理成员
- **群聊创建者**: 群主不能离开群组（MLS 限制 removeMember 不能移除 committer），只能解散
- **浏览器调试现场保护**: 当用户要求「看控制台日志」时，直接使用 `browsermcp_browser_get_console_logs` 抓取当前页面日志，禁止 `browsermcp_browser_navigate` 刷新或跳转页面，避免破坏报错现场
- **ChatViewScreen 依赖陷阱**: `useFocusEffect` 不可依赖整个 `AppContext` value 对象，否则 `chatListVersion` 递增会导致 effect 重新 fire -> 再次触发 `markConversationAsRead` -> 无限 `Maximum update depth exceeded` 循环
- **DID 解析并发**: `ChatViewScreen`/`ChatListScreen`/`GroupSettingsScreen`/`CreateGroupScreen` 中批量解析 DID 时必须用 `Promise.all`，禁止 for 循环内串行 `await`
- **Web emoji 反应触发**: Web 无 `onLongPress`，每条文本/文件消息气泡旁固定 emoji 按钮（incoming 右下/outgoing 左下）唤起 `EmojiPicker` 浮层
- **expo-av**: 新增依赖 `expo-av@~15.0.0`（Expo 52 兼容，已 deprecated 但仍可用），用于 Native 端播放提示音；Web 端用 Web Audio API 无需此依赖
- **expo-document-picker**: 新增依赖 `expo-document-picker@~57.0.1`（Expo 52 兼容），用于文件选择（`getDocumentAsync({type: '*/*'})`），返回 `{uri, name, mimeType, size}`
- **Web 部署 (Cloudflare Pages)**: `bun run build:web`（`expo export -p web && workbox generateSW workbox.config.js`，devDependency `workbox-cli`（bin `workbox`））产物 `dist/` 静态托管，含 `dist/sw.js`（预缓存 index.html/JS/canvaskit.wasm/字体/图标，离线可启动）+ `dist/manifest.json` + `dist/icons/`；`public/_headers` 注入 COOP/COEP（`Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp`，Skia CanvasKit WASM 必需）与长缓存 `Cache-Control: public, max-age=31536000, immutable`，并按路径拆分缓存：`/sw.js`、`/manifest.json` → `no-cache`，`/`、`/index.html` → `max-age=0, must-revalidate`（均用 `! Cache-Control` 摘除 `/*` 长缓存，**顺序敏感：`/*` 在前**）；SW 静默后台升级（skipWaiting+clientsClaim，无提示）；图标由 `python3 dme-client/scripts/generate-brand-assets.py` 生成到 `public/icons/`（192/512/maskable/180/favicon）；`index.web.js` 用**同步 `require('./App')`**（延迟到 CanvasKit 就绪后执行），`LoadSkiaWeb({ locateFile: (file) => `/${file}` })` 用**绝对路径** `/`；禁止改回动态 `import('./App')`（会产生 async chunk，需 `@expo/metro-runtime` 的 `__loadBundleAsync`，而手写 `public/index.html` 不会注入该运行时，导致 `Requiring unknown module` 报错）
- **iOS Safari 兼容**: ts-mls 的 `nobleCryptoProvider` 会探测 `crypto.subtle` 并走 WebCrypto Ed25519/X25519，iOS < 17.4 会抛 `NotSupportedError`，故所有取 CiphersuiteImpl 处改用 `getNobleMlsImpl()`（hash/kdf/signature/hpke/rng 全部纯 JS）；`deriveMessageQueueId` 内部自行取 impl（不再收 impl 参数）；`getMlsImpl` 已删除
- **CI Release**: `.github/workflows/release.yml` 交叉编译 6 目标（linux amd64/arm64/armv7、darwin amd64/arm64、windows amd64），`CGO_ENABLED=0`，已移除 `docker/setup-qemu-action`（Go 纯 Go 交叉编译无需 QEMU），Build/Verify 步骤显式 `shell: bash`（Windows runner 默认 pwsh 不支持此处语法）；打 `v*` tag 触发 `go build -ldflags="-s -w -X main.version=<tag>"` 并发布 GitHub Release
- **Web 消息操作菜单**: Web 无 `onLongPress`，但气泡 `ref` 挂 `contextmenu` 事件监听器捕获右键，调用 `measureInWindow` 取坐标后弹出 `MessageActionMenu`；原生走 `onLongPress` 同一路径
- **文件发送**: 先保存本地副本（web->IndexedDB / native->documentDirectory）再上传；先写入 `uploadStatus:'uploading'` 乐观消息（tempId 为 `generateId()`），成功后删除临时消息写入最终消息（id=MLS queueId，reactions 跨端靠 queueId 匹配）。逐块 5MB AES-256-GCM 加密，经 XHR `uploadBlobWithProgress` 上传 PDS（`upload.onprogress` 字节级 uploadProgress；fetch 无上传进度故绕过 agent.uploadBlob，自带 Authorization + atproto-proxy header，取自 `session.pdsUrlStr`/`session.accessJwt`/`agent.proxy`）。blobCids 字段引用（标准 `{$type:'blob', ref:{$link}, mimeType, size}` 格式，PDS 可识别防 GC），与 MLS manifest 共存同一条 `dme.queue.envelope`（单 record）。上传失败仅置 `uploadStatus:'failed'` 不抛异常，可 `retryUploadFileMessage` 从本地副本重试。下载时 blob fetch 失败指数退避重试 2s/4s/8s，最多 3 次。图片 ≤ 5MB 自动下载，其他类型手动
- **文件消息存储**: `StoredMessage.kind = 'file'`，`fileMeta` 字段含完整元数据（含 `uploadStatus`/`uploadProgress`/`downloadStatus`/`downloadProgress`）。`updateFileMessageMeta` 局部更新状态/进度/本地路径。发送方上传成功后 `downloadStatus: 'ready'` + `uploadStatus: 'uploaded'`，接收方初始 `downloadStatus: 'pending'`。上传中消息 id 为临时 generateId，成功后替换为 queueId
- **文件消息 UI**: `FileMessageBubble` 按 mimeType 分支渲染（image -> expo-image 缩略图，video -> ▶ 按钮，audio -> 播放卡片（圆形 ▶/⏸ 按钮，pending 点击触发下载、ready 后点击播放/暂停；web 用 HTMLAudioElement，native 用 expo-av 动态 import；本地 URI 解析中显示禁用态+转圈），其他 -> 📎 + 文件名 + 大小）。上传状态：uploading -> 字节级进度百分比，failed -> 上传失败+重试按钮。下载状态：pending -> 点击下载，downloading -> 字节级进度百分比，ready -> 点击打开，failed -> 重试按钮。群聊时复用与 `MessageBubble` 相同的双列布局（头像列 + 内容列昵称+@handle），1:1 不渲染头像列
- **文件消息预览**: ChatListScreen 最近消息 `kind === 'file'` 显示 `📎 filename`
- **文件分片完整性**: 每片独立 AES-256-GCM 加密，nonce 由 fileId 前 8 字节 + chunkIndex 4 字节大端组成，同一 fileKey 下 nonce 不重复。解密后拼接整文件 SHA-256 与 manifest 比对
- **文件大小限制**: 无硬限制，逐块 5MB 读取加密，内存 O(5MB)。>500MB 弹警告确认。无断点续传，任一 uploadBlob 失败则整个发送失败
- **文件本地存储**: 下载后写入本地：Native 以 base64 写入 `expo-file-system` documentDirectory（路径 `{msgId}_{sanitizedFileName}`），Web 写入 IndexedDB 并以 `indexeddb://{fileId}` 作为 localPath，组件渲染时通过 `useFileUri` 解析为 blob URL；发送方同样持久化，刷新页面后仍可显示
- **文件消息 reactions**: `FileMessageBubble` 支持 `reactions`/`onReactionPress`/`onOpenPicker`，和文本消息一样的 emoji 反应交互
- **聊天列表分页**: `ChatViewScreen` 使用 `inverted={true}` FlatList，数据 newest-first；进入时只加载最近 50 条，滑到顶部触发 `onEndReached` 加载更早 50 条；`chatListVersion` 变化时 merge 最近 N 条（N = max(50, 已加载数)），merge 时会过滤 prev 中已不在 storage 最近窗口的消息（乐观上传消息被最终消息替换后自动从 UI 移除），不再依赖 `scrollToEnd`
- **中断传输重置**: `restoreSession` 启动恢复后遍历所有会话，把 `downloadStatus:'downloading'` 重置为 `'pending'`（并清 downloadProgress）、`uploadStatus:'uploading'` 重置为 `'failed'`，避免刷新/杀进程后消息永远转圈无法二次触发
- **进度百分比**: 上传/下载均为字节级。上传 = XHR `upload.onprogress` 已传字节 / 总加密字节（fileSize + 分片数×16）；下载 = `response.body.getReader()` 已读字节累计 / blobCids size 总和（不依赖 content-length）；进度只在整数百分比变化时写 storage + 递增 chatListVersion；进行中上限 99%，完成后清空
