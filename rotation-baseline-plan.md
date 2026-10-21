# 新会话轮换基线 + KP 池统一消费（rotation-baseline-plan.md）

> 2026-10-21 讨论定稿（v2，含用户三项拍板：①现场生成统一改吃 KP 池；②KP 最大有效期 = 设置里的轮换周期；③pending 不做超时）。仅计划未实施。
> 范围：dme-client + dme-miniapp（安全配套，按 2026-10-15 同步规则强制移植，miniapp 冻结例外）。

## 1. 背景与根因

用户观察：新建群聊过一会儿就自动密钥轮换，不合理。

根因（rotation.ts:110-111）：

```ts
const last = await deps.getLastRotationAt(groupId);
if (Date.now() - last < interval) continue;
```

- 新会话的 `lastRotationAt` 初始为 **0**（db.ts：「0 = 从未轮换」），`now - 0` 必然 ≥ 周期 → 创建后的第一次轮换检查（启动 / 回前台 / 定时器）即"到期"，叠 0–2min 随机抖动 = 用户看到的"过一会就轮换"。
- 全库只有两处写 `lastRotationAt`：轮换成功（rotation.ts:214）和备份恢复（AppContext.tsx:1161）。**建群 / joinViaWelcome / 1v1 握手成功均不写基线**。

为什么必须配套 KP 池管控：接受方叶子密钥来自预生成囤积的池，年龄无上界；直接把基线设成建群时刻等于给老密钥续命一个完整周期。

## 2. 目标 / 非目标

**目标：**
1. 新建会话（群 + 1v1）不再"创建后立刻到期轮换"；基线 = 会话在本设备首次落盘时刻。
2. **所有**进入会话的叶子密钥统一来自 KP 池，年龄上界 = 当前设置的轮换周期（含基线推迟，密钥总寿命上界 = 2× 周期）。
3. 不破坏既有语义：备份恢复写回、轮换失败下周期重试、旧备份立即到期（向后兼容）。

**非目标：**
- 不改轮换周期设置项本身（24h/7d/30d）与宣言 v2 仲裁逻辑。
- **不做邀请超时**（用户拍板：PendingInvite 长期占用池 pair 导致该 pair 年龄无上界，知情接受；但退役逻辑仍须排除被引用条目，见 §5.1）。
- 不做 desync 统计检测（group-fork-plan P3，另行搁置）。

## 3. 方案设计

### 3.1 Part 2：putMlsSession 护栏写轮换基线（治标，一处改动覆盖所有新建路径）

**改动点：`DmeStorage.putMlsSession`（双端同名文件）**

```ts
async putMlsSession(groupId: string, serialized: string): Promise<void> {
  // 护栏：本设备首次持久化该会话时，同步写轮换基线 = now。
  // 判据是"会话记录不存在"而非"rotationAt 记录不存在"：
  //  - 轮换失败回滚、日常更新等路径会话记录已存在 → 不触发，保住
  //    "投递失败下个周期自然重试"语义（§5 边界 3）；
  //  - 备份恢复路径随后会用备份值显式覆盖（AppContext.tsx:1161），终值正确。
  const existed = (await this.getMlsSession(groupId)) !== null;
  if (!existed) await this.setLastRotationAt(groupId, Date.now());
  await storage.setItem(...); // 原有逻辑不变
}
```

**否决过的备选**：显式 `registerNewSession()` helper 逐调用点迁移——新建路径散布 ≥4 处且有疑似漏网点，未来新增路径还会漏；存储层护栏一处收口。

### 3.2 Part 1a：现场生成统一改吃 KP 池（v2 新增，用户拍板①）

**改动点：两处现场 `generateKeyPackageForUser` 改为消费池条目**

| 位置 | 现状 | 改后 |
|---|---|---|
| `handshake.ts` acceptQrInvite（~119） | 1v1 Bob 端现场生成 pair → `createAsFounder` | 取池内新鲜 pair（先 refresh 兜底）→ `createAsFounder` |
| `group-invite.ts` createGroupWithMembers（~260） | 群主现场生成 pair → `createAsFounder` | 同上 |

**可行性核对（已确认）**：
- `createAsFounder` 参数即 `KeyPackagePair { publicPackage, privatePackage }`，与池条目两字段完全同构；`generateInviteQr`（~1311）已有"从池反序列化出 pair 直接用"先例。
- 池内 KP 本就是 `generateKeyPackageForUser` 用同一把身份签名钥生成，签名/credential/initKey 全部一致，**无 wire 格式变化、无协议变更、无兼容性问题**。
- 消费即 `markKeyPackageConsumed`；`createAsFounder` 若失败，池位浪费一条由 refresh 补足（纯本地生成不依赖网络，可忽略）。

**改后收益**：`generateKeyPackageForUser` 全库只剩 `refreshKeyPackagePool` 一个调用方——KP 的出生登记（createdAt）收敛到唯一一处，新鲜度管控真正单点收口；建群/握手路径省一次纯 JS 现场生成。

### 3.3 Part 1b：池新鲜度——老化退役 + 消费点过滤（用户拍板②③）

**最大有效期 = 当前设置的轮换周期**（动态值，不再引入独立常量）：

- 语义：叶子密钥总寿命上界 = KP 年龄（≤ 当前周期）+ 基线推迟的一个周期 = **2× 用户选择的暴露窗口**，随设置自动联动，不维护第二个参数。
- 实现：退役与过滤判定即时读 `getKeyRotationIntervalMs()`（本地读，零成本）；用户中途改设置，下次 refresh 按新值退役，无需迁移。
- 注意：是动态判定值，不能在 `mls-config.ts` 落 `const`；`KEYPACKAGE_POOL_SIZE = 5` 维持不变。

