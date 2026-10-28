# 1v1 私聊救援握手计划

## 1. 背景与目标

DME 的 1v1 会话基于 MLS。当一方因密钥轮换、commit 丢失、generation 落后或 7 天 TTL 边界导致会话静默脱钩时，双方基于当前 MLS 状态派生的 queueId 空间会完全不相交——彼此拉不到任何消息，也没有任何报错标记。

本方案提供一个**救援握手**机制：

- 不尝试修复旧 MLS 状态。
- 直接通过重新握手开一个**全新的 1v1 会话**。
- 历史明文消息已本地持久化，不受影响。
- 救援通道与 MLS epoch 无关，仅依赖双方长期身份密钥，因此即使原会话已完全脱钩仍可通信。

## 2. 核心设计

### 2.1 救援 QueueID（双向分离）

每个 1v1 会话有两个救援 queueId，分别由**双方各自 DID** 作为因子派生：

- `rescueQueueId(ourDid)`：供**对方**扫描，本机只写入、不读取。
- `rescueQueueId(theirDid)`：供**本机**扫描，对方只写入、不读取。

这样本机永远不会轮询到自己发出去的消息，避免了"拿到但无法解密才发起救援"的迂回判断。

派生输入：

- 双方身份 X25519 密钥的 ECDH 共享密钥（server 不可算）。
- 写入方 DID（区分两个方向）。
- 初次加好友时的 welcome 日期（双方一致，用于隔离旧救援消息）。
- 当前日期（救援通道当天有效，过期自然被 TTL 清理）。

```
sharedSecret = x25519.getSharedSecret(ourEncPriv, theirEncPub)
rescueQueueId(writerDid) = HKDF-SHA256(
  sharedSecret,
  salt = "dme-rescue-v1",
  info = "dme.rescue.v1:queueid:" + writerDid + ":" + welcomeDate + ":" + today,
  length = 32
)
rescueQueueId = base64url(rescueQueueId)
```

- 当 A 需要救援时，A 写入 `rescueQueueId(A)`，B 扫描 `rescueQueueId(A)`。
- 当 B 需要救援时，B 写入 `rescueQueueId(B)`，A 扫描 `rescueQueueId(B)`。
- 双方各自只轮询以**对方 DID** 为因子的 queueId。

### 2.2 回调 QueueID

救援发起方（需要救援的一方）从 KP 池取一个 pair，回调 queueId 复用正常 welcome 机制：

```
callbackQueueId = deriveWelcomeQueueId(keyPackagePair.publicPackage.initKey)
```

施救方收到救援消息后，像收到群聊邀请一样在 UI 展示卡片，由用户手动确认后才执行 `acceptInvite` 生成 welcome，并投到 callbackQueueId。发起方轮询该 queueId 收到 welcome 后走正常 `processWelcome` 流程。

### 2.3 救援消息格式

救援消息只包含重新握手所需的 QR 数据，不传输任何历史消息或 MLS state。

```ts
interface RescueMessage {
  type: 'need_rescue';
  /** 发起方 DID */
  fromDid: string;
  /** 标准 QR 握手数据，与 prepareInviteQr 输出格式一致 */
  qrData: string;
  /** 回调 queueId，施救方将 welcome 投到这里 */
  callbackQueueId: string;
  /** 救援消息创建时间 ISO-8601 */
  sentAt: string;
  /** 单次 nonce，用于防重放 */
  nonce: string;
  /** 对以上字段的 Ed25519 签名 */
  signature: string;
}
```

消息整体用 rescueQueueId 派生密钥做 AEAD 加密后作为 envelope payload 写入 PDS。

### 2.4 状态机

#### 发起方 A（需要救援）

```
进入私聊消息界面
  │
  ▼
当天已有 pending callback？
  ├─ 是 → 只轮询 callbackQueueId，不弹窗
  └─ 否 → 继续
       │
       ▼
满足 "7 天无消息 + 最近 3 次轮询无消息"？
  ├─ 否 → 不动作
  └─ 是 → 弹窗"检测到与对方长时间断联，今日是否需要救援？"
            │
            ├─ 拒绝 → 记录今天已提示，不动作
            └─ 同意
                 │
                 ▼
            从 KP 池取 pair（池空则自动刷新补充）
            构造 QR 数据
            派生 A 的救援 queueId：rescueQueueId(A)
            发送 RescueMessage 到 rescueQueueId(A)
            持久化 pending callback
                 │
                 ▼
            当天只轮询 callbackQueueId
                 │
                 ▼
            收到 welcome → processWelcome → 更新 session → 清除 pending callback
```

#### 施救方 B（收到救援）

