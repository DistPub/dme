# DME 与 Bluesky 原生私信功能对比

**调研时间**：2026-09-27（更新）  
**对比对象**：DME（Decentralized Message Envelope）与 Bluesky 原生 Direct Messages（截至 2026 年 9 月）

## 核心结论

| 维度 | DME（本项目） | Bluesky 原生 DM |
|---|---|---|
| **加密** | 原生端到端加密（MLS RFC 9420） | 原生无 E2EE；moderation 可调取消息内容 |
| **客户端形态** | 独立 App（Expo + React Native） | 内嵌在 Bluesky 官方 App 中 |
| **1:1 聊天** | 支持 | 支持 |
| **群聊** | 支持，群主管理（无硬性人数上限） | 支持（2026.06 上线），上限 50 人 |
| **媒体/文件** | **已支持**（图片、视频、音频、文档） | 暂不支持（官方称需先完善安全系统） |
| **架构** | 去中心化：PDS 记录 + Jetstream + 自建 AppView | 中心化 chat service（`api.bsky.chat`） |
| **身份验证** | DID 文档声明 X25519/Ed25519 双公钥 | 复用 Bluesky 账号，无额外密钥声明 |
| **备份恢复** | PBKDF2+AES-GCM 全量备份到 PDS | 无此概念，依赖官方服务 |
| **内容 moderation** | 平台无法解密，无 moderation | Bluesky moderation 可调取举报消息及上下文 |
| **反垃圾/隐私设置** | 屏蔽用户、屏蔽列表 | 可设置谁可发消息/谁可拉进群 |
| **表情反应** | **已支持**（E2E 加密传输、聚合渲染、计数） | 暂不支持 |
| **消息操作** | **已支持**（复制、转发、删除） | 支持删除、转发 |
| **多语言** | **已支持**（中/英双语，运行时切换） | 官方 App 支持多语言 |
| **消息提示音** | **已支持**（运行时生成 880Hz WAV） | 支持 |
| **互操作性** | 需双方都安装 DME 客户端 | 所有 Bluesky 用户原生互通 |

## 1. 加密与隐私

**DME** 从设计之初就是 E2EE：
- 使用 MLS（Messaging Layer Security，RFC 9420），密码套件为 `MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519`
- 每个用户在 DID 文档中声明 `#dme_encryption`（X25519）和 `#dme_signing`（Ed25519）公钥
- 消息内容以 MLS 密文写入 PDS，Jetstream 消费后存入 AppView；服务端只存储密文，无法解密
- 握手/建群依赖 X25519 ECDH + QR 码或 1:1 通道交换 KeyPackage

**Bluesky 原生 DM**：
- 官方文档和 safety 账号均确认：原生 DM **不是端到端加密**
- Bluesky moderation 可以在必要时（如调查垃圾、协同骚扰）访问消息内容
- 2025 年 7 月 Bluesky 与第三方 **Germ** 合作，在 Bluesky 个人资料页提供 Germ DM 按钮；Germ 才是基于 MLS 的 E2EE，但需要跳转到 Germ App

## 2. 架构差异

**DME** 是协议层去中心化方案：
- 密文作为 AT Protocol 记录（`dme.queue.envelope`）写入用户自己的 PDS
- AppView（dme-server）通过 Jetstream 监听全网的 envelope 记录，存入 BadgerDB
- 客户端轮询自建 AppView 批量盲查 queueId 获取消息
- 密钥、会话、群聊元数据、屏蔽列表全部存在本地，支持加密备份到 PDS

**Bluesky 原生 DM** 是服务层方案：
- 通过 `chat.bsky.convo.*` API 访问，请求先打到用户 PDS，再被代理到中心 chat service（`did:web:api.bsky.chat`）
- 消息由 Bluesky 运营的 chat service 存储和投递
- 更像传统社交平台的私信 backend

## 3. 群聊

**DME 群聊**：
- 通过 1:1 MLS 通道发送 `group_invite_request` / `group_invite_response`
- 群主收集 KeyPackage 后创建 MLS 群组并分发 `group_welcome` + `group_commit`
- 群主可 add/remove/dissolve；成员可主动 leave；MLS 限制群主不能 leave，只能解散
- 没有人数上限的硬编码，实际受 MLS 树性能和 KeyPackage 分发复杂度限制
- 群聊消息同样走 MLS E2EE，支持文件、表情反应等完整功能

**Bluesky 群聊**：
- 2026 年 6 月随 v1.124 上线，上限 **50 人**
- 群主可管理成员、生成邀请链接
- 用户可设置"谁可以邀请我进群"：所有人 / 仅我关注的人 / 没有人
- 仍走中心化 chat service，无 E2EE

## 4. 媒体与文件传输（DME 已完整实现）

