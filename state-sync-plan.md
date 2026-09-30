# DME 状态同步 Phase 1：盲化心跳 + 发送链对齐

> 背景讨论见 2026-09-29 工作日志第 8 节。本文档是实现计划，不是设计讨论记录。

## 目标（本期只做这两件事）

1. **心跳 blob 定时存储**：每个用户在自己 PDS 维护**单条** `dme.state.sync` record（rkey 固定 `self`，putRecord 覆盖写），内含盲化字典 + 定长填充；定时写入，**备份身份时顺带写一次**。
2. **恢复备份时对齐自己的发送链**：`restoreIdentityFromBackup` 成功后，拉取自己的云端心跳，凡 epoch 一致且云端 generation 领先本地的会话，把本地发送 ratchet 快进对齐，消除"备份后旧设备继续发消息"导致的序号撞车。

## 明确不做（Phase 2+）

- creator 写群级事实（epoch / memberListHash）——本期 blob 里普通成员**不写**这两个字段
- 接收链追赶（精准查 blob / 指数探测）
- epoch 脱钩处置（creator 重邀流程）、被踢提示、连接异常 UI
- dme-miniapp 对齐（先 dme-client 验证设计，再移植）

---

## 1. 心跳 record 设计

### 1.1 形状

```ts
// NSID: dme.state.sync, rkey: 'self', putRecord 覆盖写（与 dme.backup.identity 同款）
{
  $type: 'dme.state.sync',
  v: 1,
  updatedAt: string,          // ISO8601
  entries: {
    // key = base64url(sha256(groupIdBytes ‖ utf8(ownDid)))，43 字符
    // value.g 语义 = 「下一条我将使用的 generation」= getExpectedGeneration(ownLeaf)
    // value.e 语义 = state.groupContext.epoch（number）
    "<blindedKey>": { e: 7, g: 42 },
    // ...定长填充条目：随机 32 字节 key（base64url），value 为随机 {e,g}
  }
}
```

- **单 record**：外人枚举 repo 永远只看到 1 条，会话基数不可数
- **内层盲化**：key 是哈希，群身份不可见；value 无群元信息
- **定长填充**：真实条目数向上取整到 16 的倍数，不足用随机条目补齐（体积侧信道量化到 16 档）
- **公开可读**：恢复对表和（未来）对端追赶都直接 getRecord，无需 membership——这正是"被踢也能发现自己被踢"的前提

### 1.2 写入触发

| 触发 | 条件 | 失败处理 |
|---|---|---|
| 定时器 | 每 12h，且自上轮写入以来有任何会话 generation 变化 | 静默 log，绝不阻塞收发主流程 |
| `backupIdentity` | 身份备份上传成功后顺带写一次（用户口令备份 = 用户在意状态的时刻，心跳必须新） | 同上 |

写入前从 poller 内存中的 sessions 收集（`poller.getSession(groupId)`，groupId 列表来自 `storage.listGroups()`），不要反序列化磁盘 session，避免每次写入全量解码。

### 1.3 量化语义

本期采用最简量化：12h 窗口 + 变化检测。不实现"每跨 50 条消息"细粒度（Phase 2 视需要加）。

---

## 2. 发送链对齐（恢复路径）

### 2.1 流程（挂在 `restoreIdentityFromBackup` 末尾，sessions 已加载进 poller 之后）

```
alignOwnSendChains():
  blob = pds.getSyncState()            // 无 record → 直接返回（老用户没有心跳，退化为现状）
  for groupId in storage.listGroups():
    session = poller.getSession(groupId)
    if (!session) continue
    key     = base64url(sha256(groupIdBytes ‖ utf8(ownDid)))
    entry   = blob.entries[key]
    if (!entry) continue               // 云端没这个群的心跳 → 跳过
    localE  = session.getEpoch()
    localG  = session.getExpectedGeneration(ownLeaf)
    if (entry.e !== localE):
      log('epoch 脱钩，本阶段不处理')     // Phase 2: creator 重邀
      continue
    if (entry.g <= localG) continue    // 云端不领先 → 无分叉
    session.advanceOwnGeneration(entry.g)   // 新方法，见 2.2
    storage.putMlsSession(groupId, session.serialize())
  // 对齐完成后顺手写一次心跳（本地已是最新）
  heartbeat.writeNow()
```

### 2.2 `MlsSession.advanceOwnGeneration(target)`（新方法）

依据 ts-mls 公开 API（`secretTree.d.ts` 已确认导出）：

```ts
import { ratchetUntil, defaultKeyRetentionConfig } from 'ts-mls';

async advanceOwnGeneration(target: number): Promise<void> {
  const treePos = this.senderLeafIndex * 2;
  const node = this.state.secretTree[treePos];
  const current = node.application;                 // {secret, generation, unusedGenerations}
  if (target <= current.generation) return;
  const [advanced, discarded] = await ratchetUntil(
    current, target, defaultKeyRetentionConfig, this.impl.kdf /* spike 确认字段名 */
  );
  discarded.forEach(zeroOutUint8Array);
  node.application = { secret: advanced.secret, generation: advanced.generation, unusedGenerations: {} };
  zeroOutUint8Array(current.secret);
}
```

