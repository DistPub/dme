# fatesky 端变更需求：embed 模式文件字节托管（blob 存储）

> 配套 DME 端实现：`dme-client/src/embed/protocol.ts`、`src/embed/bridge.ts`、`src/utils/file-cache.ts`（已改完，待提交）。
> 本协议常量必须与 `dme-client/src/embed/protocol.ts` 中的 `DME_MSG` **逐字节一致**。

## 背景

在 fatesky 的 iframe 嵌入模式下，DME 聊天里的**文件字节（图片/语音/视频的实际二进制）目前会丢**，而**消息本体不会丢**。原因：

- 消息、身份、MLS 会话、`localPath` 指针等 KV 数据，已经通过 `STORAGE_*` 协议委托给 fatesky 的**第一方 localStorage**（`dme-storage:{did}`），可靠存活。
- 但文件字节走的是 DME iframe 自己 `indexedDB.open('dme-file-cache')`，**没有走任何托管通道**。第三方 iframe 的 IndexedDB 在 Safari ITP / 分区策略下会被清掉，于是：消息还在（fatesky 第一方），文件字节没了（iframe 第三方的 IndexedDB 被清）→ 发出/收到的图片变成"文件消息"、语音卡"下载中"。

**为什么不复用现有 `STORAGE_SET/GET` KV 通道？** 因为那条通道把数据存进 fatesky 的 **localStorage**（每个 DID 一个 JSON blob，上限约 5MB）。文件字节是二进制、可能很大（发送上限 500MB），base64 塞进去会：① 直接爆 5MB 配额；② 更糟的是会把消息本身挤掉（同一条 localStorage 记录）。所以文件字节必须走一个**独立的、IndexedDB 支撑的 blob 通道**。

**目标**：新增一组 blob 协议消息，让 DME 把文件字节委托给 fatesky 的**第一方 IndexedDB** 持久化，key 按 DID 隔离。这样文件字节和消息一样可靠存活。

## 新增协议消息（必须逐字节同步到 `social-app/src/lib/dme-embed/constants.ts`）

在 `DME_MSG` 对象里新增以下 4 个常量（字符串值必须与 DME 端完全一致）：

```ts
export const DME_MSG = {
  // ……原有所有条目保持不变……
  // 二进制文件字节托管（KV 的 STORAGE_* 通道装不下，且 localStorage ~5MB 会反噬消息）
  BLOB_SET: 'DME_BLOB_SET',     // DME → fatesky：持久化一个文件的字节
  BLOB_GET: 'DME_BLOB_GET',     // DME → fatesky：请求一个文件的字节
  BLOB_DATA: 'DME_BLOB_DATA',   // fatesky → DME：BLOB_GET 的响应
  BLOB_REMOVE: 'DME_BLOB_REMOVE', // DME → fatesky：删除一个文件的字节
} as const
```

`DME_EMBED_PROTOCOL = 'dme-embed/v1'` 不变。`EXPO_PUBLIC_DME_EMBED_ORIGIN` 等不变。

### 各消息 payload 约定

| 方向 | type | payload | 说明 |
|---|---|---|---|
| DME → fatesky | `DME_BLOB_SET` | `{ fileId: string, value: string, mimeType: string }` | `value` 是文件字节的 **base64** 字符串；`mimeType` 一并带上（DME 还原 blob 时要正确类型） |
| DME → fatesky | `DME_BLOB_GET` | `{ requestId: number, fileId: string }` | 拉取一个文件；`requestId` 用于异步响应关联 |
| fatesky → DME | `DME_BLOB_DATA` | `{ requestId: number, value: string \| null, mimeType: string }` | `value` 为 base64；**找不到时 `value` 为 `null`（或字段缺失）**，`mimeType` 可空串 |
| DME → fatesky | `DME_BLOB_REMOVE` | `{ fileId: string }` | 删除一个文件字节（清理用；调用时机由 fatesky 决定） |

> DME 端 `requestBlob()` 会自增 `requestId` 并 await `DME_BLOB_DATA`；fatesky 用同一个 `requestId` 回填。**必须保证 `requestId` 在响应中原样回传。**

## fatesky 端要实现的内容

### 1. 存储后端：per-DID 的 IndexedDB（不要用 localStorage）

新增 `src/lib/dme-embed/dmeBlobStorage.ts`（web-only，`IS_WEB` 守卫，native 全 no-op），把 blob 存进 fatesky 自己的**第一方 IndexedDB**（容量远大于 localStorage，且不被 ITP 当第三方清）：

