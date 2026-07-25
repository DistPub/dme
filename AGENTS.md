# AGENTS.md

- 输出和提示优先用中文。
- 输出前先说：帅哥是这样的

---

# DME (Decentralized Message Envelope) 项目文档

## 概述

DME 是基于 AT Protocol（Bluesky）的端到端加密私信系统。用户通过 Bluesky 账号登录，在 DID 文档中声明 X25519 加密公钥，通过 QR 码握手建立 Double Ratchet 加密会话，加密消息以 `dme.queue.envelope` 记录写入 Bluesky PDS，经 Jetstream 被 DME server 消费索引，客户端通过轮询盲查获取消息。

## 三个系统

```
dme/
├── dme-client/     Expo + React Native Skia 移动 App（iOS/Android/Web）
├── dme-server/     Go 服务 - AppView，订阅 Jetstream + BadgerDB KV 暂存 + 批量盲查
└── dme-gateway/    Cloudflare Worker - 反向代理，剥离客户端 IP
```

三个系统完全独立，无共享配置，无 workspace。各自独立构建部署。

### 数据流

```
Alice 发消息:
  Client encrypt -> PDS createRecord -> Jetstream -> dme-server 存入 BadgerDB (7天TTL)

Bob 收消息:
  Client 轮询 -> gateway (剥离IP) -> dme-server batchGet -> 返回密文 -> 本地解密
```

## 技术栈

### dme-client

| 项 | 值 |
|---|---|
| 语言 | TypeScript（strict） |
| 框架 | Expo ~52 + React Native 0.77 |
| UI 渲染 | @shopify/react-native-skia（Canvas 全 UI 渲染 + RN TextInput 覆盖层） |
| 包管理器 | Bun |
| 导航 | @react-navigation/native-stack |
| 手势/动画 | react-native-gesture-handler + react-native-reanimated |
| 加密 | @noble/curves (X25519) + @noble/hashes (HKDF/HMAC/SHA-256) + @noble/ciphers (AES-256-GCM) |
| atproto | @atproto/api (CredentialSession 密码登录) + @atproto/identity (DID 解析) |
| 存储 | @react-native-async-storage/async-storage |
| QR | react-native-qrcode-skia (生成) + expo-image-picker + jsqr (图库选图解码) |
| did:key | @scure/base (base58btc multicodec 编码) |

### dme-server

| 项 | 值 |
|---|---|
| 语言 | Go 1.22 |
| HTTP | net/http + http.ServeMux（无框架，2 个端点） |
| 存储 | BadgerDB v4（原生 TTL，7 天自动过期） |
| 事件消费 | Bluesky Jetstream（JSON 格式，服务器端按 lexicon 过滤） |
| WebSocket | github.com/coder/websocket |
| 日志 | log/slog（Go 标准库，JSON 输出） |
| 直接依赖 | 仅 2 个：badger/v4 + coder/websocket |

### dme-gateway

| 项 | 值 |
|---|---|
| 语言 | TypeScript |
| 运行时 | Cloudflare Workers (Wrangler) |
| 职责 | 反向代理，剥离客户端 IP header，转发到 dme-server |
| 无加密层 | 不实现 OHTTP/HPKE，只做 IP 剥离 |

## 协议设计

### DME Queue Envelope Lexicon

```json
{
  "lexicon": 1,
  "id": "dme.queue.envelope",
  "defs": {
    "main": {
      "type": "record",
      "key": "literal:self",
      "record": {
        "type": "object",
        "required": ["queueId", "payload", "createdAt"],
        "properties": {
          "queueId": { "type": "string" },
          "payload": { "type": "string" },
          "createdAt": { "type": "string", "format": "datetime" },
          "ratchetEpoch": { "type": "integer" }
        }
      }
    }
  }
}
```

`key: "literal:self"` 表示 rkey 直接用 queueId，AppView 也用 queueId 作为 KV 主键。

### 加密参数

