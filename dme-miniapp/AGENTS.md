# AGENTS.md

- 输出或提示优先用中文。
- 开始回答前先说"帅哥是这样的"
- 详细实现计划见 `PLAN.md`（分阶段步骤 + 验收标准）。

---

# DME 小程序（dme-miniapp）

dme-client 的微信小程序移植版，**Taro 4 + React 18 + TypeScript**，编译目标 `weapp`。
功能对齐 dme-client 14 屏，唯一排除项：web 的 iframe embed 嵌入模式（见 §4 排除边界）。

## 1. 硬性约束

- **只允许在 `dme-miniapp/` 目录内创建 / 写入 / 编辑文件**。`dme-client/`、`dme-server/`、`dme-gateway/` 只读。
- 参照对象：`dme-client/`（Expo + React Native + react-native-web）。
- **不编写自动化测试 / QA 脚本**，由用户手工测试验收。
- 真机没有控制台，启动崩溃只表现为白屏 → 诊断设施（`components/ErrorBoundary.tsx` + `app.tsx` 的 `installGlobalErrorHandlers()`）**不要移除**。

## 2. 技术选型

| 项 | 选择 | 理由 |
|---|---|---|
| 框架 | Taro 4 + React 18，目标 `weapp` | 跨端复用 React 代码 |
| 加密栈 | ts-mls + @noble/curves/hashes/ciphers + @scure/base，全纯 JS | 小程序无 WebCrypto |
| 网络 | `Taro.request` 自写轻量 XRPC 客户端（`src/platform/http.ts`） | `@atproto/api` 依赖 fetch/URL/Headers |
| 二维码 | 渲染 weapp-qrcode / canvas 2d；扫码 `wx.scanCode` + jsqr 相册识别双路径 | |
| 存储 | 每会话单个 JSON 数组 key | wx.storage 单 key 1MB，`platform/storage` 的 setItem 带 900KB 预警 |

