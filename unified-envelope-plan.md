# 收发统一改造计划：一切链状态由"处理信封"驱动

> 2026-10-13 讨论定稿。替代 `state-sync-plan.md` 的方向（该文档保留作历史参考，不改动）。
> 核心目标：多端（同账号经备份恢复登录）收发同步。

## 一、设计原则（讨论定稿）

1. **发送侧零状态管理**：发消息 = 在 state 克隆上加密 → 写 PDS → 把自己的信封喂给统一处理路径。发送动作本身不推进游标、不销毁密钥。
2. **唯一状态入口**：游标推进、发送链密钥消费/销毁，只发生在"处理信封"路径（`processPrivateMessage` → 解密 → 去重 → 入库 → 渲染）。自己的消息和别人的消息走同一条路。
3. **queueId 语义不变**：推导公式不变（exporter + senderLeafIndex + generation），去重照旧按 queueId（LRU + hasMessage）。
4. **dme-server / dme-gateway 零改动**：server 的 Badger 本来就按 queueId 一槽一封、覆盖写（`store.go:99`），同 gen 撞槽时后写覆盖先写，**输了无所谓**（用户拍板，不做回读校验）。
5. PDS 写法维持 `createRecord` 随机 rkey 不动。
6. 多端同步是免费的：B 端恢复备份后持有相同 exporter/secret tree，轮询自己 leaf 那一行即可解出 A 端发的所有消息，走同一处理路径，按 `senderDid === ownDid` 渲染为 outgoing。

## 二、发送流程（改造后）

```
sendMessage(groupId, plaintext):
  1. await enqueue(groupId)                    # 组内互斥，防止并发连发撞槽
  2. clone = deserialize(serialize(state))    # 克隆，原 state 一字节不动
  3. gen = getExpectedGeneration(ownLeaf)     # 当前游标
  4. { ciphertext } = createApplicationMessage(clone, plaintext)   # gen 不变，clone 内部推进被丢弃
  5. queueId = deriveMessageQueueId(exporter, senderLeafIndex, gen)
  6. await pds.createEnvelope(...)            # 失败则直接报错返回，状态未动，可原 gen 重试
  7. processEnvelope(ciphertext)              # 自回环：走统一路径，游标 n→n+1、消费密钥、入库、渲染
  8. dequeue
```

- 第 7 步是唯一让游标前进的地方。没有它，快速连发的两条会同落 gen n：server 只留第二条、本地库按 queueId 去重把第二条挡掉，两端各缺一条。
- 渲染方向：统一路径入库时 `outgoing = (payload.senderDid === ownDid)`，不再依赖发送/接收两条代码路径。

## 三、接收/轮询（改造后）

```
poll():
  for each leaf in memberDids:                # 不再跳过 ownLeafIndex
    scan generations from cursor until miss   # 逻辑不变，泛化到自己的行
  for each fetched envelope:
    processEnvelope(envelope)
      ├ processPrivateMessage → 消费 gen、销毁旧密钥、游标推进（gen 缺口可跳过推导，天然容错）
      ├ hasMessage(queueId) 已存在 → 跳过入库（游标已推进，正是期望行为）
      └ 入库（outgoing 判定同上）→ 触发 UI
```

## 四、文件级改动清单

| 文件 | 改动 |
|---|---|
| `src/crypto/mls-session.ts` | 新增 `encryptDetached(plaintext)`：克隆 state 加密，返回 `{ciphertext, queueId, generation}`，`this.state` 不动；`decrypt`/`processPrivateMessage` 保留为处理路径核心 |
| `src/poll/poller.ts` | 删除 `if (i === ownLeafIndex) continue`（约 :147）；扫描/解密逻辑泛化 |
| `src/state/AppContext.tsx` | ① 抽取统一 `processEnvelope(ciphertext)`（现 handleIncomingMessage 的解密→去重→入库段）；② `sendMessage` 按第二节重写（组内互斥队列 + encryptDetached + createEnvelope + 自回环） |
| `AGENTS.md`（dme-client） | 快速定位表补条目 |

不改动：协议字段、`dme.queue.envelope` 形状、queueId 推导（`mls-queue-id.ts`）、server、gateway、i18n、dme-miniapp（已冻结）。

## 五、兼容性

- 对端无感知：密文格式、队列寻址、gen 语义对 receiver 完全不变；旧版客户端发的消息在新版就是普通来信。
- 已有本地数据（MLS session、消息库）无需迁移。
- 升级窗口内新旧版本混跑无冲突（gen 消费时机差异只影响本机状态推进，不影响对端）。

## 六、风险与 spike（M0，半天）

| # | 风险 | 验证 |
|---|---|---|
| R1 | ts-mls `processPrivateMessage` 能否解密自己 leaf 的 application message（本地未消费 gen） | 直接跑通"加密→自回环解密"单测 |
| R2 | clone state（serialize→deserialize）成本 | 现状每次 send 已 serialize 落盘，同级；实测即可 |
| R3 | gen 缺口（撞槽丢了 n，先到 n+1）时 `ratchetToGeneration` 是否放行 | 单测：跳过 n 直接处理 n+1 |
| R4 | 组内互斥在 RN 环境的定时/重入边界 | 单测并发 sendMessage |

## 七、测试计划

1. 单测：加密→自回环→gen 递增；连续两条 gen 为 n、n+1（不撞槽）。
2. 单测：own-leaf 回环解密 + outgoing 判定。
3. 单测：同 gen 两封不同密文（模拟跨端撞槽）→ server 覆盖语义 mock 下只处理一封，另一封丢失可接受。
4. 集成：mock PDS 双端（同 identity 快照）收发互通；恢复备份后 B 端能看到 A 端历史发送（TTL 内）。
5. 手动：两台设备恢复同一备份互发。

## 八、里程碑

- **M0**：spike R1–R3（半天，R1 不过则本方案回炉）
- **M1**：抽取统一 processEnvelope + poller 去 skip
- **M2**：sendMessage 改造（克隆加密 + 串行化 + 自回环）
- **M3**：全部测试 + tsc + 双设备手动验证