| 参数 | 值 |
|---|---|
| DH 曲线 | X25519 |
| 根密钥派生 (KDF_RK) | HKDF-SHA256(salt=rootKey, ikm=dhOut, info="DME-RK", len=64) -> [rootKey(32), chainKey(32)] |
| 链密钥步进 (KDF_CK) | HMAC-SHA256(key=chainKey, 0x01)->msgKey, HMAC-SHA256(key=chainKey, 0x02)->nextChainKey |
| 消息加密 | AES-256-GCM(key=msgKey, nonce=random12, aad=headerBytes) |
| QueueID | SHA-256("DME-QueueID-v1" \|\| dhPub \|\| msgNum(uint32_le) \|\| chainKey) |
| 乱序缓存上限 | 1000 条 |

### Double Ratchet

与标准 Signal Double Ratchet 的差异：
1. 无 PreKey bundle - 共享密钥通过 QR 码握手交换
2. QueueID - 每条消息的确定性哈希，用作 PDS 记录键和 AppView 查找键
3. DH ratchet 在 decrypt 侧做两次 KDF_RK（一次接收链，一次发送链），encrypt 侧做一次

### 握手流程

```
Alice (发起方)                           Bob (接收方)
1. 拉取 Bob DID 文档中的 #dme_encryption 公钥
2. 生成临时 X25519 密钥对
3. sharedSecret = X25519(ephemeralPriv, bobPub)
4. queueId1 = deriveQueueId(ephemeralPub, 0, sharedSecret)
5. 构造 HandshakePayload (含 aliceDid, ephemeralPub, identityPubHash, queueId1)
6. 编码为 QR 码，发到 Bluesky
   ──── QR 图片 ───────────────────>  7. 图库选图 + jsQR 解码
                                      8. 拉取 Alice DID 文档中的公钥
                                      9. 验证 identityPubHash (MITM 检测)
                                     10. sharedSecret = X25519(selfPriv, ephemeralPub)
                                     11. initReceiver ratchet
                                     12. 加密 ACK 发到 queueId1
13. 轮询 server 检测 queueId1          
14. 检测到 -> initSender ratchet       
15. 后续消息通过 ratchet 加密投递
```

### did:key 编码

X25519 公钥在 PLC DID 文档中以 `did:key:z...` 格式存储：
- multicodec varint: `[0xec, 0x01]`（X25519-pub codepoint 0xec = 236，varint 编码 2 字节）
- multibase: `z` + base58btc([0xec, 0x01] + 32字节公钥)
- did:key URI: `did:key:` + multibase

## 关键决策

### Q1: DID 方法 - 写入 did:plc

Alice 构造 QR 码必须先拉取 Bob 的 DME 公钥，公钥分发渠道是 DID 文档。因此公钥必须通过 PLC 3 步流程写入用户的 did:plc 文档：
1. `requestPlcOperationSignature()` - PDS 发邮件验证 token
2. `signPlcOperation({token, verificationMethods})` - PDS 用 rotation key 签名
3. `submitPlcOperation({operation})` - 提交到 PLC 目录

需要主密码登录（非 app password），因为 signPlcOperation 要求 ACCESS_FULL 权限。

### Q2: PDS/AppView 分离

加密包裹写入 Alice 自己的 Bluesky PDS（`agent.com.atproto.repo.createRecord`），经 Jetstream 被 dme-server 消费。dme-server 是纯 AppView，不接收 createRecord，不生产事件，只消费 + 查询。

### Q3: 消息去重

ratchet 推进后旧 chain key 销毁，重复解密天然失败（主去重）。崩溃恢复时用 QueueID LRU 集合（1000 条，~64KB）兜底，存在 AsyncStorage。

### Q4: 多设备支持

MVP 不支持。后续可加"会话转移 QR"导出/导入 ratchet 状态。

### Q5: 握手通知

Bob 在 Bluesky 看到 mention 通知后手动保存 QR 图片，在 DME 中图库选图识别。无自动检测，无 deep link。

### 其他决策

- **密码登录替代 OAuth**：直接用 CredentialSession + handle + app password，不走 OAuth 流程
- **Jetstream 替代 firehose**：Jetstream 是 JSON 格式，服务器端按 lexicon 过滤，无需 CBOR/CAR 解码
- **无 OHTTP**：gateway 只做 IP 剥离反向代理，不实现 HPKE 加密层
- **无 monorepo**：三个系统完全独立，无共享 package.json/workspace/tsconfig
- **无 test/lint/format**：只 focus 开发，不做代码质量管理
- **Bun 做项目管理**：TS 侧统一用 Bun，不用 npm/yarn
- **Skia 全 UI 渲染**：除 TextInput 用 RN 原生覆盖层外，所有 UI 用 Skia Canvas 绘制
- **client 不区分 gateway/server**：client 只有一个 serverUrl，背后是直连还是经过 gateway 它不关心