**依赖版本锁定**：@noble/hashes@1.8.0、@noble/curves@1.9.7、@noble/ciphers@1.3.0、@scure/base@1.2.6、ts-mls@1.6.2；**禁止升 noble 2.x**（import 路径漂移）。@hpke/*、@atproto/* 不进依赖（`@hpke/*` 在 `config/index.ts` stub 成 `false`）。

## 3. 加密栈硬性事实（已核实 node_modules 源码）

1. **CiphersuiteImpl 唯一来源是 `src/crypto/mls-noble-kdf.ts` 的 `getNobleMlsImpl()`**，五字段（hash/kdf/signature/hpke/rng）全部手工纯 JS 组装。
   ts-mls 的 `nobleCryptoProvider` / `defaultCryptoProvider` / `getCiphersuiteImpl()` 一律不可用——它们最终 `import { HkdfSha256 } from "@hpke/core"`（被 stub 成 `undefined`），`makeKdf()` 同步求值即抛 `undefined is not a constructor`，早于任何 spread 覆盖写法。`mls-config.ts` 的 `getMlsImpl()` 已删除，不要复活。
2. `src/crypto/hpke-noble.ts` 纯 JS 实现 RFC 9180 HPKE（DHKEM-X25519/HKDF-SHA256/AES-128-GCM），互操作必须与 web 端逐字节一致。
3. **random polyfill 只提供 `crypto.getRandomValues`，绝不能伪造 `crypto.subtle`**——ts-mls 检测到 subtle 会误走 WebCrypto 路径崩溃。签名用自写 `createNobleSignature()`，不做 subtle 探测，从根上免疫。
4. `wx.getRandomValues` 是异步 API，而 getRandomValues 是同步 → polyfill 用 64KB 预取缓冲池 + 同步兜底（`src/polyfills/random.ts`）。
5. Ed25519 依赖必须**静态 import**（`mls-noble-kdf.ts` 顶部 `import { ed25519 } from '@noble/curves/ed25519'`），禁止动态 import。

## 4. 与 dme-client 的对应关系

| miniapp 路径 | 来源 | 改动程度 |
|---|---|---|
| `src/protocol/**` `src/poll/**` `src/config.ts` | dme-client 同名 | 原样拷贝 |
| `src/crypto/**` | dme-client/src/crypto | 仅改 crypto.getRandomValues 引用 / import 路径 |
| `src/handshake/**` | dme-client/src/handshake | 逻辑复用；QR 渲染换 canvas 2d；`RichText.detectFacets` → 纯 JS `detectFacetsSubset`（UTF-8 字节偏移）；`qr-image-decode.ts` 为小程序新增（jsQR 相册识别） |
| `src/storage/db.ts` | dme-client | AsyncStorage → `platform/storage`；新增 `countUnread` |
| `src/i18n/**` | dme-client | 原样拷贝，丢 `embed.mismatch*` 两条 |
| `src/atproto/**` | dme-client | **重写**（走 platform/http）；`pds.ts` 有 `uploadBlob`（octet-stream 直传，**禁 wx.uploadFile**，它强制 multipart 且重写 Content-Type）/ `createRecord` / `resolveHandle` |
| `src/state/AppContext.tsx` | dme-client | 裁剪移植，剔除全部 embed 符号 |
| `src/ui` | dme-client/src/ui | → `src/components` + `src/pages`，Taro 组件 + SCSS 重写 |
| `src/utils/sound.ts` | dme-client/src/utils/sound.ts | 小程序重写：WAV 生成复用，播放改用 `Taro.createInnerAudioContext()`，并需用户手势解锁 |
| **（不移植）** | dme-client/src/embed/** | 唯一排除项 |

**embed 排除边界**（审计时不要误删/误移植）：

- 整目录不移植：`src/embed/protocol.ts`、`src/embed/bridge.ts` 及其全部符号。
- `ChatListScreen` 不带 `isEmbedContext()` 守卫——退出登录菜单项无条件显示。
- `session.ts` 不带 embed 构造参数 / `EmbedCredentialSession` / `setEmbedToken` 等；**logout 必须保留服务端 `session.logout()` 调用**。
- i18n 的 `embed.mismatchTitle/Body` 不移植。
- ⚠️ 三个易混项：① `embed/unread.ts` 的 `computeTotalUnread` 过滤式是**通用未读统计算法**，保留（落到 storage 层 `countUnread`），只丢 postMessage 上报；② `handshake/invite.ts` 的 `record.embed` 是 **Bluesky 帖子图片附件**（app.bsky.embed.images），不是嵌入模式，**别删**；③ `invite.ts` 的 `Platform.OS === 'web'` 是平台分支，非嵌入模式。

**加好友主流程必须原样复刻 web 的 Bluesky 邀请帖**（`handshake/invite.ts`：checkBobDmeStatus 三分支 → 帖子预览/编辑 → 发布带 QR PNG embed 的帖子 → trackInvitePendingWelcome）。小程序增强（`showShareImageMenu` 二维码直享 + `useShareAppMessage` 卡片转发、`wx.scanCode` 扫码）**不得替代** web 原路径：QrScan 必须保留"从相册选图识别"（jsqr）。全部差距见 `IMPROVEMENT-PLAN.md`。

## 5. 目录与分包

- 主包 6 页：login / setup / chat-list / settings / about / block-list
- 分包 `pkg-chat` 8 页：chat-view / qr-scan / qr-display / create-group / group-settings / dm-settings / image-viewer / video-viewer（加密栈体量大后置加载）
- 平台适配层 `src/platform/`：`storage.ts`（复刻 AsyncStorage）、`http.ts`（XRPC 客户端）、`clipboard.ts`、`recorder.ts`（按住说话：`getRecorderManager` 全局单例 + 模块级状态机，监听器只在首次获取时挂一次——重复 onStop 会累积回调）
- polyfills `src/polyfills/`：`random.ts`、`encoding.ts`（TextEncoder/TextDecoder/btoa/atob shim）

### 🔴 为什么必须有 `scripts/inject-polyfills.mjs`（全局占位）

`@noble/hashes/crypto.js` 在**模块求值那一刻**一次性绑定 `globalThis.crypto`。Taro 的 `app.js` 第一行 `require("./common"), require("./vendors"), ...` 使 vendors.js（noble）**早于** app.js 里的 `installPolyfills()` 求值 → noble 永久绑成 `undefined`。

解法：构建后在 app.js 顶部注入空 `crypto` / `TextEncoder` 等占位对象（占位位置必须早于第一个 require），真实实现挂到**同一个对象**上——noble 按引用取属性即可调到。两个配套约束：

1. 占位**绝不能定义 `crypto.subtle`**（见 §3.3）。
2. `encoding.ts` 判断占位不能用 `typeof g.TextEncoder === 'undefined'`（占位后它存在但为空），改判「原型上是否有 encode/decode 方法」。

## 6. 平台决策要点

### 6.1 XRPC：query 用 GET、procedure 用 POST，不能混

| 类型 | 方法 | 例子 |
|---|---|---|
| query | **GET** | getSession、resolveHandle、getProfile(s) |
| procedure | **POST** | createSession/refreshSession/deleteSession、createRecord/putRecord、uploadBlob |

工具函数：`xrpcGetJson(url, {headers})` / `xrpcPostJson(url, payload, {headers})`。用 POST 调 query 端点服务端直接 400，且容易被「非 401 视为网络问题」的兜底吞掉。

**procedure 还分两种**：带输入体（createRecord 等，走 `xrpcPostJson`）与**无输入体**（refreshSession / deleteSession）。无输入体端点 body 必须为空——传 `{}` 占位会被 PDS 拒绝：`400 InvalidRequest: A request body was provided when none was expected`。这类一律走 `xrpcPostEmpty()`（POST 不带 data、不设 Content-Type）。

### 6.2 鉴权失败判定：status 或响应体双判定

PDS 对过期 accessJwt 返回 **HTTP 400**（不是 401），响应体 `{"error":"ExpiredToken"}`：

| 语义 | 实际返回 | isExpiredToken | isUnauthorized |
|---|---|---|---|
| accessJwt 过期 | 400 + ExpiredToken | ✅ | ✅ |
| token 被吊销 | 400 + InvalidToken | ✗ | ✅ |
| 未带 Authorization | 400 + AuthMissing | ✗ | ✅ |
| 断网/超时/5xx | — | ✗ | ✗ → 保留会话 |

`isUnauthorized` 实现：`status === 401` 或 body/message 匹配 `/ExpiredToken|InvalidToken|AuthMissing|InvalidRequest.*token/i`。probe() 的 catch 顺序：先 `isExpiredToken`（可刷新）→ 再 `isUnauthorized`（重登）→ 最后才兜底保留会话。**400 + Token 字样一定是鉴权问题**，不能当网络问题吞掉。

### 6.3 网络域名

- 真机合法域名**只有 4 个**：PDS (`network.hukoubook.com`)、DME server (`dme.mymutual.fans`)、gateway (`e2ee.hukoubook.com`)、`plc.directory`。
- **资料获取必须经 PDS `appViewGet()`**（`{PDS}/xrpc/app.bsky.actor.*` + `atproto-proxy`），**禁止直连 `public.api.bsky.app`**（省白名单名额，dme-client 也从未用过）。
- **禁止请求 `https://{handle}/.well-known/atproto-did`**：handle 用户可控，域名不可枚举。
- PDS URL 解析用 `atproto/did.ts` 的 `resolvePdsUrl`；profile 缓存走 `atproto/profile-cache.ts`（24h TTL + 持久化 + 去重）。
- **登录页前端不再做 PDS 域名白名单校验**：合法域名校验是微信后台的功能，前端写死白名单只会给用户制造「我输对了但被前端拦下」的体验问题（2026-10-01 真机实测删除 `PDS_ALLOWLIST`）。
- **AT Protocol 无输入体 procedure 必须用 `xrpcPostEmpty`**：包括 `com.atproto.server.refreshSession` / `com.atproto.server.deleteSession` / `com.atproto.identity.requestPlcOperationSignature`。传 `{}`（Content-Length: 2）会被 PDS 拒绝为 `400 InvalidRequest: A request body was provided when none was expected`（2026-09-29 / 2026-10-01 多次真机踩坑）。

### 6.3.1 2FA 登录（authFactorToken）

登录页（`pages/login/index.tsx`）支持 AT Protocol 邮箱二步验证（`authFactorToken`），账号未开 2FA 时行为与之前完全一致：

- `DmeSession.login(identifier, password, storage?, pdsUrl?, authFactorToken?)` 透传到请求体。
- `isAuthFactorTokenRequired(err)` 识别响应体里的 `AuthFactorTokenRequired` 错误（正则匹配，匹配 status 或 message）。
- `AppContext.loginStep: 'idle' | 'loggingIn' | 'awaiting2FA'` + `loginFormSnapshot` + `cancel2FA()`：触发 2FA 时保存当前表单状态、切到验证码输入页；二次提交时携带 `authFactorToken`；`cancel2FA()` 回退到 idle。
- **验证码输入框不设 `maxlength`、不限定数字键盘**（`type="number"` / `number-pad`）——AT Protocol 2FA 验证码长度目前无统一标准，可能 6 位以上或非纯数字。
- 2FA 状态下 PDS / Handle / Password 输入框 `disabled` 置灰，主按钮文案切到 `login.verify`（验证并登录），提供 `login.backToPassword`（返回修改密码）按钮。

### 6.4 React 时序：核心引用一律「state + ref 双写」

`setState` 异步批处理，`await somethingThatSetsState()` 之后再读 useState 闭包变量**必拿旧值**（storage/pds/poller 等放进 Context 后尤其如此）。约定：

- `storageRef` / `identityKeysRef` / `sessionRef` / `pdsRef` / `pollerRef` 与 state 双写；写用 `putXxx()`（ref 同步生效 + state 触发渲染）；await 链里读 ref 或 `useApp()` 暴露的 `xxxSync` 只读镜像。
- **自查规则**：useCallback 里出现 `await ...; if (!someState) throw` 就是 bug，改读 `xxxRef.current`。
- logout/clearSession 清空时**必须连 ref 一起清**。`putXxx` 是 const useCallback 无函数提升，必须声明在所有使用它的 useCallback 之前。
- **hook 必须声明在所有条件提前 return 之前**：在 `if (loading) return ...` 这类提前 return 之后再放 useCallback/useEffect 会得到 `Minified React error #310`（2026-10-01 真机触发）。
- `clearSession()`（吊销 + 删本地 session key + 清内存，**保留** storage 与 identityKeys）用于「返回登录」；全量 logout 会连密钥删掉，重登后密钥比对不过。

### 6.5 幂等去重标记：消费成功之后才写，失败可回滚

poller 的 queueId 标记（LRU 1000）必须在 `onWelcome` / `decrypt` **成功后**才 `markQueueIdProcessed`；回调失败/提前 return 不标记。配套 `DmeStorage.unmarkQueueIdProcessed()` 回滚 + 不变量自愈：pendingWelcome 还在 ⇒ 这条 welcome 从未被成功消费（成功路径第一步就删 pending）⇒ 已有标记必是脏数据，撤销并重试。回调初始值不能是空函数（否则 poller 误以为成功），应为抛错。

### 6.6 登录后必进 Setup 校验密钥一致性

登录成功 / 恢复成功 → **一律 `reLaunch('/pages/setup/index')`**（不许直接进 chat-list——`bootstrapForDid` 会自动生成缺失密钥，`identityKeys` 永远非空，跳过 Setup 意味着「声明密钥到 DID 文档」整步被跳过）。Setup 校验：远端无 key → 引导声明；有 key → **逐字节比较**本地公钥 vs 远端公钥 → 一致放行 / 不一致进恢复模式（从备份恢复 or 重新声明覆盖）。本地密钥 ≠ DID 文档公钥时，群聊握手必炸 `aes/gcm: invalid ghash tag`。密钥是每设备独立的，任何新设备都必须「声明或恢复备份」二选一。

### 6.7 App Hide/Show 资源管理

任何「onHide 停、onShow 恢复」的资源（poller 等）：stop 和 resume 必须**成对出现在同一层**；stop 不得销毁 resume 所需状态（回调/参数）。poller 的 stop() 不清空回调，resume() 重启循环；`onAppShow → poller.resume()` 注册在 **AppContext Provider 层**（不是某个页面——热启动会恢复到任意页面）。

### 6.8 Taro API promisify 陷阱

- 存盘/分享类 API（saveImageToPhotosAlbum / saveVideoToPhotosAlbum / openDocument / shareFileMessage）**直接 await 时失败分支也可能 resolve** → 一律用显式 success/fail 回调包 Promise（chat-view 的 `wrapApi`），fail reject 且带 `e.errMsg`。
- reject 出来的多为普通对象 `{errMsg}`，`err instanceof Error` 为 false —— 错误判定前先归一化。
- 通用文件保存用 `Taro.shareFileMessage`（转发微信聊天后另存），不支持时回退 openDocument。
- 失败 toast 展示剥离前缀后的真实 errMsg。

### 6.9 chat-view 架构点

1. **倒序列表不用 inverted**：ScrollView 无 inverted → 「旧→新从上到下渲染 + `scrollIntoView` 锚点 + `onScrollToUpper` 加载更早」；`getMessagesPaginated` 返回新→旧，渲染前 reverse；加载旧消息时先把锚点定在当前最旧一条再 prepend。
2. **浮层定位一律用事件触点坐标，禁止 selectorQuery 量测**：MessageBubble/FileMessageBubble 编译为原生自定义组件，页面级 selectorQuery 查不到内部节点。click/longpress 事件的 `changedTouches[0].clientX/clientY`（视口坐标，与 position:fixed 同坐标系）经 `utils/screen.posFromEvent(e)` 上抛。ScrollView `scrollIntoView` 只认**页面作用域 id**，消息 id 需 `replace(/[^a-zA-Z0-9_-]/g, '_')` 净化。
3. **长按与系统文本选择互斥**：气泡文本必须 `-webkit-touch-callout: none; user-select: none;`（否则系统选择 UI 抢走 longpress）；复制走菜单的「复制」按钮。
4. **原生组件层级**：`<Textarea>` 层级最高会盖住浮层 → 浮层打开期间给 Textarea 挂 `style="visibility: hidden"`（保留布局、隐藏原生层）。
5. **消息 id 即路由参数**：`?conversationId=<DID|群ID>&isGroup=1`；chat-list 的 navigateToChat 必须显式带 isGroup；转发 → `chat-list?forwardText=<文本>`。

**输入条终版参数**（多轮真机迭代的定稿，勿改）：

- **焦点完全非受控**：不写 `focus` 属性，onFocus/onBlur 里不 setState。受控焦点会造成原生「聚焦↔失焦」乒乓死循环（onFocus setState → 重渲染写 focus → 原生重聚焦 → blur → ……），键盘永远弹不起来。
- **手动控高**：不用 autoHeight（官方文档明确 auto-height 时 height 失效，初始高度永远是 UA 默认两行）。`onLineChange` 读 lineCount，内联 `height = max(lineCount,1)*42 + 32` rpx（行高 42 + 上下 padding 32），上限 320rpx；发送清空时复位 1 行。scss `__input` 不写任何 height（class 压不过原生 UA 内联样式）。
- `showConfirmBar={false}`（关 iOS「完成」工具栏）、`holdKeyboard`（点发送不收键盘）、`maxlength={-1}`。
- **键盘顶起**：`adjustPosition={false}`（默认会把整个页面顶出视口）+ `onKeyboardHeightChange`（e.detail.height 是 **px**）→ 给**根容器 `.chatview`** 挂内联 `padding-bottom: ${kbHeight}px`（根容器 `box-sizing: border-box`，总高 100vh，flex:1 消息列表自动压缩，composer 落到键盘正上方）。**绝不能用 `transform: translateY` 平移 composer**——聚焦瞬间给 textarea 祖先挂 transform 会打断原生/同层 textarea 的 first responder，键盘弹起即收起。键盘高度是运行时 px，内联 style 的 px 不被 Taro 转 rpx，正好直接用。
- 发送后**不做**任何程序化重拉焦点。
- 🎤 语音模式：🎤/⌨️ 按钮切换，语音模式**卸载 Textarea**（原生组件销毁键盘自然收起，切回时重挂载，不碰 focus）；「按住说话」用 View + onTouchStart/Move/End/Cancel（Button 有原生 hover/active 态会抢触摸），触点坐标走 `utils/screen` 的 `touchOf(e: unknown)`——Taro 的 `BaseEventOrig` 类型不带 touches，`ITouchEvent` 直接当 prop 类型会报 TS2322。上滑 60px 进取消区；aac/16kHz/单声道/60s 上限（到时底层自动 onStop，recorder 层把结果暂存给松手的 stop 取）。

### 6.10 邀请帖 facet（detectFacetsSubset）

- mention：`/(^|\s|\()(@)([a-zA-Z0-9.-]+)(\b)/` + isValidDomain；调用时**必须传 `resolveHandle`**，解析失败丢弃该 facet（官方保留 `did:''`，但会触发 PDS lexicon 校验失败整帖发不出）。
- tag：`(^|\s)[#＃]` 开头，修剪流程：trim → 剥尾标点 → 空/>64 丢弃 → 至少含一个非数字非标点字符（`#123` `#!!!` 不产出）；**保留原样不 toLowerCase**。
- `byteStart/byteEnd` 是 **UTF-8 字节偏移**（中文/emoji 必须换算，`utf8ByteRanges`）。
- 不用官方 `\p{P}` 正则（es5ify 降级不确定），用「正则粗扫 + 手工修剪」等价实现（标点用显式集合近似）。

### 6.11 重 JS 计算前的 loading：先 showLoading 再 await

PBKDF2、AES-GCM、大对象 JSON 序列化等**纯 JS 同步计算**嵌在 async 函数里时，如果前面只有微任务级联（storage 读取、状态更新），React 的 setState 没有机会渲染到原生层，用户会感觉「点按钮直接卡死」。

修复：调用这类函数之前先 `await Taro.showLoading({ title: ..., mask: true })`。
- 原生 loading 在 JS 线程阻塞期间仍然显示；
- `mask: true` 让原生层拦截触摸，同时防连点；
- 记得 `finally { Taro.hideLoading(); }`。

已按此修复：chat-list「退出并备份」、settings「身份备份」。

### 6.12 canvas 尺寸：显示 rpx、绘制 px、CSS 不碰尺寸

`<Canvas type="2d">` 无固有宽高比：

| 量 | 用途 | 单位 | 写在哪 |
|---|---|---|---|
| 显示尺寸 | 屏幕上多大 | **rpx** | 只在 JSX 内联 style，宽高同值 |
| 绘制分辨率 | canvas.width/height | **px** | effect 里设，宽高同值 |

scss 里给 canvas 写任何 width/height 都会覆盖内联产生变形；`max-width`/`height:auto` 兜底对 canvas 不成立。⚠️ Taro SCSS 编译器会把 scss 里的 `px` 转 rpx，但 **JSX 内联 style 的 px 不转换**——内联一律写 rpx。

### 6.13 消息提示音

小程序端提示音实现与触发规则：

- **实现**：`src/utils/sound.ts`。
  - WAV 数据与 dme-client 完全一致（880Hz 三声），运行时生成 base64；
  - 播放端用 `Taro.createInnerAudioContext()`；
  - WAV 先通过 `Taro.getFileSystemManager().writeFileSync` 写到 `Taro.env.USER_DATA_PATH/dme_beep.wav`，再用**本地文件路径**作为 `src`（data URI 在真机播放不稳定）。
- **解锁**：微信小程序要求音频在**用户手势后**才能自动播放。`chat-list` 会话行 `onClick` 时调用 `unlockMiniappAudio()`，播放一段极短/极轻的同一音频完成解锁。用户首次点击会话行之前收到的消息不会响。
- **触发逻辑**（`AppContext.handleIncomingMessage`）：
  - `soundEnabled` 采用 **state + ref 双写**（handleIncomingMessage deps 为 `[]`，只能读 ref）；
  - 收到 `kind: 'text'` / `'group_invite'` / `'file'` 消息时，若开关打开且满足以下场景则调用 `playMessageSound()`：
    - 当前不在任何聊天页面（`activeConversationRef.current === null`）→ 响；
    - 在当前会话的聊天页面（`activeConversationRef.current === msg.groupId`）→ 响；
    - 在别的会话页面 → 不响；
  - `group_system` / `reaction` 不触发提示音。
- **调试**：真机排查时过滤 `[dme:sound]` 日志，应能看到 `unlockMiniappAudio` → `提示音文件已写入` → `onCanplay` → `onPlay` → 新消息时 `playMessageSound` → `play onCanplay` → `play onPlay`。

## 7. 构建管线

```
taro build → es5ify.mjs（ES5 降级）→ verifyNoModernSyntax()
           → strip-hpke-dead-code.mjs → verifyCryptoWiring() → inject-polyfills.mjs
```

顺序不可换；全部由 `scripts/deploy.mjs build` 串联，**不要手动动 `dist/`**（Taro 的 emptyOutputDir 自己清；构建中另起进程会目录竞争，表现为构建卡死/app.json 消失）。

- **ES5 降级是硬要求**：Taro babel 只转 `src/`，node_modules 的 @noble/*、ts-mls 以 ESM/ES2020 分发会原样进 vendors.js，微信 CI 上传严格校验拒收 `?.` / `??`（-80057）。`project.config.json` 的 `setting.es6: false` 对 CI 上传**无效**。
- 🔴 **`**` 绝不能降级成 `Math.pow`**：@noble/curves 的 Ed25519 常量含 BigInt 幂运算，`Math.pow` 传 BigInt 在小程序 native 层直接抛异常、模块顶层执行、启动白屏。es5ify 已 `exclude: ['@babel/plugin-transform-exponentiation-operator']`，deploy.mjs 的 `Math.pow(x, BigInt(...))` 检测**不要删**。`libVersion 3.3.4` 完全支持 BigInt 与 `**`。
- **降级最小干预**：只处理真正含 ES2020 语法的文件（通常只有 vendors.js）。babel 重写 app.js 会注入 helpers 打乱 require 求值顺序（polyfill 必须早于 vendors.js 加载）→ 启动白屏。判别：`head -c 60 dist/app.js` 应以 `/*! For license ... */ require("./common")` 开头。
- **strip-hpke-dead-code.mjs**：ts-mls 主入口静态 re-export 两个 provider（CJS 无法 tree-shake），按符号定名精确剔除（`n.d()` 条目 + makeKdf/Aead/DhKem/Hpke 工厂函数体 + `@hpke/core` 命名空间绑定）。
- **产物大小基线**：`dist/vendors.js` 正常约 **281KB**（ES5 降级会变大）；看到 176KB 说明 es5ify/strip 未生效，直接上传真机白屏。整包上限 2MB；logo.png 用 192px + 64 色 quantize（约 3.4KB）。
- **babel 报 `Cannot find module '@babel/preset-react'`** → `npm i -D @babel/preset-react @babel/preset-env @babel/preset-typescript`。

### 构建卡死/报错的两种情形

| 情形 | 特征 | 处置 |
|---|---|---|
| 目录竞争（§7 开头） | `ps` 见多个 taro/deploy 进程 | `pkill -9 -f "taro build"; pkill -9 -f "deploy.mjs"` → 确认 0 进程 → 只跑一次 build |
| safe-delete shim 拦截/拖慢 | 单进程但 20~40 分钟无输出，或秒退报 `SAFE_DELETE_BULK_CONFIRM_REQUIRED` / `CODEBUDDY_SESSION_ID is not set` | WorkBuddy 沙箱装了两层要求相反的 shim，唯一正确解：`CODEBUDDY_SAFE_DELETE_ENABLED=0` 一并关掉两层 |

日志用 `cmd > log 2>&1`（管道会缓冲到结束才吐，加剧误判）。

### CI 上传

- 校验来源公网 IPv4，**关后台开关无效**，必须显式加 IP 白名单；IPv6 出口的机器强制 `NODE_OPTIONS="--dns-result-order=ipv4first"`。
- 上传用 `deploy.mjs upload --skip-build` 复用已验证产物。

## 8. 常用命令

> ⚠️ 本机（WorkBuddy 沙箱）跑构建/上传必须带 `CODEBUDDY_SAFE_DELETE_ENABLED=0`；无 shim 的普通终端不需要。

```bash
cd dme-miniapp
npm install
npm run dev:weapp                          # 开发（微信开发者工具打开 dist/）
CODEBUDDY_SAFE_DELETE_ENABLED=0 node scripts/deploy.mjs build     # 生产构建（含降级+自检+注入）
CODEBUDDY_SAFE_DELETE_ENABLED=0 node scripts/verify-artifact.mjs  # 产物冒烟：无 WebCrypto 沙箱跑通 getNobleMlsImpl()
CODEBUDDY_SAFE_DELETE_ENABLED=0 NODE_OPTIONS="--dns-result-order=ipv4first" \
  node scripts/deploy.mjs upload --skip-build \
  --key ./private.wxf49aa367bc096969.key --version 0.0.x --desc "..."   # CI 上传