```
轮询 B 的救援接收 queueId：rescueQueueId(A)
  │
  ▼
收到可解密 RescueMessage
  │
  ▼
验证签名、检查 sentAt 日期为当天
  │
  ▼
本地记录 pendingRescueInvite（date = 当天，过期不展示）
UI 展示"对方请求救援握手"卡片（仅当 date 为当天）
  │
  ▼
用户点击确认
  │
  ▼
清除 pendingRescueInvite
用 qrData 执行 acceptInvite（KP 池空则自动刷新补充）
生成 welcome
把 welcome 投到 callbackQueueId
本地持久化新 session
```

施救走手动确认，避免多端登录时一台设备自动 welcome 导致兄弟端混乱。

## 3. 与现有流程集成

### 3.1 新增持久化字段

在 `DmeStorage` 中新增：

```ts
async setWelcomeDate(groupId: string, date: string): Promise<void>
async getWelcomeDate(groupId: string): Promise<string | null>

async setRescueCallback(
  groupId: string,
  callback: { date: string; callbackQueueId: string }
): Promise<void>
async getRescueCallback(
  groupId: string
): Promise<{ date: string; callbackQueueId: string } | null>
async clearRescueCallback(groupId: string): Promise<void>

async setRescueInvite(
  groupId: string,
  invite: { date: string; fromDid: string; qrData: string; callbackQueueId: string }
): Promise<void>
async getRescueInvite(
  groupId: string
): Promise<{ date: string; fromDid: string; qrData: string; callbackQueueId: string } | null>
async clearRescueInvite(groupId: string): Promise<void>

// 救援信封去重辅助（poller 自愈判据，见 4.2）
async setRescueConsumed(groupId: string, queueId: string): Promise<void>
async getRescueConsumed(groupId: string): Promise<string | null>

// 撤销「已处理」标记（处理失败时回滚，让下一轮重试）
async unmarkQueueIdProcessed(queueId: string): Promise<void>
```

### 3.2 初次握手时写入 welcomeDate

- `acceptInviteQr`（Bob 侧）成功后：
  - `storage.setWelcomeDate(groupId, createdAt.slice(0, 10))`
- `processReceivedWelcome`（Alice 侧）成功后：
  - 从 welcome envelope 的 `createdAt` 提取日期写入。
  - 需要给 `IncomingWelcome` 增加 `createdAt` 字段，并在 poller welcome 分支传入。

### 3.3 救援成功后更新 welcomeDate

A/B 双方在救援重新握手成功后，再次写入新的 welcomeDate，确保旧救援消息不会再被新会话扫描到。施救方手动确认 acceptInvite 时写入日期；发起方 processWelcome 时写入日期。同时清除发起方的 pendingRescueCallback 和施救方的 pendingRescueInvite。

## 4. 轮询器行为

复用现有 `DmePoller` 的轮询循环。AppContext 在每次轮询前为每个 1v1 会话计算对应的救援/回调 queueId，通过 `setRescueQueueId(groupId, queueId)` / `setRescueCallbackQueueId(groupId, queueId)` 注入 poller。

注入规则（无 `GroupInfo` 的 groupId，即 1v1 会话）：

```ts
// callback 通道：当天已发起救援则扫，否则不扫
const pending = await storage.getRescueCallback(groupId)
if (pending && pending.date === today) {
  poller.setRescueCallbackQueueId(groupId, pending.callbackQueueId)
} else {
  poller.setRescueCallbackQueueId(groupId, null)
}

// 救援通道：**始终扫描**对方的救援 queueId（以对方 DID 为 writerDid）
const theirDid = groupId // 1v1 的 groupId 即对方 DID
const queueId = deriveRescueQueueId(sharedSecret, theirDid, welcomeDate, today)
poller.setRescueQueueId(groupId, queueId)
```

- 本机永远只扫描 `rescueQueueId(对方 DID)`，不会扫到自己发的那条。
- 救援 queueId 与常规消息 queueId 一起参与 5–15 秒的随机轮询，不单独控制频率。
- **两个通道并行扫描，不互斥**。救援 queueId 本就按 writerDid 分离（本机只扫
  对方写的那个），并行扫描不会扫到自己发的消息；而若「发起救援即停扫救援
  通道」，双方同一天都发起救援时会互等死锁（谁都收不到对方的救援请求）。

### 4.1 处理顺序不变量（重要）

poller 处理信封时，**必须「先处理成功、再标记已处理」**。把 `markQueueIdProcessed`
放在处理之前，等于给失败一次静默永久丢弃的机会：处理失败后该 queueId 会被
LRU 永久跳过，之后永远取不到。

2026-10-28 真机踩坑：救援分支是「先 mark 再调 `onRescue`」，而
`handleRescueMessage` 遇到 `welcomeDate` 缺失 / peer key 解析失败 / 解密失败 /
`fromDid` 不匹配时会提前 `return` —— 结果救援消息被永久标记为已处理，
控制台一直刷 `skipping already-processed queueId`，救援卡片永不出现。