## dme-server 架构

```
dme-server/
├── main.go                      # 入口：启动 HTTP + Jetstream consumer，signal graceful shutdown
├── internal/
│   ├── config/config.go         # flag 解析（--addr --db --jetstream）
│   ├── server/server.go         # http.ServeMux + 2 个 handler
│   ├── store/
│   │   ├── store.go             # BadgerDB Put/Get/GetBatch/Delete + GC loop
│   │   └── errors.go            # ErrNotFound
│   └── jetstream/
│       └── consumer.go          # WebSocket 订阅 Jetstream，JSON 解析，存储 envelope
```

### HTTP 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/_health` | 健康检查 |
| POST | `/xrpc/dme.batch.get` | 批量盲查，body `{"queueIds": [...]}` -> `{"envelopes": [...]}` |

### Jetstream 消费

- 连接 `wss://jetstream1.us-east.bsky.network/subscribe?wantedCollections=dme.queue.envelope`
- 每个事件是 JSON 对象，包含 `commit.record` 字段
- 过滤 `operation == "create"` 和 `collection == "dme.queue.envelope"`
- 存入 BadgerDB，7 天 TTL 自动过期
- 断线重连：指数退避 5s -> 10s -> 20s -> 40s -> 60s 封顶
- 不带 cursor，启动从最新事件消费

## dme-client 架构

```
src/
├── config.ts                    # PDS_URL, DME_SERVER_URL, 轮询常量
├── crypto/
│   ├── constants.ts             # 加密参数常量
│   ├── did-key.ts               # X25519 multibase/did:key 编解码
│   ├── envelope.ts              # 消息加解密 + envelope 构造
│   ├── identity.ts              # X25519 身份密钥生成/导出/共享密钥
│   ├── queue-id.ts              # QueueID SHA-256 派生
│   └── ratchet.ts               # Double Ratchet 状态机
├── atproto/
│   ├── did.ts                   # DID 公钥读取 + PLC 3-step 写入
│   ├── pds.ts                   # PDS createRecord + server batchGet
│   └── session.ts               # CredentialSession 密码登录 + persistSession
├── handshake/
│   ├── handshake.ts             # X3DH 握手（initiate/accept/initSenderRatchet）
│   ├── qr-decode.ts             # 图库选图 + Skia 像素提取 + jsQR 解码
│   ├── qr-encode.ts             # base64url 编码
│   └── wait.ts                  # 轮询握手检测
├── poll/
│   └── poller.ts                # 定时轮询 + LRU 去重 + 解密
├── protocol/
│   ├── index.ts / types.ts / lexicons.ts
│   └── lexicons/dme.queue.envelope.json
├── storage/
│   └── db.ts                    # AsyncStorage 持久化
├── state/
│   └── AppContext.tsx           # 全局状态 + actions
└── ui/
    ├── theme.ts                 # 暗色主题
    ├── SkiaButton.tsx           # Canvas + GestureDetector
    ├── MessageBubble.tsx        # Skia RoundedRect + Paragraph
    ├── TextInputOverlay.tsx     # RN TextInput 覆盖层
    ├── LoginScreen.tsx          # 登录
    ├── SetupScreen.tsx          # 密钥生成 + PLC 声明
    ├── ChatListScreen.tsx       # 会话列表
    ├── ChatViewScreen.tsx       # 聊天界面
    ├── QrDisplayScreen.tsx      # QR 生成 + 等待握手
    └── QrScanScreen.tsx         # QR 扫描 + 接受握手
```

## 开发命令

```bash
# dme-client
cd dme-client
bun install
bun run dev          # expo start

# dme-server
cd dme-server
go run main.go --addr :8080 --db ./dme.db --jetstream wss://jetstream1.us-east.bsky.network

# dme-gateway
cd dme-gateway
bun install
cp wrangler.toml.example wrangler.toml
bun run dev          # wrangler dev
```
