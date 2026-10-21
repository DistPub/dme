# 群聊分叉检测与收敛方案（2026-10-21 讨论定稿）

> 背景：实测事故——东兴双端 + fatesky 双端在群「热」中裂成两个世界（每世界各含每账号一台设备），跨世界消息互相不可解密，四台设备均无任何提示。
> 本文只覆盖**检测与收敛**。分叉的**预防**（跨账号 commit 仲裁 / per-group CAS）不在本计划，另行立项。

---

## 1. 根因回顾

### 1.1 分叉机制

- MLS 群状态是**每台设备各自维护的谱系**，靠 commit 信封推进；PDS 是哑存储，无全局全序。
- 同账号兄弟端在 join/建群等 commit 型动作上双写竞争（宣言 v2 只仲裁本账号、只管 commit 型动作、只做事前检查，跨账号并发 commit 只有 MLS 兜底），产生两条竞争 commit。
- 各设备按**各自队列的到达顺序**应用不同赢家 → 谱系分叉；兄弟端之间无实时会话同步，唯一收敛路径是备份恢复。

### 1.2 三层静默（为什么没人收到提示）

1. `poller.ts:277` 的 catch 只 `console.error`：对方谱系信封在**解密层**就失败，走不到 `AppContext.tsx:2082-2095` 的 desynced / sibling-rotated 横幅（该横幅只覆盖「信封能解密、commit 应用失败」），且未标记 processed，每轮轮询无限静默重试。
2. 宣言检查只有 6 个 commit 型动作前置调用点（建群/退群/点接受/踢人/拉人/握手），普通收发消息不过宣言 → 只要没人做群管理操作，stale/taken 永远不触发。
3. desync 统计检测（连续 N 天未成功应用信封）未实现。

---

## 2. 方案总览（五个环节）

```
检测(seq/parent 元数据) → 群主单人拍板 → 群内一条特殊消息
  → 权威世界端主动备份(唯一 push) → 非权威世界端懒发现恢复(纯 pull)
```

设计原则：

- **检测器不是预防器**：seq 机制负责「发现分叉」，不阻止分叉发生。
- **全链路不引入新的信任假设**：防伪靠 MLS sender 认证 + senderDid==owner 校验；恢复触发靠既有宣言 stale 语义。
- **收敛是懒的**：权威端 push 备份，非权威端在自己下一次需要推进群状态时才被宣言拦住。延迟无上界，但严格优于现状（永远不知道），且不造不可靠预言机。

---

## 3. 各环节设计

### 3.1 检测：commit 信封明文元数据

- `DmeEnvelope` 新增两个**可选**明文字段（不进 MLS 密文）：
  - `groupSeq`：per-group 单调递增计数，commit 发起方按本地已应用 commit 计数 +1 填写，无需服务端协调；
  - `parentQueueId`：本 commit 所引用的上一条 commit 信封的 queueId（谱系成链）。
- 本地账本：应用 commit 时记录 `seq N ↔ queueId ↔ parentRef`（db 新表或 KV）。
- **分叉铁证**：本机已应用 seq N（queueId=Q1），又收到 seq N 且 queueId=Q2≠Q1 → 分叉，`setSessionIssue(groupId, 'forked')`。
  - 同 queueId 重复投递由既有 `isQueueIdProcessed` 去重覆盖，不误报。
  - seq 缺口（本地 N，收到 N+2）→ 记观察标记，可能是落后。
- 兼容性：字段可选，旧信封无字段 = 不检测；旧版客户端混合期间检测覆盖率下降但无害。明文暴露 groupSeq/parentQueueId 无内容泄漏，可接受。

### 3.2 拍板：仅群主提示

- 检测到分叉时，**只有群主端**弹提示：「群聊xx检测到分叉，以本机为准吗？」
- 普通成员端：不做拍板类提示，和现状一致。
- **不做自动收敛兜底**（链长/字典序等确定性 tie-break 全部砍掉）：群主不在线，成员端保持分叉状态等待。宁可不收敛，不错误收敛。

### 3.3 群内特殊消息（唯一新增消息类型）

- 群主确认后，在**群里**发一条特殊系统消息（暂名 `group_fork_ruling`），内容含分叉点引用（seq + 两条竞争 commit 的 queueId）。
- O(1)：一次加密、一次扇出；MLS 密钥天然决定**只有权威世界能解开**——非权威世界设备收不到也解不开，无需寻址。
- 防伪：MLS 自带发送者认证 + 校验 `senderDid == groupId 的 owner`，不引入额外签名/PDS 记录。
- 明确否定过的替代方案：
  - 私聊/1v1 广播：大群里成员与群主大多无 1v1 会话（通道不存在），且 O(N) 风暴；
  - PDS 耐久裁定记录 + 身份签名：本方案下无必要。

