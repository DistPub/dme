# AGENTS.md

- 输出或提示优先用中文。
- 开始回答前先说"帅哥是这样的"

---

# dme-client

Expo ~52 + React Native + @shopify/react-native-skia 移动 App。TypeScript strict，Bun 管理。支持 1v1 和群组聊天。

## 结构

```
dme-client/
├── index.js              # 原生入口 (registerRootComponent)
├── index.web.js          # Web 入口（Skia WASM 异步预加载）
├── App.tsx               # 导航根 + Provider 栈
├── package.json          # @dme/client
├── tsconfig.json         # extends expo/tsconfig.base, strict:true
├── app.json              # scheme:dme, dark, 3 平台
├── metro.config.js       # unstable_enablePackageExports（@atproto/identity 需要）
├── scripts/generate-brand-assets.py  # 生成 public/icons/（192/512/maskable/180/favicon）
├── public/               # _headers + index.html + manifest.json + icons/（sw.js 构建时生成，不入库）
└── src/
    ├── config.ts         # PDS_URL, DME_SERVER_URL, PLC_DIRECTORY_URL, 轮询间隔
    ├── crypto/           # MLS 加密模块（见 crypto/AGENTS.md）
    ├── atproto/          # session.ts / pds.ts / did.ts
    ├── handshake/        # handshake.ts / invite.ts / qr-encode.ts / qr-decode.ts / group-invite.ts
    ├── poll/poller.ts    # 5-15s 随机间隔轮询 + LRU 去重 + 批量预计算 future queueId + polling 重入保护 + inFlightQueueIds 防重复投递
    ├── storage/db.ts     # AsyncStorage，key 前缀 dme:<did>:
    ├── state/AppContext.tsx  # 全局状态（17 字段，28 action）
    ├── protocol/         # types.ts + group-message.ts + reaction.ts + lexicons/ JSON
    ├── utils/            # sound.ts（消息提示音：Web Audio API/expo-av + unlockWebAudio 静音解锁）+ file-cache.ts（IndexedDB 文件缓存 / useFileUri）+ file-export.ts（导出文件到设备/浏览器下载）+ video-thumbnail.ts（视频首帧缩略图）
    ├── ui/               # 22 个文件（12 屏幕 + 10 组件，含 BlockListScreen + DmSettingsScreen + MessageBubble + EmojiPicker + MessageActionMenu + FileMessageBubble + ImageViewerScreen + VideoViewerScreen）
    └── types/            # navigation.ts (RootStackParamList) + qrcode.d.ts
```

## 快速定位