因此：

- `onRescue` 回调返回 `boolean`（是否成功消费），poller 据此决定是否标记。
- 失败时不标记 → 下一轮轮询重新拉取并重试。
- `rescue_callback` 分支同样遵循「先处理成功、再标记」。

### 4.2 脏标记自愈

已被污染的 LRU 标记无法自动恢复，需要自愈机制。判据：

> **「已成功消费的救援信封 queueId」≠ 当前 envelope 的 queueId**
> ⇒ 这条救援消息从未被成功消费过 ⇒ LRU 标记是脏数据 ⇒ 撤销并重试。

用 `storage.rescueConsumed:{groupId}` 记录已成功消费的 queueId。
**不能用 `rescueInvite` 记录做判据**：用户接受救援后 `acceptRescueInvite`
会清掉 `rescueInvite`，此时若用它判据会误判成「从未消费」→ 撤销标记 →
已接受的救援卡片复活。

### 4.3 welcomeDate 必须三处同源

`welcomeDate` 是救援 queueId 与 message key 的派生输入，**三处必须调用同一个
解析函数**（`resolveWelcomeDate`）：

- `refreshRescueQueueIds`：扫对方通道
- `sendRescueHandshake`：写自己通道
- `handleRescueMessage`：解密对方消息

规则：持久化值 → 第一条历史消息的日期 → 当天。三处规则不一致 → 双端派生
出不同的 message key → 解密必失败（表现为「对方收到救援标记，但本机扫不到/
解不开」）。

## 5. 进入私聊时的弹窗触发

在 `ChatViewScreen` 挂载时或 AppContext 打开 1v1 会话时：

```ts
async function checkRescuePrompt(groupId: string) {
  const today = getLocalDate()
  const pending = await storage.getRescueCallback(groupId)
  if (pending && pending.date === today) return // 已发起

  if (!await shouldPromptRescue(groupId)) return

  const ok = await showConfirm('检测到与对方长时间断联，今日是否需要救援？')
  if (!ok) {
    await storage.setRescuePromptedToday(groupId, today)
    return
  }

  await sendRescueHandshake(groupId)
}
```

触发条件：

- 距离本机最后一次收到对方消息 ≥ 7 天。
- 最近 3 次轮询该会话都没有收到新 envelope。
- 今天还没有对该会话提示过。

## 6. 安全考虑

### 6.1 身份认证

救援消息必须带 Ed25519 签名，施救方验证签名后才执行 `acceptInvite`。防止第三方伪造救援请求重置会话。

### 6.2 重放防护

- `sentAt` 日期必须是当天，非当天的救援消息直接拒绝。
- `nonce` 单次有效，已处理过的 nonce 拒绝。

### 6.3 隐私

救援 queueId 依赖 ECDH 共享密钥，server 无法关联到具体会话。但固定 rendezvous 点仍可能被用于流量分析，因此：

- 不携带任何消息内容或会话元数据。
- 复用现有轮询频率，不单独增加扫描频率。

### 6.4 历史消息

重新握手会创建新 MLS group，旧会话中未本地解密的历史消息将永远无法解密。已本地持久化的明文消息不受影响。不在 UI 额外提示"历史消息可能丢失"。

## 7. 边界场景

| 场景 | 行为 |
|---|---|
| A 发救援，B 当天在线 | B 在 UI 展示救援邀请卡片，用户确认后 welcome，A 收到 welcome 恢复 |
| A 发救援，B 第二天才上线 | A 的 callback 只当天轮询，第二天 A 需重新进入私聊才会再次发救援 |
| 双方同时发救援 | 各自 pending callback，互不影响；概率极低，不额外处理 |
| KP 池空 | 自动刷新/补充 KP 池 |
| 老用户无 welcomeDate | 取第一条历史消息时间；无历史消息则 fallback 昨天；救援成功后写入新日期 |
| 重放旧救援消息 | 签名/时间戳校验失败，忽略 |

## 8. 实施计划

| 阶段 | 任务 | 输出 |
|---|---|---|
| 1 | 编写设计文档 | 本文档 |
| 2 | 实现 `src/crypto/rescue-handshake.ts` 和 `src/protocol/rescue.ts` | 密码学模块 + 类型 |
| 3 | 扩展 `DmeStorage` | welcomeDate / rescueCallback 持久化 |
| 4 | 修改轮询器 | 救援通道扫描 + 救援邀请处理 |
| 5 | 进入私聊弹窗 + 发起救援 | UI 与 AppContext 集成 |
| 6 | 联调与边界测试 | 测试清单通过 |

## 9. 待决策事项

无。