- 建议库名 `dme-blob-storage`、object store `blobs`，**key 必须带 DID**（满足"key 要带 did"的要求），格式：
  `dme-blob:{did}:{fileId}`
- value 存 `{ value: string, mimeType: string }`（`value` = base64）。
- 提供的函数（签名建议）：
  - `setDmeBlob(did: string, fileId: string, value: string, mimeType: string): Promise<void>`
  - `getDmeBlob(did: string, fileId: string): Promise<{ value: string; mimeType: string } | null>`
  - `removeDmeBlob(did: string, fileId: string): Promise<void>`
  - （可选）`clearDmeBlobs(did: string): Promise<void>` —— 清理交给 fatesky，DME 不强制

> **DID 来源**：与现有 `STORAGE_*` 一致，**不要相信 payload 里的 did**，而是用 `optionsRef.current.getToken()?.did` 推断当前账号 DID（避免 token 与 payload did 不一致的边界）。即：`BLOB_SET/GET/REMOVE` 的 payload 只带 `fileId`（GET 还带 `requestId`），DID 由 fatesky 侧从 token 取得。

### 2. 桥接处理：`src/lib/dme-embed/useDmeEmbedBridge.ts`

在现有消息监听的 `switch (event.data.type)` 里新增分支（**已有的三条件锁——origin / source / protocol——对所有 inbound 消息统一生效，新类型自动被保护，无需额外加锁**）：

```ts
case DME_MSG.BLOB_SET: {
  const token = optionsRef.current.getToken()
  if (!token?.did) break
  const p = event.data.payload as { fileId?: unknown; value?: unknown; mimeType?: unknown } | null
  if (
    typeof p?.fileId === 'string' &&
    typeof p?.value === 'string' &&
    typeof p?.mimeType === 'string'
  ) {
    await setDmeBlob(token.did, p.fileId, p.value, p.mimeType)
  }
  break
}

case DME_MSG.BLOB_GET: {
  const token = optionsRef.current.getToken()
  if (!token?.did) break
  const p = event.data.payload as { requestId?: unknown; fileId?: unknown } | null
  if (typeof p?.requestId === 'number' && typeof p?.fileId === 'string') {
    const blob = await getDmeBlob(token.did, p.fileId)
    // 回传 DME_BLOB_DATA，requestId 原样返回
    sendToDme(DME_MSG.BLOB_DATA, {
      requestId: p.requestId,
      value: blob ? blob.value : null,
      mimeType: blob ? blob.mimeType : '',
    })
  }
  break
}

case DME_MSG.BLOB_REMOVE: {
  const token = optionsRef.current.getToken()
  if (!token?.did) break
  const p = event.data.payload as { fileId?: unknown } | null
  if (typeof p?.fileId === 'string') {
    await removeDmeBlob(token.did, p.fileId)
  }
  break
}
```

> `BLOB_GET` 是**异步往返**：DME 发 `BLOB_GET` 后挂起，等 fatesky 的 `BLOB_DATA`。`requestId` 关联即可（DME 端 `bridge.ts` 已有 `pendingBlobRequests` Map 做这件事）。**`BLOB_GET` 分支里的 `await` 没问题**——现有 `handleDmeReady` 等也是在同一监听器里做异步工作的。

## 验证要点（fatesky 同事自测）

1. 在 fatesky 内嵌 DME 里发一张小图 / 一段语音 → 关闭并重开 fatesky（或清掉 DME iframe 的 IndexedDB `dme-file-cache`）→ 重新打开会话：图片应直接预览、语音可播放，**不再出现"文件消息 / 下载中"**。
2. 跨账号切换（fatesky 多账号）：A 账号存的 blob 不能被 B 账号读到（per-DID 隔离）。
3. 大文件（如几十 MB 图片）也应能存（验证走的是 IndexedDB 而非 localStorage，不会爆 5MB 配额）。

## 备注

- DME 端在 embed 模式下**不再写 iframe 自己的 `dme-file-cache` IndexedDB**，改为：当前 tab 会话内保留一份内存副本（上传分片读取走内存，免去往返），并 fire-and-forget 把字节 `BLOB_SET` 给 fatesky；重载后从 fatesky 的 IndexedDB 经 `BLOB_GET` 拉回。
- 视频首帧缩略图也走同一套 `cacheFile` / `getCachedFileBytes`，因此会一并被托管，无需额外处理。
- 文件字节的清理策略（过期 / 上限 / 主动删除）**由 fatesky 负责**，DME 不干预；`DME_BLOB_REMOVE` 预留给需要时调用。