**DME 文件传输**：
- **加密**：发送方生成随机 32 字节 fileKey，逐块 5MB AES-256-GCM 加密，nonce = fileId 前 8 字节 + chunkIndex 4 字节大端
- **上传**：先保存本地副本（web→IndexedDB / native→documentDirectory）并写入 `uploadStatus:'uploading'` 乐观消息；每块经 XHR `uploadBlobWithProgress`（字节级 uploadProgress）上传 PDS；blobCid 存入 `dme.queue.envelope` record 的 `blobCids` 字段（标准 ATProtocol blob 引用格式，PDS 可识别防 GC）；成功后删除临时消息写入最终消息（id=MLS queueId）
- **信令**：file manifest（type: 'file'，含 fileKey/fileId/sha256/mimeType 等）通过 MLS application message 加密，与 blobCids 共存同一条 envelope
- **下载**：接收方从 manifest 拿到 fileKey → 从同一 envelope 的 `blobCids` 取 blob refs → 流式 GET gateway `/xrpc/dme.file.blob`（`response.body.getReader()` 字节级 downloadProgress）→ AES-256-GCM 解密 → SHA-256 验证 → expo-file-system 存本地
- **CDN 缓存**：Gateway 用 `caches.default` 缓存 blob 响应 7 天（≤100MB，`ctx.waitUntil` 后台写入不阻塞响应），群聊中后续成员走 CF 边缘缓存，发送方 PDS 每分片只被打 1 次
- **校验**：解密后拼接 → SHA-256 验证与 manifest 一致
- **图片自动下载**：`image/*` 且 ≤ 5MB（1 个 chunk）自动触发下载，其他类型手动点击
- **视频/音频**：支持首帧缩略图生成（native 用 expo-video-thumbnails，web 用隐藏 `<video>`+`<canvas>` 抓帧）、全屏播放（expo-video）、音频播放卡片（圆形 ▶/⏸，web 用 HTMLAudioElement，native 用 expo-av）

**Bluesky DM**：目前也仅支持文本、链接、富文本 facet、record embed；图片/视频/文件官方表示"很有价值，但要先建新的安全与 moderation 系统"

## 5. 表情反应（DME 已完整实现）

**DME 表情反应**：
- 协议：`ReactionMessage`（`type: 'reaction'`，add/remove，`targetMessageId`、`conversationId`、`emoji`、`createdAt`）
- 走现有 MLS session（1:1 或群聊）加密传输
- 本地先 toggle `StoredMessage.reactions`（`Reaction[]`）再发送，接收端 `handleIncomingMessage` 直接更新目标消息，不存为文本
- UI：`MessageBubble`/`FileMessageBubble` 按 emoji 聚合渲染 pill，相同 emoji 合并并显示计数（>1 时小字），当前用户参与的高亮
- Web 无长按：每条文本/文件气泡旁固定 emoji 按钮触发 `EmojiPicker`（`measureInWindow` 锚定浮层）

**Bluesky DM**：暂不支持表情反应

## 6. 消息操作（DME 已完整实现）

**DME 消息操作菜单**：
- 长按（原生）/右键（web）消息气泡弹出 `MessageActionMenu`
- **复制**：走 `expo-clipboard`
- **转发**：跳 ChatList 选择目标后 `sendMessage` 再 `replace` 跳 ChatView
- **删除**：仅本地删除（PDS 密文不变），`db.ts` 的 `deleteMessage` 从 AsyncStorage 过滤删除指定 messageId，递增 `chatListVersion` 刷新 UI

**Bluesky DM**：支持删除、转发

## 7. 屏蔽/隐私（DME 已实现基础屏蔽）

**DME 屏蔽**：
- 入口：主页头像弹出菜单 → `Block List` 屏幕（`BlockListScreen`）
- 私聊管理页可 Block（弹模态确认，标题「屏蔽用户」，模态中 handle 渲染为 `@xxx`）；已 block 显示取消屏蔽（直接执行）
- 群管理页成员行可 Block（弹模态确认，标题「屏蔽成员」）；已 block 成员显示 Unblock（直接执行）
- 屏蔽列表行展示：头像 + 昵称 + @handle + Unblock 按钮
- `handleIncomingMessage` 入口处检查 `app.blockList`，命中则跳过该消息存储（poller 仍标记 queueId 已处理）
- `ChatViewScreen.loadMessages` 在内存中过滤 `m.fromDid ∈ blockList` 的消息
- `ChatListScreen.loadConversations` 排除被屏蔽发送者的未读计数，preview 显示「已屏蔽」
- 不删除已存储消息、不修改群成员关系、不通知对方、不自动 remove

**Bluesky DM**：可设置谁可以发消息、谁可以拉我进群、屏蔽用户、举报消息/用户、消息请求箱

## 8. 多语言（DME 已完整实现）