npx tsc --noEmit                           # 类型检查
```

> `npm run build:weapp` 是 Taro 原生构建，**不含** ES5 降级与占位注入，直接上传会被 CI 拒。上传务必走 `deploy.mjs build + upload`。

## 9. 交付前自检清单

```bash
# ⚠️ 必须加 dist/vendors.js：@hpke 类只在 vendors chunk，`dist/*.js` 会漏
grep -o "HkdfSha256\|HkdfSha384\|HkdfSha512" dist/vendors.js | wc -l   # 0（@hpke 类）
grep -o "\.Aes128Gcm\|\.Aes256Gcm\|\.Dhkem" dist/vendors.js | wc -l   # 0（@hpke 成员访问）
grep -o "Optional dependency"               dist/*.js | wc -l         # 0（@hpke 死分支文案）
grep -o "?\." dist/*.js | wc -l                                       # 0（CI 拒收 ES2020）
grep -o "??"  dist/*.js | wc -l                                       # 0
grep -oE "Math\.pow\([^)]*,[[:space:]]*(BigInt\(|[0-9]+n)" dist/*.js | wc -l  # 0（真机白屏）
grep -o "crypto\.subtle[[:space:]]*=" dist/*.js | wc -l                       # 0
head -c 60 dist/app.js                                # 必须以 /*! For license ... */ require("./common") 开头
node scripts/verify-artifact.mjs                      # 🎉 全部通过