| 任务 | 位置 |
|---|---|
| 添加新屏幕 | `src/types/navigation.ts` 加路由 + `src/ui/` 新文件 |
| 修改全局状态 | `src/state/AppContext.tsx` |
| 改轮询逻辑 | `src/poll/poller.ts` |
| 改存储 key | `src/storage/db.ts` |
| 改 PDS/DID 交互 | `src/atproto/` |
| 文件加密 | `src/crypto/file-crypto.ts`（逐块 AES-256-GCM 加解密） |
| 文件协议类型 | `src/protocol/types.ts`（`FileManifestMessage` + `FileMeta`） |
| 文件发送/下载/重试上传 | `src/state/AppContext.tsx`（`sendFileMessage` + `retryUploadFileMessage` + `downloadFile`，XHR/reader 字节级进度） |
| 文件消息气泡 | `src/ui/FileMessageBubble.tsx`（图片/视频/音频/文件卡片） |
| PDS URL 解析 | `src/atproto/did.ts`（`resolvePdsUrl`） |
| 改主题 | `src/ui/theme.ts` |
| 加新加密操作 | `src/crypto/`（见 crypto/AGENTS.md） |
| 改身份备份 | `src/crypto/backup.ts`（PBKDF2+AES-GCM 加密/解密 FullBackupData） |
| 改按钮组件 | `src/ui/Button.tsx`（Pressable+Text，支持中文） |
| 改设置页 | `src/ui/SettingsScreen.tsx` |
| 消息提示音 | `src/utils/sound.ts`（`playMessageSound()`，运行时生成 3 声 880Hz WAV；Web 用 Web Audio API `AudioContext` + `decodeAudioData`，Native 用 expo-av；`unlockWebAudio()` 首次手势静音 buffer 解锁） |
| 群聊消息类型 | `src/protocol/group-message.ts` |
| 群聊邀请协议 | `src/handshake/group-invite.ts` |
| 创建群聊 UI | `src/ui/CreateGroupScreen.tsx` |
| 群管理 UI | `src/ui/GroupSettingsScreen.tsx` |
| 私聊管理 UI | `src/ui/DmSettingsScreen.tsx`（对方头像+昵称+@handle；Block 按钮弹模态确认；已 block 显示取消屏蔽） |
| 屏蔽列表 UI | `src/ui/BlockListScreen.tsx` |
| 表情反应协议 | `src/protocol/reaction.ts`（`ReactionMessage` add/remove） |
| 消息 reactions 存储 | `src/storage/db.ts`（`Reaction` + `addReaction`/`removeReaction`） |
| 消息气泡 + reactions 渲染 | `src/ui/MessageBubble.tsx` |
| 文件消息气泡 + 上传/下载状态 | `src/ui/FileMessageBubble.tsx`（群聊双列布局：头像列 + 内容列(昵称+@handle+图片缩略图/视频首帧缩略图+▶遮罩/音频播放卡片/文件卡片)；1:1 不渲染头像列；上传 uploading/failed+重试 + 下载 pending 视频只显示「下载」按钮/downloading(字节级%)/ready 视频显示缩略图+▶/failed 状态 + reactions；长按/右键唤出转发/删除菜单；容器 `userSelect: 'none'`，图片/视频预览单独挂 `onLongPress`） |
| 图片查看器 | `src/ui/ImageViewerScreen.tsx`（全屏查看，点击或 ✕ 关闭） |
| 视频播放/全屏查看 | `src/ui/VideoViewerScreen.tsx`（Native 用 `expo-video` 的 `VideoView` + `useVideoPlayer`；Web/PWA 直接渲染原生 `<video muted playsInline autoplay controls>`；解码不支持时回退下载） |
| 视频 unsupported codec 提示与下载 | `src/ui/VideoViewerScreen.tsx`（web 预检 `videoWidth/videoHeight=0` 时提示「浏览器不支持视频解码」并提供下载按钮） |
| 视频首帧缩略图生成 | `src/utils/video-thumbnail.ts`（native 用 `expo-video-thumbnails`，web 用隐藏 `<video>`+`<canvas>` 抓帧） |
| 文件导出/下载到设备 | `src/utils/file-export.ts`（exportFileToDevice：web 用 anchor download，native 用 Share） |
| About 页面 | `src/ui/AboutScreen.tsx` |
| Web 文件缓存 | `src/utils/file-cache.ts`（IndexedDB 持久化 + `useFileUri`） |
| 文件选择器 | `expo-document-picker`（`getDocumentAsync({type: '*/*'})`） |
| 表情选择器 | `src/ui/EmojiPicker.tsx`（浮层锚定按钮） |
| 消息操作菜单 | `src/ui/MessageActionMenu.tsx`（长按/右键浮层：复制/转发/删除；文件消息通过 `showCopy=false` 隐藏复制项） |

## 导航流程

```
Login → (restoreSession) → Setup → ChatList ⇄ ChatView
                              ↘ QrDisplay（邀请）
                              ↘ QrScan（接受邀请）
                              ↘ CreateGroup（建群 / 邀请新成员）
                              ↘ GroupSettings（群管理）
                              ↘ DmSettings（私聊管理）
                              ↘ BlockList（屏蔽列表）
                              ↘ Settings（选项）
```

Web 支持 `?goto=QrDisplay|QrScan|ChatList|Settings` 和 `?auto=1`、`?token=` 查询参数。

## 约定