**改动点 A：`refreshKeyPackagePool`（AppContext ~542）增加退役 pass**

补货前：
1. 取 PendingInvite 账本，收集所有被 `ownKeyPackagePoolId` 引用的条目 id（**不变量，见 §5.1**）；
2. 遍历池中 `!consumed` 且 `now - Date.parse(createdAt) > 当前周期` 且 id 不在引用集的条目 → `removeKeyPackageFromPool(id)`；
3. 原补货逻辑照旧（补足 5 条）。

**改动点 B：消费点选择条件加新鲜度过滤（防 refresh 与消费之间的窗口）**

- `generateInviteQr`（~1308）：`!e.consumed` → 加 `&& fresh(e)`；
- `respondToGroupInvite` 接受分支（~3114）：同样过滤；
- own-replay 路径（~1883）按 `ownKeyPackagePoolId` 精确取回，**不过滤**（join 必须用同一把）；
- 新增的两个池消费点（§3.2）沿用同一 `fresh()` 判定。

## 4. 兼容性矩阵（逐场景核对）

| 场景 | 行为 | 是否符合预期 |
|---|---|---|
| 新建群（群主，吃池） | 首次 putMlsSession 写基线 = now | ✅ 不再立即轮换 |
| 新建群（成员 joinViaWelcome，吃池） | 同上（各自设备各自基线） | ✅ |
| 新建 1v1（两端，均吃池） | 同上 | ✅ |
| 备份恢复（备份含 rotationAt） | 护栏先写 now，L1161 立即用备份值覆盖 | ✅ 终值正确，时序无害 |
| 备份恢复（旧备份无 rotationAt → 0） | 覆盖为 0 → 立即到期 | ✅ 保留向后兼容设计 |
| 轮换 commit 投递失败回滚 | 会话记录已存在 → 护栏不触发 → 下周期重试 | ✅ 重试语义保留 |
| 升级存量会话（已轮换过） | 有 rotationAt 记录，不受影响 | ✅ |
| 升级存量会话（从未轮换） | 维持 last=0 立即到期（现状） | ✅ 可接受 |
| KP 退役 vs welcome 未到达中间态 | 退役只碰未被 PendingInvite 引用的 unconsumed 条目；被外发过的 pair 必已 consumed 或被引用 | ✅ 无解密依赖破坏 |
| 升级存量 KP 池（旧条目无超龄概念） | 首次 refresh 即按当前周期退役重建 | ✅ 自愈 |
| 兄弟端（多端） | 基线 per-device、池随备份同步，与既有语义一致 | ✅ |

## 5. 边界与已知残余风险

1. **PendingInvite 占用的池 pair 年龄无上界（用户拍板接受）**：邀请发出后长期不处理，该 pair 被预留、不退役、join 时多老都用。对应密钥寿命无 2× 周期上界。**退役排除被引用条目是正确性不变量而非超时特性**——welcome 解密依赖 KP 私钥，删了会复现 2026-10-14 的「welcome 未到达」数学死局。
2. **叶子密钥寿命上界从 ≈周期 变为 ≤ 2× 周期**（正常路径），随用户设置联动；用户知情接受（2026-10-21 拍板）。
3. 护栏判定增加一次 `getMlsSession` 本地读，量级可忽略。
4. 消费点过滤后若池内无新鲜条目（理论窗口）：消费点均先 `refreshKeyPackagePool()`（本地生成、退役 + 补货后必有新鲜条目）；refresh 异常时沿用既有 "no KeyPackage available" 报错路径。

## 6. 实施与验收

**单 commit 落地，双端同步：**

| 文件 | 改动 |
|---|---|
| `src/storage/db.ts`（双端） | putMlsSession 护栏 |
| `src/handshake/handshake.ts`（双端） | acceptQrInvite 改吃池 |
| `src/handshake/group-invite.ts`（双端） | createGroupWithMembers 改吃池 |
| `src/state/AppContext.tsx`（双端） | refreshKeyPackagePool 退役 pass + 消费点新鲜度过滤（含 generateInviteQr / respondToGroupInvite） |
| AGENTS.md（仅 dme-client） | 知识库加"新会话轮换基线与 KP 池统一消费"小节 |

**验收清单：**
1. 双端 tsc 通过；miniapp `mp:build` + `verify-artifact` 冒烟通过。
2. 手测：新建群 / 新建 1v1 → 不出现"过一会轮换"（无 `[dme:rotation] rotated` 日志）。
3. 手测：把某池条目 createdAt 改成超过当前周期 → refresh 后被退役、补足 5 条。
4. 手测：造 pending invite 引用超龄 pair → refresh 不退役它，join 成功。
5. 手测：恢复含 rotationAt 备份 → 到期时间与备份一致；旧备份（无 rotationAt）→ 立即到期。
6. 回归：轮换投递失败路径 → 本地回滚、宣言释放、下周期重试，基线未被护栏篡改。
7. 回归：全库 grep `generateKeyPackageForUser` 仅剩 refreshKeyPackagePool 一个调用方。

## 7. 已拍板 / 遗留

- ~~KP_MAX_AGE 取值~~ → 已拍板：动态 = 设置里的轮换周期。
- ~~PendingInvite 超时~~ → 已拍板：不做，残余风险知情接受（§5.1）。
- 遗留观察项：若未来出现"邀请长期 pending 导致 join 用超龄密钥"的真实案例，再议邀请过期提示（纯 UI，不改密码学）。