# 改了 canvas / 二维码页面时额外过：
grep -o "qr__canvas{[^}]*}" dist/pages/pkg-chat/qr-display/index.wxss  # 无 width/height
grep -o "560px" dist/pages/pkg-chat/qr-display/index.js | wc -l        # 0（内联尺寸别用 px）
```

> ℹ️ `HKDF-SHA256` / `DHKEM-X25519-HKDF-SHA256` 等**字符串**可出现在产物——是 ts-mls cipher-suite 元数据表的键（name↔id 映射），不 new 任何类。只有 `HkdfSha256`（类名）与 `.HkdfSha256`（成员访问）才是崩溃信号。

## 10. 其他

- `verify-artifact.mjs` 依赖 `mls-noble-kdf.ts` 末尾挂在 `globalThis.__dmeTestGetNobleMlsImpl` 的钩子（小程序运行时不读取，无副作用），**不要删**。脚本尾部的 `[dme:storage]` 警告是沙箱没有 wx API 的预期噪音。
- LogoSpinner 自带全屏 fixed 定位（inset:0 + flex 居中 + 白底 + z-index 9999），所有过渡页直接用，调用方不要再套居中容器；setup 的 checking/done 态 early-return 纯启动屏。
- 图片压缩 venv：`~/.workbuddy/binaries/python/envs/default`（Pillow）。
