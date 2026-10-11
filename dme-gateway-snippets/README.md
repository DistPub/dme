# dme-gateway-snippets

DME 网关的 **Cloudflare Snippets** 版本，是 `dme-gateway`（Worker 版）的移植。原 Worker 代码保持不动，生产可二选一部署。

职责与 Worker 版一致：反向代理，剥离客户端标识，dme-server 只看到 CF 边缘 IP。

## 架构原则

**Snippet 只做请求前的改写与转发，改完立刻 `return fetch(...)`**，不做任何响应包装：

- 不读上游响应 body、不 `arrayBuffer()` 拷贝、不 `clone()`、不重建 Response —— 响应流式透传
- 不在 snippet 里写 CORS 头、不做缓存、不设 Cache-Control
- CPU 开销只有 URL 字符串拼接（微秒级），远低于 Snippets 5ms/请求 限制；大 blob 零拷贝

响应侧全部交给 CF 原生规则：

| 事项 | 处理方式 | 配置位置 |
|---|---|---|
| CORS 响应头 | Response Header Transform Rules 统一加（含 snippet 返回的 204/200/透传响应） | Rules → Transform Rules → Response Header |
| blob 边缘缓存 | Cache Rules 对 `/xrpc/dme.file.blob` 设 Edge TTL（如 7 天） | Rules → Cache Rules |
| OPTIONS 预检 | snippet 内直接返回 204 空响应（构造空响应不费时间） | 代码内两行 |
| 健康检查 | snippet 内直接返回 `ok` | 代码内两行 |

## 相比 Worker 版的差异（Snippets 平台限制）

| 能力 | Worker 版 | Snippets 版处理方式 |
|---|---|---|
| env 绑定（`DME_SERVER_URL`） | `env.DME_SERVER_URL` | 不支持 env，硬编码在 `snippet.js` 顶部 `DME_SERVER_URL` 常量 |
| `dme-server` 请求头动态覆盖 | 保留 | 保留（header 合法性校验逻辑不变） |
| `caches.default` 手动缓存 blob | `cache.match/put` + `ctx.waitUntil` | 不支持 Cache API；删掉，改由 Cache Rules 的 Edge TTL 实现 |
| `ctx.waitUntil` | 有 | 不支持，已不需要 |
| 15s 上游超时（AbortController） | 有 | 移除（上游超时交给 CF 平台的 subrequest 限制） |
| CORS 头 / 404 兜底包装 | 代码内拼 CORS_HEADERS | 改由 Response Header Transform Rules 统一加 |
| 剥离客户端标识 header | 只带 `Content-Type` 转发 | 保持一致：新 Request 只显式带 `Content-Type`，不继承原请求 headers |

Snippets 平台限制提醒：CPU 5ms/请求、代码 5MB、无 KV/R2/D1/secret 绑定、无 timers —— 本版本已全部规避。

## 部署

Snippets 不走 `wrangler deploy`，在 Cloudflare Dashboard 配置：

### 1. 创建 Snippet

进入域名 → **Rules → Snippets → Create Snippet**，粘贴 `snippet.js` 全文，把顶部 `DME_SERVER_URL` 改为实际地址（如 `https://dme.example.com`）。

匹配表达式（只覆盖需要的路径）：

```
(http.request.uri.path in {"/xrpc/dme.file.blob" "/xrpc/dme.batch.get" "/_health"}) or (http.request.method eq "OPTIONS")
```

### 2. CORS：Response Header Transform Rule

Rules → Transform Rules → Response Header → Set static headers（作用于全 zone 或相同路径范围）：

| Header | Value |
|---|---|
| `Access-Control-Allow-Origin` | `*` |
| `Access-Control-Allow-Methods` | `GET, POST, OPTIONS` |
| `Access-Control-Allow-Headers` | `Content-Type, dme-server, Authorization` |
| `Access-Control-Max-Age` | `86400` |

该规则对 snippet 返回的所有响应生效（包括 204 预检响应）。

### 3. 缓存：Cache Rule

对 `http.request.uri.path eq "/xrpc/dme.file.blob"`：Eligible for cache → Set Edge TTL（如 7 天）。

## 验证

```sh
curl -i -X OPTIONS https://<your-domain>/xrpc/dme.batch.get        # 204 + CORS 头
curl https://<your-domain>/_health                                 # ok
curl -X POST https://<your-domain>/xrpc/dme.batch.get \
  -H 'Content-Type: application/json' -d '...'
curl -i 'https://<your-domain>/xrpc/dme.file.blob?pds=https://shimeji.us-east.host.bsky.network&did=did:plc:xxx&cid=bafk...'  # 二次请求命中缓存 cf-cache-status: HIT
```