- **加密**: MLS (RFC 9420) 替换旧 Double Ratchet + X3DH。使用 ts-mls 库 + @noble 系列。
- **CiphersuiteImpl 取用（iOS16 Safari）**: 所有取 CiphersuiteImpl 处必须用 `getNobleMlsImpl()`（`src/crypto/mls-noble-kdf.ts`，仅把 kdf 换成纯 JS `nobleHkdfSha256`），禁止直接用 `getMlsImpl`/`nobleCryptoProvider` 默认 kdf（ts-mls HKDF 走 @hpke WebCrypto，iOS16 `crypto.subtle.importKey` 返回 undefined 崩溃）
- **身份密钥**: 每个用户拥有 Ed25519（签名/MLS 凭证）+ X25519（KeyPackage 加密）双密钥对
- **DID 文档**: `#dme_encryption`(X25519) 加密 KeyPackage + `#dme_signing`(Ed25519) 验证 MLS 凭证
- **KeyPackage**: 不上 PDS，通过 QR 或1:1通道点对点传递，用接收方 X25519 公钥加密
- **握手**: Alice 加密 KeyPackage -> QR -> Bob 扫码 -> 创建 MLS 群组 -> Welcome 走盲查通道
- **群聊邀请**: 通过已有1:1 MLS 通道传输 JSON 消息（group_invite_request/response/welcome/commit 等）
- **群聊 Commit**: addMember 产生的 Commit 通过1:1通道发给已有成员（poller 只轮询 application 消息）
- **状态管理**: 每字段一个 `useState` 的 React Context（非 useReducer），28 个 `useCallback` action
- **chatListVersion**: 单调计数器，storage 变化时递增触发 UI 刷新
- **屏幕模式**: `<View>` -> 绝对定位 `<Canvas><Fill/></Canvas>` -> flexbox 内容（RN Text/TextInput/Button）
- **阶段机**: 每个屏幕用联合类型 `Phase` 控制条件渲染
- **Skia 范围**: 仅屏幕背景 `<Canvas><Fill/></Canvas>` 用 Skia；按钮用原生 `Button`（Pressable+Text）
- **字体**: `FontProvider` 一次性加载 Roboto-Regular.ttf，`useAppFont(size)` 返回 SkFont
- **资产目录分工**: 根级 `assets/images/` = 品牌/图标/启动屏构建资产（由 `app.json` 消费，如 icon / adaptiveIcon / favicon / splash），`src/assets/` = 运行时资源（代码 `require`），两者勿混
- **主题**: `theme.ts` 单一 `as const` 对象，暗色（#0a0a0a），无切换
- **命名导出**: 统一 `export function/class`，无 default export（除 App.tsx）
- **轮询**: 每 5-15s 随机间隔，批量预计算 `batchSize`（默认 3，1-20 可配置）个未来 queueId，按 generation 排序处理；`pollOnce` 用 `polling` 布尔标志防重入，`inFlightQueueIds`（Set）跳过本轮已投递 queueId，且 `markQueueIdProcessed` 在 `onMessage`/`onWelcome` 之前调用（先标记后处理，避免回调 await 期间被下一轮重复处理）
- **消息去重**: `DmeStorage.hasMessage(conversationId, messageId)` 判断会话是否已存指定 messageId；`handleIncomingMessage` 的 text/file 分支（含群聊 default 分支）入口做幂等检查，已存在则跳过存储，防止重复存储与误播提示音
- **输入框多行自适应**: `ChatViewScreen` 输入框 `multiline`，`onContentSizeChange` 动态调高度（clamp 44–240px）；`FlatList + 输入栏` 外层包 `KeyboardAvoidingView`（iOS `behavior='padding'`），header 保持在键盘上方不被顶出；Web/PWA 端 `public/index.html` 把 `html/body/#root` 设为 `100dvh`，让键盘弹起时根容器随可视窗口缩放，避免整页被顶上去；Enter 发送仅在**非触屏**设备（`navigator.maxTouchPoints === 0`）的 web 端生效（`onKeyPress` 且 `!shiftKey`），触屏设备回车换行；发送后 `keepInputFocused()` 保持焦点（web 用 `requestAnimationFrame` 补一次），发送按钮外层 `View` 挂 `mousedown` preventDefault 防 web 失焦（`Button` 支持 `onPressIn`）
- **消息类型**: `StoredMessage.kind` 区分 `text`/`group_invite`/`group_system`/`file`；`conversationId` 指定存储到哪个会话；`group_invite_request` 在 `ChatListScreen` 最近消息预览渲染为 `@handle邀请你加入群聊：{groupName}`，在 `ChatViewScreen` 渲染为居中紧凑卡片 `群聊邀请：{groupName}` + Accept/Decline 按钮，顶部邀请队列显示 `From @handle`
- **表情反应**: `ReactionMessage`（`type: 'reaction'`，add/remove）通过 MLS session 加密发送，挂在 `StoredMessage.reactions`（`Reaction[]`），接收端 `handleIncomingMessage` 的 `reaction` 分支直接更新目标消息，不存为文本；UI 在 `MessageBubble`/`FileMessageBubble` 按 emoji 合并并显示计数
- **屏蔽列表**: `blockList: string[]` 存储在 `AsyncStorage`，入口为 ChatList 头像菜单 + 私聊管理页（`DmSettingsScreen`）+ 群管理成员行；可 Block/Unblock；被 block 用户的消息不存储、不展示；不修改群成员关系
- **Profile 批量获取**: 多个 DID 的 profile 必须用 `app.bsky.actor.getProfiles({ actors: string[] })` 批量接口，`getProfiles` 失败时 fallback 到 `sharedDidResolver`（仅 handle）；**ChatListScreen / GroupSettingsScreen / BlockListScreen 等首屏加载**须先读 `profileCacheRef`/`handleCacheRef` 本地缓存同步构造 rows 并立即 `setRows`/`setLoading(false)`，有缺失时再异步调用 `resolveProfiles`/`resolveHandle`，拿到结果后用 `setRows(prev => prev.map(...))` 更新，禁止同步 `await` 网络请求阻塞首屏
- **消息操作菜单**: 长按（原生）/右键（web）气泡弹出 `MessageActionMenu`（复制/转发/删除）；`MessageBubble` 与 `FileMessageBubble` 均支持；文件消息隐藏「复制」，保留「转发/删除」；`FileMessageBubble` 对图片/视频预览等内部可交互元素也单独挂了 `onLongPress`，并对容器加 `userSelect: 'none'`，Web 端 `public/index.html` 全局禁用 `img/video` 的 `-webkit-touch-callout` 与 `-webkit-user-select`，避免 iOS 长按触发原生选字/图片预览导致自定义菜单出不来；复制走 `expo-clipboard`，文本转发跳 ChatList 选择目标后 `sendMessage` 再 `replace` 跳 ChatView，文件转发通过 `forwardFile` 路由参数走 `sendFileMessage`，删除仅本地删除（PDS 密文不变）
- **消息提示音**: `playMessageSound()`（`src/utils/sound.ts`）播放「嘀嘀嘀」3 声 880Hz；Web 用 Web Audio API（`AudioContext` + `decodeAudioData` 解码运行时生成的 WAV buffer），Native 用 `expo-av` 播放运行时生成的 WAV（写入 `expo-file-system` 临时文件，首次生成后缓存）；`unlockWebAudio()` 在 ChatListScreen 会话行 `onTap` 首次手势时播放 1-sample 静音 buffer 解锁（iOS Safari 唯一可靠方式）；`handleIncomingMessage` 对 `kind: 'text'` 和 `kind: 'group_invite'` 消息触发，`kind: 'group_system'` 和 `type: 'reaction'` 不触发；`activeConversationRef`（ref，不触发重渲染）追踪当前 ChatView 会话 ID 决定是否播放，`soundEnabled`（state）控制全局开关
- **身份备份**: `backup.ts` 用 PBKDF2-SHA256(100k iter)+AES-256-GCM 加密 FullBackupData（身份密钥+MLS会话+KeyPackage池+群聊元数据+屏蔽列表），存 PDS `dme.backup.identity` record（rkey=self）。Settings 页设密码备份，Setup 页检测到 DID 有 key 但本地不匹配时提供恢复入口
- **did:web 支持**: did:web 用户无法 PLC 操作，Setup 页 `web_instructions` step 提供 did.json 全文（DME 新增部分绿色高亮）供用户手动更新后点「检测」验证
- **Web 模态对话框**: `Alert.alert` 在 Web 端无效（无 polyfill），确认弹窗用 React Native `Modal` 组件（`transparent` + `animationType="fade"`），跨平台统一；模态遮罩用 `View` + `StyleSheet.absoluteFill` 的 `TouchableOpacity` 做背景层，卡片 `View` 独立放上层，避免 `TouchableOpacity` 包裹卡片导致 `TextInput` 点击冒泡关闭模态
- **AsyncStorage v3 web API**: `@react-native-async-storage/async-storage` v3 在 web 端只导出 `getItem`/`setItem`/`removeItem`/`getAllKeys`/`clear`/`getMany`/`setMany`/`removeMany`，**没有** v2 的 `multiRemove`/`multiGet`/`multiSet`。批量操作须用 `Promise.all(keys.map(k => AsyncStorage.removeItem(k)))` 等替代，禁止直接调 `AsyncStorage.multi*`（web 会抛 `TypeError: ... is not a function`，native 正常）