**DME i18n**：
- 支持 简体中文 (`zh`) / English (`en`) 双语，运行时切换，无需重启
- Provider：`I18nProvider` 持有 `language` state；挂载在 `App.tsx` 最外层（`AppProvider` 之外，因 `AppContext` 内部也要用 `t()`）。启动从 AsyncStorage key `dme:language` 读取偏好，默认 `zh`；`setLanguage` 写回 AsyncStorage 并更新 state
- Hook：`useI18n()` 返回 `{ language, setLanguage, t }`；`t` 已被当前语言柯里化，组件内直接 `t('key')`
- 字典：`translations.ts` 中 `zh`/`en` 两个 `Record<string,string>` 字典（各 202 key，键命名 `<screen>.<name>`，通用键归 `common.*`）
- 格式化：纯函数 `t(lang, key, params?)`：查 `en` → 回退 `zh` → 回退 key 本身；`{name}` 占位符按 `String(v)` 替换
- 切换入口：Settings 页顶部 `Language` 区块，`LANGUAGES` 渲染为一排按钮，当前语言 `variant="primary"`；`setLanguage(code)` 立即生效
- 覆盖范围：全部 UI 屏幕 + 消息气泡 / 操作菜单 / 表情 / 文件卡片 + 群系统消息文案 + 时间格式化 + Bluesky 邀请帖正文与 QR alt 文本
- 群聊系统消息与邀请帖正文在**生成时**按当前 `language` 渲染并存入 `plaintext`（历史消息保持生成时的语言，不随切换改变）

## 9. 消息提示音（DME 已实现）

**DME 提示音**：
- 新消息到达时播放「嘀嘀嘀」3 声 880Hz 提示音，声音由 `src/utils/sound.ts` 运行时生成（无音频文件依赖）
- Web：Web Audio API 振荡器（`AudioContext` + `OscillatorNode`），无文件
- Native：运行时生成 WAV base64 → `expo-file-system` 写入临时文件 → `expo-av` 播放
- 触发逻辑：收到 `kind: 'text'` 或 `kind: 'group_invite'` 消息后
  - 不在任何聊天页面 → 任意会话 ✅ 播放
  - 在会话 A 的聊天界面 → 会话 A ✅ 播放
  - 在会话 A 的聊天界面 → 会话 B ❌ 不播放
- `activeConversationRef`（`useRef`）追踪当前 ChatView 的会话 ID，ChatView focus 时设置、blur 时清空，不触发重渲染
- `soundEnabled`（`boolean` state）控制全局开关，Settings 页 Switch 切换，默认 `true`，持久化到 AsyncStorage
- 系统消息（`kind: 'group_system'`）和表情反应（`type: 'reaction'`）不触发提示音

## 10. 用户体验与生态

**DME 的优势**：
- 真正的去中心化 + E2EE，平台方无法读取消息
- 身份密钥和群聊元数据可备份恢复，换设备可还原会话（含屏蔽列表）
- 不依赖 Bluesky 官方 chat service，理论上可在任何 AT Protocol 客户端/实例运行
- **已完整支持文件传输（图片/视频/音频/文档）、表情反应、消息操作、屏蔽、多语言、提示音**
- 群聊无人数硬上限

**DME 的劣势**：
- 必须单独安装 DME 客户端，双方都用 DME 才能通信
- 没有 Bluesky 的原生 moderation、举报、反垃圾能力、消息请求箱
- 握手和群管理流程较重（QR / KeyPackage 交换 / 群主离线即无法加人）
- 无"谁可以发消息/拉我进群"设置、无已读状态/未读数、无推送通知、无消息搜索、无链接预览、无引用回复、无会话置顶/归档、无消息编辑、无语音消息
- 无群邀请链接、无进群邀请请求箱、无通过 handle 搜索用户、无从关注列表导入

**Bluesky 原生 DM 的优势**：
- 内嵌官方 App，所有 Bluesky 用户原生可达
- 有成熟的隐私设置、举报、 moderation、消息请求箱
- 群聊有邀请链接、人数管理等易用功能

**Bluesky 原生 DM 的劣势**：
- 无原生 E2EE，隐私依赖平台信任
- 中心化 chat service 是单点
- 暂不支持媒体/文件、表情反应

## 11. DME 相对于 Bluesky 原生 DM 的**真正**缺失功能

只对照 Bluesky 原生私信，DME 还缺失：

| 类别 | 缺失功能 |
|---|---|
| 隐私与安全 | 谁可以发消息设置、谁可以拉我进群设置、举报消息/用户、消息请求箱 |
| 会话与通知 | 已读状态/未读数、静音会话、离开 1:1 会话、推送通知、批量发消息 |
| 群聊 | 群邀请链接、群人数上限显示、进群邀请请求箱 |
| 发现与新建聊天 | 通过 handle 搜索用户、从 Bluesky 关注列表导入 |
| 消息增强 | 消息搜索、链接预览、引用回复某条消息、消息编辑、语音消息、会话置顶/归档 |

以下功能双方目前都**不支持**，因此不算 DME 相对于 Bluesky 的缺失：
- 语音消息
- 链接预览
- 引用回复某条消息
- 消息编辑
- 会话置顶/归档
- 消息搜索

## 一句话总结

DME 相当于"用 AT Protocol 自建的去中心化 Signal/MLS 消息层"，强调 **隐私和去中心化**；已完整实现 **文件传输、表情反应、消息操作、屏蔽、多语言、提示音、群聊** 等核心功能。Bluesky 原生 DM 则是"传统社交平台私信"，强调 **易用性和 moderation**，但牺牲端到端加密，且目前仍不支持媒体消息与表情反应。