### 3.4 权威世界端：主动备份

- 权威世界成员解到特殊消息后，提示并触发**主动备份**（走 `backupIdentityGuarded` 语义）。
- 作用：让每个「有设备在权威世界」的账号把权威谱系的 MLS 会话状态放上云——这是非权威端能恢复的前提。

### 3.5 非权威世界端：懒发现恢复（纯 pull）

- 收不到/解不开特殊消息，**不做「云端有新备份」的主动探测**——备份对外部是黑盒，本机无法确证云端备份更新的原因与谱系归属，强行探测等于把分叉判定问题原样重造一遍，且误提示恢复错误备份比静默分叉更危险。
- 触发路径全部为既有机制：
  1. 下次任何 commit 型动作过宣言 → PDS 高水位高于本地且过期 → stale → 既有「备份分叉，恢复备份」提示（约定 9）；
  2. 用户在设置中手动恢复；
  3. desync 统计计数作为被动辅助信号（可选，见分期）。
- 恢复即取回本账号权威端备份，拿到权威谱系 MLS 会话，此后消息可解、横幅消除。

---

## 4. 明确不做的事

| 项 | 否决理由 |
|---|---|
| 私聊/1v1 裁定广播 | 大群无 1v1 通道；O(N) 风暴 |
| 自动收敛兜底（链长/字典序） | 平手是常态，规则选不出；错误收敛比不收敛糟 |
| 「云端有新备份」主动探测 | 备份黑盒不可判，预言机不可靠 |
| rejoin/KP 自动化 | 前提仍是群主拍板，机制更重收益不明显 |
| 跨账号 commit 预防仲裁 | 属「预防」范畴，另行立项 |

---

## 5. 落地改动清单

### 5.1 dme-client

1. **信封元数据**：`DmeEnvelope` 类型加可选 `groupSeq` / `parentQueueId`；群 commit 发出路径填字段；收发类型定义同步。
2. **本地谱系账本**：`storage/db.ts` 新增 seq↔queueId↔parent 记录；commit 应用成功时写入。
3. **分叉检测**：poller/AppContext 收到带 seq 的群 commit 信封时比对账本；命中铁证 → `setSessionIssue(groupId, 'forked')` + 记录分叉点证据（两条 queueId）。
4. **群主拍板 UI**：forked 会话中，仅 owner 端弹拍板确认（会话内横幅/弹窗）；确认后发送 `group_fork_ruling` 特殊消息。
5. **特殊消息处理**：各端解析 `group_fork_ruling`（校验 senderDid==owner）→ 权威世界端触发备份提示/自动备份；非权威端解不开，天然走不到该分支。
6. **恢复提示衔接**：forked 会话在宣言 stale 时的既有提示文案复用/微调（说明「群状态已由群主更新」可选）。
7. **i18n**：拍板提示、特殊消息系统文案、（可选）恢复提示文案。

### 5.2 dme-miniapp（用户拍板：本次破例同步）

按 2026-10-15 拍板的同步规则，本方案随 dme-client **破例同步移植**，不适用默认冻结。对齐点与端差异：

1. **协议层零分叉**：`DmeEnvelope` 新字段（`groupSeq` / `parentQueueId`）、`group_fork_ruling` 消息类型与 dme-client byte-for-byte 一致，类型定义手抄同步（miniapp 不共享代码）。
2. **谱系账本**：miniapp storage 层（`src/platform/storage.ts` 复刻 AsyncStorage）加同样的 seq↔queueId↔parent 记录。
3. **检测点**：miniapp 自写 XRPC 轮询等价物（对应 dme-client poller 的消息应用路径）加 seq 比对 → `setSessionIssue(groupId, 'forked')`。
4. **拍板 UI 与特殊消息**：群主端拍板确认、`group_fork_ruling` 发送/解析、权威端备份提示——按 Taro/React 18 重写 UI，逻辑对齐；备份走 miniapp 既有备份模块。
5. **恢复衔接与 i18n**：stale 提示文案复用 miniapp 既有 i18n 结构新增 key。
6. **构建注意**：新增代码过 `mp:build` 管线（es5ify 拒收 `?.` / `??`，源码层面写法注意）；产物冒烟 `verify-artifact.mjs` 照跑。
7. **节奏**：每个 Phase 在 dme-client 落地验收后，同 Phase 移植到 miniapp（P1 → P1'、P2 → P2'），移植完成后按既有规则审计 miniapp 是否漏同步。

### 分期建议

