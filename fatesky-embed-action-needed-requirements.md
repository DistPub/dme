# fatesky 嵌入模式需求：会话异常"需要用户处理"通知（DME_ACTION_NEEDED）

> 来源：DME 侧（dme-client）已实现并推送该消息；fatesky 侧需要接收并展示提示。
> 协议文件对齐：DME 侧 `dme-client/src/embed/protocol.ts` ⇄ fatesky 侧 `src/lib/dme-embed/constants.ts`（两文件必须 byte-for-byte 同步）。

## 1. 背景

DME 以 iframe 嵌入 fatesky 的 `/messages` 路由。当用户某台设备无法跟上同账号其他设备的密钥轮换（或多端状态分叉）时，DME 会在会话上打异常标记，并在 DME 内部显示"恢复最新备份"横幅，需要用户进入 DME 手动处理。

**现状问题**：这类提示只存在于 iframe 内部的会话列表横幅。用户停留在 fatesky 其他页面时完全无感知——现有的 `DME_UNREAD` 红点只统计未读消息数，不包含会话异常。

**目标**：DME 在出现（或解除）需要用户处理的会话异常时，主动 postMessage 通知 fatesky；fatesky 在 /messages 入口展示一个可见提示，引导用户点进去处理。

## 2. 协议变更

`DME_MSG` 新增一个消息类型（常量名、字符串值与 DME 侧完全一致）：

```ts
ACTION_NEEDED: 'DME_ACTION_NEEDED',
```

| 消息 | 方向 | 用途 |
|---|---|---|
| `DME_ACTION_NEEDED` | DME → fatesky | 通知"有会话需要用户在 DME 内做恢复动作"及解除通知 |

### Payload

```ts
{
  protocol: 'dme-embed/v1',
  type: 'DME_ACTION_NEEDED',
  payload: {
    needed: boolean,  // true = 至少一个会话有异常，需要用户处理
    count: number,    // 需要处理的会话数（needed=false 时恒为 0）
  },
}
```

异常种类包括：`sibling-rotated`（同账号另一设备已轮换，本机需恢复备份）、`forked`（群谱系分叉，需恢复权威备份）、`desynced`（解密脱钩，需重新握手）。**fatesky 不需要区分种类**，DME 内部的横幅会给出具体指引；fatesky 只负责"提醒用户进去看"。

## 3. 发送时机（DME 侧已实现，供理解时序）

- 复用现有未读上报的心跳：iframe 加载完成后立即上报一次，之后每 30 秒一次，以及在 `chatListVersion` 变化（会话列表刷新）时上报。
- 因此从异常标记出现到 fatesky 收到通知，最大延迟约 30 秒。
- **值去重**：相同的 `(needed, count)` 组合只发一次；解除（`needed=false, count=0`）也会发送，fatesky 据此撤掉提示。
- 仅在 embed 模式发送；standalone（独立 web / native）行为不变。

## 4. fatesky 侧需要做的事

1. `src/lib/dme-embed/constants.ts` 新增 `DME_ACTION_NEEDED = 'DME_ACTION_NEEDED'`（与 DME 侧 byte-for-byte 同步）。
2. 在现有的 `message` 监听器中处理该类型：校验 `payload.needed === typeof boolean`、`payload.count === typeof number` 后，更新本组件/全局状态。
3. UI 提示（建议，具体形式由 fatesky 决定）：
   - 在 `/messages` 导航项上显示一个**区别于未读红点**的标记（如橙色点 / ⚠ 角标），`count > 0` 时显示。
   - 收到 `needed=false` 时清除该标记。
   - 可选：显示"需要处理恢复"的短文案，点击即进入 `/messages`（iframe 内 DME 自己会展示具体横幅和操作入口）。
4. **不需要**回发任何消息——这是单向通知。

## 5. 边界场景

- **账号切换** = fatesky 侧 iframe remount（`key={did}`），提示状态随组件重建自然重置，无需特殊处理。
- **刷新/重新加载**：DME 在 iframe 每次加载完成后都会立即上报一次当前状态，fatesky 刷新后收到的第一条即为权威值，不需要持久化该状态。
- **token 异常**：`DME_SESSION_INVALID` 是另一条独立通道（登录态问题），与本次的通知互不影响。
- 若 fatesky 尚未适配而 DME 已上线：新消息类型对旧监听器是未知类型，现有 handler 应已按 `type` 分发丢弃未知类型——不会破坏现有功能（请确认 fatesky 的 switch/default 行为确实如此）。

## 6. 验收要点

1. 模拟一个会话出现 `sibling-rotated` 标记（如两台设备各自轮换后，用落后端登录）→ fatesky /messages 入口在 ≤30 秒内出现提示。
2. 用户进入 DME 完成恢复备份 → 标记清除后 ≤30 秒（或下次心跳/列表刷新时）fatesky 提示消失。
3. `count` 与 DME 会话列表中带横幅的会话数一致。
4. 未登录 / 会话正常时，fatesky 不会收到或不会显示提示。