## 注意事项

- **无 Expo Router**: 用手动 `NavigationContainer` 而非文件路由，无 `app/` 目录
- **MessageBubble 非 Skia**: 实际用原生 RN View/Text，非 Skia Canvas 渲染
- **SkiaButton 已废弃**: 所有屏幕改用 `Button.tsx`（Pressable+Text，支持中文），`SkiaButton.tsx` 保留但无引用
- **RootStackParamList**: 集中定义在 `src/types/navigation.ts`，App.tsx 和各屏幕从此 import
- **secretTree 索引**: ts-mls 的 SecretTree 按树位置索引（0=leaf0, 1=parent, 2=leaf1），`getExpectedGeneration` 内部用 `leafIndex * 2`
- **群主不能离开**: MLS 禁止 removeMember 移除 committer，群主只能解散群组
- **群组只读状态**: dissolved/removed/left 标记后群组变为只读，保留消息但禁止发送
- **Web 长按缺失**: Web 无 `onLongPress`，每条文本/文件消息气泡旁固定一个 emoji 按钮（incoming 右下/outgoing 左下）触发 `EmojiPicker`；`EmojiPicker` 用 `measureInWindow` 取按钮坐标做锚定浮层，上方优先、空间不足转下方，左右 clamp 防溢出
- **Web 消息操作菜单**: Web 无 `onLongPress`，但气泡 `ref` 挂 `contextmenu` 事件监听器捕获右键，调用 `measureInWindow` 取坐标后弹出 `MessageActionMenu`；原生走 `onLongPress` 同一路径
- **UI 头像布局**: ChatListScreen 顶部栏头像右侧展示昵称+@handle；会话列表 1:1/群聊行左侧头像+昵称+时间+@handle+最近消息预览；ChatViewScreen 1:1/群聊 header 左上角展示头像+昵称+@handle + ⋮ 按钮（1:1 跳转私聊管理 `DmSettingsScreen`，群聊跳转群管理 `GroupSettingsScreen`；群聊为 `[Group] 群名` + `@creatorHandle`）
- **未读 badge**: 1:1 会话列表行 badge 浮在头像右上角（红底白边）；群聊行 badge 紧跟群名文字内联
- **文件发送**: 先保存本地副本（web->IndexedDB / native->documentDirectory）再上传；先写入 `uploadStatus:'uploading'` 乐观消息（tempId 为 `generateId()`），成功后删除临时消息写入最终消息（id=MLS queueId）。逐块 5MB AES-256-GCM 加密，经 XHR `uploadBlobWithProgress` 上传 PDS（字节级 uploadProgress；自带 Authorization + atproto-proxy header），blob 引用（标准 `{$type:'blob', ref:{$link}, mimeType, size}` 格式）与 MLS 加密的 file manifest 共存在同一条 `dme.queue.envelope`（单 record，PDS 可识别防 GC）。上传失败仅置 `uploadStatus:'failed'` 不抛异常，可 `retryUploadFileMessage` 从本地副本重试。图片 ≤ 5MB 自动下载，其他类型手动。下载时 blob fetch 失败指数退避重试 2s/4s/8s（最多 3 次）。无文件大小硬限制（>500MB 弹警告确认）
- **文件消息存储**: `StoredMessage.kind = 'file'`，`fileMeta` 字段含完整元数据（`FileMeta` 接口，含 `blobCids` + `uploadStatus`/`uploadProgress`/`downloadStatus`/`downloadProgress`）。`updateFileMessageMeta` 局部更新状态/进度/本地路径。发送方上传成功后 `downloadStatus:'ready'`+`uploadStatus:'uploaded'`，接收方初始 `downloadStatus:'pending'`；上传中消息 id 为临时 generateId，成功后替换为 queueId
- **文件本地存储**: 下载后写入本地：Native 以 base64 写入 `expo-file-system` documentDirectory（路径 `{msgId}_{sanitizedFileName}`），Web 写入 IndexedDB 并以 `indexeddb://{fileId}` 作为 localPath，组件渲染时通过 `useFileUri` 解析为 blob URL；发送方同样持久化，刷新页面后仍可显示
- **文件消息 reactions**: `FileMessageBubble` 支持 `reactions`/`onReactionPress`/`onOpenPicker`，和文本消息一样的 emoji 反应交互
- **视频预览**: 视频消息用 `expo-video` 播放，用 `expo-video-thumbnails`（native）或隐藏 `<video>`+`<canvas>`（web）生成首帧缩略图；`sendFileMessage`/`downloadFile`/`retryUploadFileMessage` 在本地文件就绪后为视频生成 `thumbnailPath`
  - 全屏播放器用 `expo-video` 的 `VideoView` + `useVideoPlayer`
  - Native 自动播放需 `player.muted = true`；iOS 上在 `statusChange` 监听到 `readyToPlay` 时再调一次 `player.play()`，解决首次进入未自动播放问题
  - Web/PWA 端绕过 `expo-video`，直接渲染原生 `<video muted playsInline autoplay controls>`，解决 iOS WebClip 进入后需二次点击的问题
  - web 缩略图生成需把隐藏 `<video>` 插入 DOM（`opacity:0` + 移出可视区 + 640x480），并显式 `video.load()`；不能依赖 detached video 的 `loadedmetadata`
  - 浏览器不支持的编码会有 duration 但 `videoWidth/videoHeight=0`，应回退提示下载，不转码
  - `expo-sharing` 无 web 支持，native 分享用 `react-native` 的 `Share`
  - `useFileUri` 返回的 blob URL 生命周期要小心，避免在 `expo-image` 加载前被 revoke
  - pending 视频只显示「下载」按钮，不显示 spinner + "Tap to download" 文案