- **P1**：改动 5.1-1~3（检测 + 账本 + forked 标记）。最小可用，先把「无声」变「有声」的探测层立起来。✅ 已实现（2026-10-21，两端类型检查通过）
- **P1'**：P1 同步移植 dme-miniapp。✅ 已实现（2026-10-21，tsc 通过）
- **P2**：改动 5.1-4~7（拍板 + 特殊消息 + 备份联动 + 恢复衔接）。收敛闭环。✅ 已实现（2026-10-21，tsc 通过）
- **P2'**：P2 同步移植 dme-miniapp。✅ 已实现（2026-10-21，tsc 通过；`mp:build` 全管线通过 + `verify-artifact.mjs` 冒烟通过——首次构建 Taro 挂起，按既定处置 pkill+清缓存重跑成功）
- **P3（可选）**：desync 统计计数，作为懒发现的补充信号（miniapp 同步规则适用）。⏸ 有意搁置：普通轮换追赶期也会出现短暂解密失败窗口，连续失败计数与正常 catch-up 难以可靠区分，贸然横幅会复制 sibling-rotated 风暴的老路；等 P1/P2 检测层跑一段时间、拿到真实误报率数据后再评估。

### P2 实现记录（2026-10-21）

- **拍板**：`issueForkRuling(groupId)`（AppContext action）——校验群主（creatorDid）+ forked 标记 + 群会话存在；经群 MLS 会话广播 `group_fork_ruling`；本机清 forked 标记（不清 sibling-rotated/desynced）→ `triggerBackupAfterAdvance`。
- **特殊消息**：`GroupForkRuling { type:'group_fork_ruling', groupId }` 走群会话加密单信封（同普通群消息投递），接收端 case：校验 senderDid == creatorDid（防伪）→ 幂等清 forked → 入一条 group_system 消息 → 备份联动。非权威世界解不开，天然走不到该分支。
- **UI**：会话列表 forked 横幅分角色——群主端「以本机为准吗？点按确认拍板」（点击即拍板），非群主端保持恢复备份横幅。
- **备份/恢复衔接**：`BACKUP_BLOCKED_STALE` 护栏与恢复前 stale 校验均扩到 forked（非权威设备禁止用落后谱系覆盖云端备份；恢复要求备份状态 ≠ 本机状态）。
- **P3 有意搁置**理由见上。

### P1 实现记录（2026-10-21）

- 检测点两处：①poller 消息循环在**解密之前**观测明文 `groupSeq`（分叉后对方信封解不开，只有明文观测可见）；②AppContext `group_commit` 分支按解析出的真实 groupId 补观测（覆盖 1v1 通道扇出的副本）。
- **归属护栏**：poller 只在 ctx.groupId 有 GroupInfo（确为群会话）时观测——1v1 副本的 ctx.groupId 是对端 DID，直接观测会记错账本并制造跨群 seq 假碰撞。1v1 上解不开的副本无法归属，P1 接受此盲区：分叉会在任一端后续 group-space commit 的 seq 碰撞时暴露（懒发现语义）。
- 账本语义：`reserveGroupCommit` 预留即落盘（投递失败留空缺 seq，收端容忍缺口，绝不复用 seq——复用会制造同 seq 异 queueId 假分叉）；每 seq 记「已见 queueId 集合」（1v1 扇出同一逻辑 commit 多份副本，发送方记全部、接收方只记自己那份）；`observeGroupCommit` 返回 new/duplicate/fork，fork 不入账（账本只保留本端谱系）。
- 账本随备份走（`FullBackupData.groupCommitLedger`）：恢复端 lastSeq 归零会让其下次 commit 从 1 重新编号 → 全员假分叉，必须随备份。
- 已知限制：parentQueueId P1 仅记录不判定（1v1 副本各端 queueId 不同，跨端 parent 比对会误报）；lexicon 已加 `groupSeq`/`parentQueueId` 可选字段（dme-server 只解析 queueId/payload，透明兼容）。

---

## 6. 开放问题 / 边界

1. **单设备账号整体掉进非权威世界**：其备份里没有权威谱系会话，恢复备份无效。暂接受「退群重进」兜底；是否保留 KP rejoin 窄口待后续评估。
2. **混合版本期**：旧客户端不发 seq → 不检测、不参与收敛，行为同现状；无破坏性。
3. **群主设备自己也分叉**（群主双端各在一个世界）：默认以「先检测到/用户正在使用的那台」的确认为准，另一台走非权威恢复路径；如需更严谨可加第二道确认，本期从简。
4. **特殊消息的历史可见性**：权威谱系内加密，非权威端恢复后可回看该消息，作为系统消息无害。
