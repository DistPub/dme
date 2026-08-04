# AGENTS.md

- 输出或提示优先用中文。
- 开始回答前先说"帅哥是这样的"

---

# dme-server

Go AppView 服务。消费 Jetstream 事件存入 BadgerDB（7 天 TTL），暴露批量盲查 HTTP 端点。6 个 Go 文件，2 个直接依赖。

## 结构

```
dme-server/
├── main.go                          # 入口：flag 解析 + goroutine 编排 + 优雅关闭
├── go.mod                           # module dme/dme-server, go 1.22
└── internal/
    ├── config/config.go             # --addr --db --jetstream flag 解析
    ├── server/server.go             # HTTP ServeMux + CORS（2 端点）
    ├── store/
    │   ├── store.go                 # BadgerDB CRUD + TTL + GC 循环
    │   └── errors.go                # ErrNotFound 哨兵
    └── jetstream/consumer.go        # WebSocket JSON 消费 + 指数退避重连
```

## 快速定位

| 任务 | 位置 |
|---|---|
| 加 HTTP 端点 | `internal/server/server.go` `Handler()` |
| 改存储 TTL | `internal/store/store.go` `EnvelopeTTL` 常量 |
| 改 Envelope struct | `internal/store/store.go` `Envelope` + `internal/jetstream/consumer.go` `envelopeRecord`（含 `BlobCids []string`） |
| 改 GC 策略 | `internal/store/store.go` `gcThreshold` / `gcInterval` |
| 改 Jetstream 过滤 | `internal/jetstream/consumer.go` `processEvent()` |
| 改重连退避 | `internal/jetstream/consumer.go` `Start()` backoff 数组 |
| 加命令行 flag | `internal/config/config.go` `FromFlags()` |

## HTTP 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/_health` | `{"status":"ok"}` |
| POST | `/xrpc/dme.batch.get` | 批量盲查 |
| OPTIONS | * | CORS preflight -> 204 |

**POST /xrpc/dme.batch.get**:
- 请求: `{"queueIds": ["hex...", ...]}`
- 响应: `{"envelopes": [{queueId, payload, createdAt, ratchetEpoch?, blobCids?}]}`
- 过期/不存在 queueId 静默跳过，空结果返回 `[]` 非 `null`
- `blobCids` 字段可选，仅文件 envelope record 携带（Go JSON 自动 marshal/unmarshal，零业务逻辑）
- CORS 全开（`Access-Control-Allow-Origin: *`）

## 关键参数

| 参数 | 值 | 位置 |
|---|---|---|
| EnvelopeTTL | 7 天 (168h) | store.go |
| valueLogFileSize | 64 MiB | store.go |
| gcThreshold | 0.5 (50% 脏数据触发) | store.go |
| gcInterval | 10 分钟 | store.go |
| 重连退避 | 5s -> 10s -> 20s -> 40s -> 60s（封顶） | consumer.go |
| WebSocket 读限制 | 4 MiB | consumer.go |
| HTTP 超时 | Read 10s / Write 10s / Idle 60s | main.go |

默认值: `--addr :8080`, `--db ./dme.db`, `--jetstream wss://jetstream1.us-east.bsky.network`

## 约定

- **错误处理**: `fmt.Errorf("context: %w", err)` 包装链；哨兵 `ErrNotFound`
- **日志**: `log/slog` JSON 到 stdout，三级（Info/Warn/Debug），`log.With("component", "...")` 上下文
- **接口最小化**: `jetstream.Storer` 只声明 `Put()` 方法
- **配置模式**: `Default()` 返回默认 -> `FromFlags()` 覆盖 -> `String()` 日志
- **优雅关闭**: `signal.NotifyContext(SIGINT, SIGTERM)` -> `httpServer.Shutdown(10s)` -> `defer srv.Close()`
- **无 cursor**: Jetstream 消费者启动从最新事件开始消费，不回溯历史（刻意设计，消息有 7 天 TTL 兜底）
