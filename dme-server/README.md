# dme-server

DME AppView — 订阅 Relay firehose 消费 `dme.queue.envelope` 记录，建 BadgerDB KV 索引（7 天 TTL），提供批量盲查端点供 OHTTP gateway 调用。

## 架构

```
Bluesky PDS (Alice) ──> Relay firehose ──> dme-server (AppView)
                                            │
                                     ┌──────┴──────┐
                                     │  BadgerDB   │  7-day TTL
                                     │  KV index   │  (native GC)
                                     └──────┬──────┘
                                            │
                            POST /xrpc/dme.batch.get
                                            │
                                   OHTTP Gateway ──> Client
```

dme-server **不**接受 `createRecord`（记录写入由 Alice 的 Bluesky PDS 负责），**不**生产 firehose 事件（只消费）。

## 功能

- 订阅 Relay firehose（`wss://bsky.network/xrpc/com.atproto.sync.subscribeRepos`）
- 过滤 `#commit` 事件中的 `dme.queue.envelope` 记录
- CAR 文件解析，提取加密包裹
- BadgerDB KV 存储（QueueID → ciphertext），原生 7 天 TTL
- 值日志 GC（64 MiB 文件 + 后台 `RunValueLogGC(0.5)`）
- `dme.batch.get` 批量盲查端点
- 断线自动重连（指数退避 5s → 10s → 20s → 40s → 60s cap）
- 游标（seq）断点续传

## 开发

```bash
go run main.go --addr :8080 --db ./dme.db --relay wss://bsky.network
```

### 参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `--addr` | `:8080` | HTTP 监听地址 |
| `--db` | `./dme.db` | BadgerDB 数据目录 |
| `--relay` | `wss://bsky.network` | Relay firehose WebSocket 地址 |

## API

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/xrpc/dme.batch.get` | 批量查询（OHTTP 轮询用） |
| GET | `/_health` | 健康检查 |

### `POST /xrpc/dme.batch.get`

请求：

```json
{
  "queueIds": ["a1b2c3...", "d4e5f6..."]
}
```

响应：

```json
{
  "envelopes": [
    {
      "queueId": "a1b2c3...",
      "payload": "<base64url ciphertext>",
      "createdAt": "2025-01-01T00:00:00Z",
      "ratchetEpoch": 3
    }
  ]
}
```

已过期或不存在的 queueId 静默跳过（不返回、不报错）。

## 模块结构

```
dme-server/
├── main.go                          # 入口：启动 HTTP server + firehose consumer
├── internal/
│   ├── config/config.go             # 配置（addr, db, relay, TTL）
│   ├── server/server.go             # chi 路由 + batchGet/health 处理
│   ├── store/
│   │   ├── store.go                 # BadgerDB 存储 + 原生 TTL + GC
│   │   └── errors.go                # ErrNotFound
│   └── firehose/
│       ├── consumer.go              # WebSocket 客户端 + 自动重连
│       ├── parser.go                # CBOR 帧解码 + CAR 文件解析
│       └── filter.go                # dme.queue.envelope 过滤
└── go.mod
```