原理：发送链的 generation 推进本质是 `secretTree[ownLeaf*2].application` 的哈希前进（`createApplicationMessage` 内部即如此消费），纯本地运算、不需要任何密文，跳过的消息本来也已过 TTL。

**对齐前进水后不能回退**：ratchetUntil 丢弃的 intermediate keys 直接清零（`discarded`），与 ts-mls 消息发送路径的 `consumed.forEach(zeroOut)` 保持一致。

### 2.3 epoch 语义与安全边界

- `entry.e !== localE` 一律跳过——epoch 不一致时快进 generation 毫无意义（queueId 基底都不同），乱对齐反而制造假象
- 对齐只 bump 自己的发送链，**不碰** secretTree 里其他 leaf 的接收链（接收链是 Phase 2）
- `advanceOwnGeneration` 前后 `serialize()` 落盘，崩溃恢复后状态一致

---

## 3. 文件级改动清单

| 文件 | 改动 |
|---|---|
| `src/protocol/types.ts` | `DME_SYNC_NSID = 'dme.state.sync'`；`SyncStateRecord` / `SyncEntry` 类型 |
| `src/atproto/pds.ts` | `putSyncState(entries: SyncBlob): Promise<void>`（putRecord rkey 'self'）；`getSyncState(): Promise<SyncBlob \| null>`（getRecord，404 返回 null）——均仿照 `putIdentityBackup`/`getIdentityBackup` |
| `src/crypto/mls-session.ts` | `getEpoch(): number`（`state.groupContext.epoch`）；`advanceOwnGeneration(target)`（§2.2） |
| `src/state/heartbeat.ts` | **新文件**。`buildSyncBlob(sessions, did)`（盲 key + padding）、`writeNow()`、`start(intervalMs)` 定时器 + 变化检测、纯函数便于单测 |
| `src/state/AppContext.tsx` | ① `backupIdentity` 成功后追加 `heartbeat.writeNow()`；② `restoreIdentityFromBackup` 末尾追加 `alignOwnSendChains()`（新内部函数）；③ 登录完成/会话就绪后 `heartbeat.start(12h)` |
| `AGENTS.md`（dme-client） | 快速定位表补条目 |

无 UI 改动、无 i18n 改动。网关模式不需要动：putRecord/getRecord 走 agent 直连 PDS，与 `dme.backup.identity` 同路径。

---

## 4. 测试计划

1. **blob 单测**（`heartbeat.test.ts`）
   - 同一会话集合两次构建，盲 key 稳定；did/groupId 变则 key 变
   - 0 / 1 / 16 / 17 个条目时 padding 后 entries 数为 0 / 16 / 16 / 32
   - 解析端只认精确 key，padding 条目被忽略
2. **advanceOwnGeneration 单测**（核心正确性）
   - 建两人组，founder 连发 5 条 → joiner 全部解密
   - founder `advanceOwnGeneration(10)` → 第 6 次 encrypt 返回 `generation === 10`
   - joiner 对该链 ratchet 到 gen 10 → 能解密这条消息
   - `advanceOwnGeneration(3)`（target 倒退）→ no-op
3. **对齐流程集成测试**（mock pds）
   - 云端 blob 领先 5 代 → 对齐后本地 session generation = 云端值，storage 已持久化
   - epoch 不同 → 跳过且不写盘
   - 云端无 record → 全程静默返回 true

---

## 5. 风险与待验证（M0 spike，半天内）

| # | 风险 | 验证方式 |
|---|---|---|
| R1 | `ratchetUntil` 的 `kdf` 参数如何从 `CiphersuiteImpl` 取（字段名/类型） | 读 ts-mls `crypto/ciphersuite.d.ts` + 跑通单测 |
| R2 | `createApplicationMessage` 消费发送 ratchet 的方式与 `ratchetUntil` 前进是否逐字节等价（nonce/key 派生是否依赖额外状态） | 测试 2：跨 advance 的加解密互通即证明 |
| R3 | `groupActiveState` / `checkCanSendApplicationMessages` 在 deserialize + advance 后是否放行 | 测试 2 顺带覆盖 |
| R4 | `historicalReceiverData` 是 `Map<bigint, …>`，序列化兼容性（现有备份已含此字段，新增字段不触碰它） | 现有备份测试回归即可 |
| R5 | padding 条目被 `getSyncState` 消费端误当真实数据 | blob 解析只按 key 查表，天然免疫；测试 1 覆盖 |

---

## 6. 里程碑

- **M0**：spike R1–R3，`advanceOwnGeneration` 单测跑通
- **M1**：blob 构建 + pds 读写 + 定时器 + 备份时写入
- **M2**：恢复对齐流程接入 `restoreIdentityFromBackup`
- **M3**：全部测试 + tsc + 手动验证（旧备份恢复场景演练一遍）

## 7. Phase 2 预告（不在本期）

creator 群级事实条目（`H(groupId‖'meta') → {e, memberListHash}`）→ 恢复时 O(1) 判断 epoch 脱钩/被踢；接收链双路追赶（精准查 blob / 指数探测）；连接异常 UI 与重握手引导；dme-miniapp 移植。