- **聊天列表分页**: `ChatViewScreen` 使用 `inverted={true}` FlatList，数据 newest-first；进入时只加载最近 50 条，滑到顶部触发 `onEndReached` 加载更早 50 条；`chatListVersion` 变化时 merge 最近 N 条（N = max(50, 已加载数)），merge 时过滤 prev 中已不在 storage 最近窗口的消息（乐观上传消息被替换后自动移除），刷新 fileMeta/reactions/readAt 并 prepend 新消息
- **音频消息播放**: `FileMessageBubble` 音频卡片内置播放器--web 用 `HTMLAudioElement`、native 用 expo-av `Audio.Sound`（动态 import）；pending 点击触发下载、ready 后点击播放/暂停（▶/⏸）；`resolvedUri` 变化（如刷新后重新解析 IndexedDB）时释放旧音频对象并重置播放态；本地 URI 解析中播放按钮禁用+转圈
- **进度百分比**: 上传/下载均为字节级。上传走 XHR `upload.onprogress`（fetch 无上传进度）；下载走 `response.body.getReader()`，总量来自 `blobCids[].size`（不依赖 content-length）；进度只在整数百分比变化时写 storage + 递增 chatListVersion；进行中上限 99%，完成后清空
- **中断传输重置**: `restoreSession` 启动时把 `downloadStatus:'downloading'` 重置为 `'pending'`（清 downloadProgress）、`uploadStatus:'uploading'` 重置为 `'failed'`，避免刷新/杀进程后消息永远转圈
- **Web 上传数据源**: web 端上传/重试从 IndexedDB 读原始字节（`getCachedFileBytes(fileId)`），native 端从本地副本 `FileSystem.readAsStringAsync`（position/length 分段）；禁止用 document picker 的原始 fileUri 做上传数据源（刷新/重试后可能失效）
- **Web 部署 (Cloudflare Pages)**: `bun run build:web`（`expo export -p web && workbox generateSW workbox.config.js`，devDependency `workbox-cli`（bin `workbox`））产物 `dist/` 静态托管，含 `dist/sw.js`（预缓存 index.html/JS/canvaskit.wasm/字体/图标，离线可启动）+ `dist/manifest.json` + `dist/icons/`；`public/_headers` 注入 COOP/COEP（`Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp`，Skia CanvasKit WASM 必需）与长缓存 `Cache-Control: public, max-age=31536000, immutable`，并按路径拆分缓存：`/sw.js`、`/manifest.json` → `no-cache`，`/`、`/index.html` → `max-age=0, must-revalidate`（均用 `! Cache-Control` 摘除 `/*` 长缓存，**顺序敏感：`/*` 在前**）；SW 静默后台升级（skipWaiting+clientsClaim，无提示）；图标由 `python3 scripts/generate-brand-assets.py` 生成到 `public/icons/`（192/512/maskable/180/favicon）；`index.web.js` 用**同步 `require('./App')`**（延迟到 CanvasKit 就绪后执行），`LoadSkiaWeb({ locateFile: (file) => `/${file}` })` 用**绝对路径** `/`；禁止改回动态 `import('./App')`（会产生 async chunk，需 `@expo/metro-runtime` 的 `__loadBundleAsync`，而手写 `public/index.html` 不会注入该运行时，导致 `Requiring unknown module` 报错）
