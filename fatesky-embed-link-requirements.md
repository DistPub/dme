# fatesky 需求文档：DME 消息链接跳转（DME_NAVIGATE / DME_OPEN_URL）

- 日期：2026-10-09
- 关联仓库：dme-client（DME 侧，本需求只描述 fatesky 需配合的改动）
- 关联模块：fatesky `src/lib/dme-embed/`（constants.ts / 消息分发处）

---

## 1. 背景

DME web 端文字消息将支持 URL 链接：链接文本加下划线渲染，点击后按平台分流打开。其中两类点击行为发生在 fatesky 侧，需要 fatesky 通过嵌入 postMessage 协议配合：

1. 消息里的链接指向 **fatesky 站内页面**（host = `app.hukoubook.com`）且 DME 处于**嵌入模式**时，点击不应开新窗口，而是让 fatesky 自身 SPA 路由跳转到该链接的 path（等同用户在 fatesky 内点了站内链接）。
2. iOS web（WKWebView 环境）下点击**外部链接**时，iframe 内 `window.open` 无法拉起新的浏览上下文，需要 fatesky 代为**拉起网页视图**展示该 URL。

DME 侧负责：链接识别、渲染、点击分流、按条件发送下述 postMessage。fatesky 侧负责：接收并处理这两条新消息。

---

## 2. 协议变更

`dme-client/src/embed/protocol.ts` 的 `DME_MSG` 新增 2 个消息。**fatesky 的 `src/lib/dme-embed/constants.ts` 必须同步新增，byte-for-byte 一致**（协议版本仍为 `dme-embed/v1`，不变）：

| 消息名 | 方向 | payload | 语义 |
|---|---|---|---|
| `DME_NAVIGATE` | DME → fatesky | `{ path: string }` | 请求 fatesky 将自身 SPA 路由跳转到 `path` |
| `DME_OPEN_URL` | DME → fatesky | `{ url: string }` | 请求 fatesky 拉起网页视图打开外部 `url` |

消息信封格式与现有协议一致：

```json
{ "protocol": "dme-embed/v1", "type": "DME_NAVIGATE", "payload": { "path": "/profile/xxx" } }
{ "protocol": "dme-embed/v1", "type": "DME_OPEN_URL", "payload": { "url": "https://example.com/page" } }
```

---

## 3. DME 侧触发条件（fatesky 可据此理解消息来源）

- `DME_NAVIGATE`：仅在 DME 处于嵌入模式（iframe 内）且被点击链接的 host **精确等于** `app.hukoubook.com` 时发送。`path` 为该链接的 `pathname + search + hash`（如 `/profile/xxx?tab=1#top`），**不含 origin**。
- `DME_OPEN_URL`：仅在 iOS web（iPhone Safari / iPadOS Safari / fatesky iOS 客户端的 WKWebView）+ 嵌入模式下，点击非 fatesky 外链时发送。PC 端与 iOS 独立访问（非嵌入）时 DME 直接 `window.open`，**不会**发送此消息。

---

## 4. fatesky 侧需求

### 4.1 常量同步（必须）

`src/lib/dme-embed/constants.ts` 的消息名映射新增：

```ts
NAVIGATE: 'DME_NAVIGATE',
OPEN_URL: 'DME_OPEN_URL',
```

### 4.2 DME_NAVIGATE 处理（必须）

收到 `{ type: DME_NAVIGATE, payload: { path } }` 后：

1. 校验 `payload.path` 为字符串、以 `/` 开头、不含 `//` 协议相对跳转特征与外域（防注入，见 4.4）。
2. 调用 fatesky 自身路由的编程式跳转（如 react-router 的 `navigate(path)`），**SPA 内部跳转，不整页刷新、不开新窗口**。
3. 若 DME iframe 当前 `display:none`（用户不在 /messages 页）消息仍应生效——用户点击行为发生在 iframe 可见时，但时序上以收到消息为准，无需额外门控。

### 4.3 DME_OPEN_URL 处理（必须）

收到 `{ type: DME_OPEN_URL, payload: { url } }` 后：

1. 校验 `url` 为 `http:` / `https:` 绝对地址（见 4.4）。
2. 拉起网页视图展示该 URL，实现方式由 fatesky 自行选择，参考：
   - fatesky iOS 客户端（WKWebView 环境）：present `SFSafariViewController` 或新 `WKWebView` 页面；
   - fatesky 纯 web 环境（iOS Safari 直接访问）：可降级为 `window.open(url, '_blank')` 新标签，或站内通用的外链浏览层。
3. 该消息目前只会从 iOS 环境发来；桌面端收到时按通用外链打开逻辑处理即可，无需特殊适配。

### 4.4 安全校验（必须）

- 仅接受来自 DME iframe 的消息：校验 `event.origin` 属于 DME 部署域、`event.source === iframe.contentWindow`，与现有 TOKEN/STORAGE 消息同级别校验。
- `DME_NAVIGATE.path`：必须以 `/` 开头；拒绝包含 `//`（防 `//evil.com` 协议相对跳转）、`\\`、以及解析后 host 非空的值；只做站内路由跳转。
- `DME_OPEN_URL.url`：仅允许 `http:` / `https:` 协议；拒绝 `javascript:` 等伪协议（DME 侧已做同样过滤，双保险）。

### 4.5 不改动项

- 现有 `DME_READY` / `DME_TOKEN` / `DME_SESSION_INVALID` / `DME_UNREAD` / `DME_CHAT_ACTIVE` / `DME_PING` / `DME_STORAGE_*` 全部行为不变。
- DME 非 embed（standalone web / native）场景不发送这两条消息，fatesky 无感知。

---

## 5. 验收标准

| # | 场景 | 预期 |
|---|---|---|
| 1 | fatesky web（PC）内嵌 DME，点击消息中 `https://app.hukoubook.com/profile/abc` | fatesky SPA 跳转到 `/profile/abc`，无新窗口、无整页刷新 |
| 2 | 同上，点击消息中外部链接（如 `https://example.com`） | 新标签打开（DME 自行 window.open，fatesky 无需处理） |
| 3 | fatesky iOS 客户端内嵌 DME web，点击消息中 fatesky 链接 | 同场景 1 |
| 4 | fatesky iOS 客户端内嵌 DME web，点击消息中外部链接 | fatesky 拉起网页视图（SFSafariViewController / WKWebView）展示该 URL |
| 5 | 恶意 payload：`path: "//evil.com"` 或 `url: "javascript:alert(1)"` | 被 fatesky 校验拒绝，无跳转、无脚本执行 |
| 6 | 非嵌入环境访问 DME web | DME 不发送两条新消息，行为与旧版一致 |

---

## 6. 联调注意

- 两端常量必须同版本上线：fatesky 未上线 handler 前，DME 侧点击 fatesky 链接 / iOS 外链将无响应（postMessage 被忽略），不影响其他功能。
- DME 侧 `console.log` 会输出 `[DME embed]` 前缀日志，联调时可在 fatesky 侧 handler 入口加同样风格日志对齐时序。
