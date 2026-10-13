# 密钥安全升级计划：ts-mls 1.6.4 + 定期密钥轮换

> **进度（2026-10-14 实施完毕，待用户手动测试）：**
> - ✅ Phase 0：双端 ts-mls 1.6.4（client: bun.lock；miniapp: 精确锁）+ tsc/构建/verify-artifact 全过 + 踢人效力代码级确认。已上传体验版 0.0.1。发布协调（同批发版/渗透期冻结群管理/补踢）待用户执行。
> - ✅ Phase 1（dme-client）：1.0 投递修复（commit-delivery.ts，群 commit 改走群 queueId 空间）+ rotation.ts（单飞锁/抖动/pre-poll/失败回滚）+ password-cache（native Keychain via expo-secure-store ~14.0.1 / web 会话内存）+ 备份联动（轮换后静默刷备份或 backupRequired 强提示）+ 检测分流（sibling-rotated / desynced，持久化 sessionIssue）+ 设置页三档选择器 + ChatList 横幅 + i18n。
> - ✅ Phase 2（miniapp）：同名模块移植（password-cache 仅会话内存——小程序无系统安全区）、设置页/横幅/i18n、AGENTS.md 解冻标注（仅安全例外）。
> - 实现与计划的偏差：①"确定性错峰按 leafIndex"未实现——触发时刻随设备回前台自然错开，仅用 0–2min 随机抖动（原 ±10% 周期会把轮换拖到到期后数小时）；②兄弟设备检测复用 commit wrapper 本身（group_commit 应用失败且 sender==自己），未单独发 rotation-notice 信封（wrapper 即 notice，少一种信封类型）；③轮换触发：client 启动 60s 后/回前台(AppState)/每 30min，miniapp 启动 60s 后/每 30min（页面可经 runRotationCheck 在 useDidShow 补充触发）。

> 2026-10-13 立项。背景分析见当日讨论（摘要见下）。
> 范围：dme-client（RN + web）+ dme-miniapp。**miniapp 冻结规则本次因安全修复由用户授权解除**，实施时需同步更新 AGENTS.md 的冻结标注。
> **测试约定：不做自动化 QA，功能测试由用户手动进行**；开发侧只需保证 tsc 通过、构建通过，并在计划中列出「用户手动测试要点」供参照。

---

## 背景（为什么做）

1. **ts-mls 1.6.2 的 commit 全部不带 update path**（`clientState.js:460` 的 `>1` 条件，1.6.3 已修为 `>0`）：
   - commitSecret = 全零 → epoch 换代零熵；
   - **踢人无密码学效力**：被踢者用旧 state 可推导新 epoch 全部密钥，继续解密；
   - 快照攻击者可无限跟随所有 epoch。
2. **无自动密钥轮换**：`updateOwnLeaf()` 存在但零调用。1v1 epoch 自握手后永久冻结，一次 state 快照泄漏 = 全历史回溯 + 未来消息全裸，直到重新握手。群聊只靠加人/踢人"顺便"换代——而换代本身又是零熵的（见上）。
3. **混版本互操作性**：1.6.4 改了 commitSecret 推导，1.6.2 与 1.6.4 客户端对同一 commit 会分叉。若只升 dme-client 不升 miniapp，跨端群必坏 → miniapp 必须同步升级。
4. 1.6.4 还附带 `selfRemoved` 优雅处理（被踢端不再推进私钥路径）与 `blankStructuralDirectPath`（path 构造 spec 合规）。

---

## Phase 0：ts-mls 1.6.2 → 1.6.4（前置，独立可发布）

### dme-client
- [ ] `bun update ts-mls`（lockfile 1.6.2 → 1.6.4；`package.json` 已是 `^1.6.2` 无需改）
- [ ] 核对 API 兼容：DME 用到的 `createGroup / joinGroup / createCommit / createApplicationMessage / processMessages` 签名在 1.6.4 未变（已初步 diff 确认，实现时以 tsc 全量通过为准）
- [ ] tsc 通过 + 构建通过；功能回归由用户手动测试（要点：1v1 握手、建群、加人、踢人、解散、收发、备份恢复）
- [ ] 踢人效果代码级确认：1.6.4 下 removeMember 的 commit 携带 update path、被踢端走 `removedFromGroup`（读代码/assert 确认，行为由用户实测）
- [ ] `selfRemoved` 用户体验：确认被踢端 UI 走现有 `group_member_removed` 提示，无异常报错

### dme-miniapp
- [ ] `package.json` `ts-mls": "1.6.2"` → `"1.6.4"`（注意：原为精确锁定；1.6.4 仍属 1.x，符合"锁定 1.x 禁止 2.x"约定）
- [ ] 构建管线全链路通过：`taro build → es5ify.mjs → strip-hpke-dead-code.mjs → verify → inject-polyfills.mjs`（重点：es5ify 对 1.6.4 新增代码的可选链/空值合并降级）
- [ ] `verify-artifact.mjs` 产物自检通过；真机功能测试由用户进行（合法域名白名单不变）

### 发布协调（Phase 0 的硬约束）
- [ ] 双端同批发版，等待渗透；
- [ ] **渗透完成前冻结所有群管理操作**（踢人/拉人/解散）——混版本 commit 会分叉；
- [ ] 渗透完成后**补踢历史被踢成员**：升级前被无 path commit 踢掉的人密码学上从未离场，需用新版重新踢一次才算真踢掉（运维清单项；若产品无踢人记录则逐群人工核对）。

---

## Phase 1：定期密钥轮换（dme-client）

### 1.0 前置核实（spike，先行）
- [ ] **commit 投递路径隐患核实**：`removeMemberFromGroup`（AppContext.tsx:2538）用 `poller.getSession(member.did)` 取"成员会话"——session 表以 groupId 为键，groupId 是随机 id（`mls-session.ts:79`），仅当与该成员恰有 1v1 会话（groupId=对方 DID）时才命中，否则静默 `continue`。疑似既有 bug。轮换功能依赖同一条投递路径，必须先查清：群 commit 的实际送达机制、无 1v1 会话的成员如何补投。若确认为 bug，本计划内修复（改为群 session 加密投递或建立成对投递保证）。

### 1.1 设置项
- [ ] `SettingsScreen` 新增「密钥轮换周期」选择器：**24 小时 / 7 天（默认）/ 30 天——不提供关闭项**（安全不设退出，用户拍板）
- [ ] 持久化：`storage/db.ts` 新增 key（如 `keyRotationIntervalMs`，默认 7 天）
- [ ] i18n 文案（中英，`translations.ts`）

### 1.2 备份密码记忆（新机制，轮换联动的前提 —— 存储位置是前向安全的前提）
> **安全约束（2026-10-14 拍板）**：密码**绝不能落在与会话状态同层的可快照存储**（localStorage / AsyncStorage 文件）。否则快照攻击者 = 拿到 state + 密码 → 可永远恢复最新自动刷新的备份 → 链式跟随所有轮换，Phase 1 的前向安全目的整体失效。

- [ ] **native（iOS/Android）**：`expo-secure-store` 存系统安全区（Keychain / Keystore），key 如 `backupPasswordCache`。文件快照拿不到。
- [ ] **web（含 embed 模式）**：无系统安全区 → **会话内存缓存**（模块级变量，不落盘）；app 重启后首次备份/恢复需重输一次密码。
- [ ] 记住时机（成功即存、覆盖旧值）：
  1. `backupIdentity(password)` 成功后（SettingsScreen / ChatListScreen 两个调用点）；
  2. `restoreIdentityFromBackup(password)` 成功后（恢复也是输过密码的，用户拍板同样记住）；
- [ ] 清除时机：登出（logout）时删除缓存（Keychain 条目 + 内存），换账号不残留。
- [ ] i18n：无缓存时的强提示文案 + web 端"重启后需重输"的说明。

### 1.3 轮换执行器（新模块 `src/crypto/rotation.ts`）
- [ ] 触发时机：app 启动 / 回前台 / 每个轮询周期顺带检查
- [ ] 每会话持久化 `lastRotationAt`（storage）；到期条件 `now - lastRotationAt >= interval`
- [ ] 单会话轮换流程：
  1. 前置检查：poller 空闲（无 in-flight）、会话无解密失败积压（粗略"已追平"判定）；
  2. `updateOwnLeaf()` 取 `commitMessage`；
  3. 包装 `{type:'group_commit', groupId, commitPayload}`，按现有 commit 投递路径发给所有成员（1v1 即对端）；
  4. 本地 `putMlsSession` + 更新 `lastRotationAt`；
  5. **rotation-notice**：向自己的队列投一条**明文、零密钥内容**的通知信封 `{type:'rotation-notice'}`（规格见 1.6）。**安全红线：任何情况下不得把新 state（或任何密钥材料）经旧状态可解的信道分发**——兄弟设备的全部密钥就是攻击者的战利品，自动分发密钥材料 = 前向安全失效（2026-10-14 翻案结论）。
- [ ] 收端零改动：`group_commit` 处理路径（AppContext.tsx:1325）用 `session.decrypt` 应用任意 commit，1v1（groupId=对端 DID）与群聊通用。**注意核实加密 epoch 顺序**：committer 在 `removeMember`（state 已推进）之后才加密 commit 信封——收端处于旧 epoch 能否解开，需 spike 确认（MLS 语义上 commit 信封应加密于 pre-commit epoch；若现状依赖某种隐式顺序，轮换实现必须保持一致）。

### 1.4 并发与竞态防护（关键，MLS 同 epoch 单 committer 约束）
- [ ] **确定性错峰 + 随机抖动**：周期窗口内按 `H(leafIndex ‖ groupId) % window` 计算各成员的偏移触发时刻，避免两个**不同成员**同时 self-update（后者 commit 基于 stale epoch 会分叉）。注意：同叶多端设备的确定性偏移完全相同，必然同时触发——须在确定性偏移之上再加**随机抖动**（如 ±10% 周期），且 commit 创建前先 poll 一轮，消费可能已存在的兄弟设备 commit；
- [ ] **单飞锁**：同一会话轮换进行中不重复触发；
- [ ] **desync 检测与分类兜底**：`group_commit` 应用失败目前只 log（AppContext.tsx:1335，静默吞掉、用户无感知）——升级为标记会话 desynced + UI 提示，并按场景分流（标记与提示均为本计划新增，现状没有这套逻辑）：
  - **同账号兄弟设备（同叶）掉队** → 提示**恢复最新备份**：密码已记忆（1.2），复用现有恢复流程即可拿到轮换后新状态，比重握手干净（重握手按 DID 操作会牵连同 DID 的其他设备）；
  - **普通成员掉队** → 提示重新握手（群聊 remove+add / 1v1 重扫 QR，对应 2026-10-13 讨论的收敛结论：手动触发 resync）；
- [ ] 1v1 兜底：commit 应用失败的最终兜底 = 重扫 QR 重握手（成本低，可接受）。

### 1.5 与备份联动（依赖 1.2 的密码记忆）
- [ ] 轮换成功后，在**同一次轮换流程内**收尾：
  - 有缓存密码（native Keychain 常驻 / web 本次会话内存）→ 静默调用 `backupIdentity(缓存密码)` 刷新 PDS 备份（失败仅 log，不阻塞轮换结果，下个周期自然重试）；
  - 无缓存 → 置 `backupRequired=true` 持久标记 + UI 强提示（Settings 页 banner / ChatList 顶部提示）："密钥已自动轮换，现有备份已过期，必须立即备份"——用户完成一次备份后清除标记；
  - 从未备份过的用户同样命中无缓存分支：提示语义改为"必须备份了"（用户拍板：没备份过也要在轮换后强制提示）。
- [ ] 不把密码写进备份本体、不随任何同步数据出设备。

### 1.6 同账号多端支持（notice + 密码门恢复；2026-10-14 翻案定稿）

**背景**：备份恢复的多端模型是几台设备共享同一身份、同一叶子节点、同一份会话状态。轮换 commit 是第一种兄弟设备解不开的 commit：新熵只在轮换设备本地现场生成，path 密文只发给其他成员（PCS 的协议级不对称）——兄弟设备持有一模一样的旧状态却拿不到新密钥材料。**不处理的话，任一设备轮换一次，其余同账号设备全部脱钩。**

**密码学结论（为什么不做自动状态同步）**：兄弟设备的全部密钥 = 攻击者的战利品，两者不可区分。任何把新 state 经"旧状态可解信道"分发的机制（如曾设计的 HKDF(旧叶私钥) 加密信封），快照攻击者同样能解，且可**链式跟随**后续所有轮换——自动密钥分发与前向安全不可兼得。新密钥材料只能来自旧状态之外的熵：用户密码、设备间当面 QR、或只留在轮换设备本地。

**方案：零密钥 rotation-notice + 密码门恢复**
- **notice**：轮换设备向自己队列投一条明文 `{type:'rotation-notice'}` 信封（**不含任何密钥材料**）。兄弟设备在旧队列空间轮询必然扫到 → UI 提示"账号密钥已轮换，请恢复备份"→ 走**现有恢复流程**（1.2 密码缓存：native 无感 / web 重输一次）拿到新状态对齐。恢复后新 epoch 消息在 7 天 TTL 内可拉回，损失窗口小；
- 单设备账号同样会发/收 notice（发端无法知道是否存在兄弟设备）——单设备用户侧静默处理或展示为可忽略的轻提示；
- **元数据代价**：server 可得知轮换事件时序（不含密钥内容，量级与 lexicon 预留的 ratchetEpoch 字段相同，接受）；
- **检测兜底**：兄弟设备离线超 TTL 错过 notice → 落入 1.4 desync 的"提示恢复备份"路径；
- **链断裂救援**：若任何信道曾泄漏过一次状态链，QR 设备间当面重配对（本机显示当前 state 二维码 / 对方扫码导入）可重置链条。v1 记录为手动应急路径，不做自动化。

**备份联动**：只有轮换设备刷新备份（1.5）；兄弟设备经密码门恢复对齐，无需各自备份，多端写备份的 last-write-wins 问题消失。

**明确不做（future）**：每设备独立叶子（device as separate MLS member）才是正统多端模型，但涉及成员语义重构（按 DID 踢人牵连多设备、每设备单独 Welcome 分发等），另行规划。

### 1.7 用户手动测试要点（开发侧仅保证 tsc/构建通过）
- 两台设备：一方到期自动轮换 → 双方消息收发正常、epoch 对齐
- 群聊：某成员轮换后，其余成员正常收发、未参与者无感
- 两端同时到期的错峰行为（可把周期临时调到 24h 观察日志）
- 设置只有 24h/7天/30天 三档，无关闭项
- 密码记忆：手动备份一次 → 下次轮换后无需输入，备份自动刷新（PDS 上 backup record 的 createdAt 更新）
- 从备份恢复输入密码 → 轮换后同样自动刷新
- 从未备份过 → 轮换后出现强制备份提示，完成备份后提示消失
- 登出后密码缓存清除（换账号不会被旧密码误刷）
- 轮换后手动备份 → 恢复 → 收发正常
- 同账号两台设备（均从备份恢复）→ 一台到期轮换 → 另一台收到 rotation-notice → 提示恢复备份 → 恢复后对齐、收发正常
- 多端场景备份只由轮换设备刷新；另一台经密码门恢复，无需各自备份
- native：密码入 Keychain 后，拷贝应用沙盒文件拿不到密码；web：重启后首次备份/恢复需重输一次
- 兄弟设备离线超过 7 天 → 上线后经 desync 提示恢复备份 → 恢复后对齐
- 群聊中无关成员不受 rotation-notice 影响（不重试、无报错）

---

### Phase 2：miniapp 同步实现

- [ ] `rotation` 模块移植（复用 dme-client 同名实现，适配 `src/platform/` storage 层），**含备份密码记忆（miniapp 无系统安全区 → 会话内存缓存）、轮换后自动备份、rotation-notice（同 1.2/1.5/1.6，三档无关闭项）**
- [ ] miniapp `settings` 页新增周期选择器 + i18n
- [ ] 构建管线全链路通过 + `verify-artifact.mjs` 自检；真机功能测试由用户进行
- [ ] **AGENTS.md 解冻标注**：dme-miniapp 章节注明"2026-10 安全例外：ts-mls 升级与密钥轮换由用户授权恢复维护"，顶部冻结规则同步措辞

---

## 发布顺序（严格串行）

1. **Phase 0 双端发版**（1.6.4）→ 协调渗透，期间冻结群管理操作；
2. 渗透完成 → 补踢历史被踢成员；
3. **Phase 1 dme-client 轮换**发版（默认 7 天）——必须等渗透完成，否则 1.6.2 端应用不了轮换 commit；
4. **Phase 2 miniapp 轮换**发版。

---

## 风险清单

| 风险 | 缓解 |
|---|---|
| 混版本 commit 分叉（最大） | Phase 0/1 严格串行发版 + 渗透期冻结群管理操作 |
| 并发 self-update 竞态 | 确定性错峰 + 随机抖动 + commit 前 poll + 单飞锁 + desync 检测兜底 |
| **同叶兄弟设备解不开轮换 commit（必然发生，非竞态）** | rotation-notice（零密钥）提示 → 密码门恢复备份（1.6）；离线超 7 天走 desync 兜底（1.4） |
| rotation-notice 明文信封向 server 泄漏轮换时序 | 不含密钥材料，仅 epoch 事件时序，量级与 lexicon 预留的 ratchetEpoch 字段相同；接受 |
| **密码缓存落入可快照存储 → 快照攻击者永远恢复最新备份、链式跟随（FS 整体失效）** | native Keychain/Keystore（expo-secure-store）；web/miniapp 仅会话内存；登出清除；实现时 code review 红线（1.2） |
| commit 投递的 1v1-session 依赖（疑似既有 bug） | Phase 1.0 spike 先核实并修复 |
| miniapp ES5 管线对 1.6.4 代码不兼容 | 构建验证前置，必要时 es5ify 规则补充 |
| 轮换增加 poller 查询量 | 每 commit 后 queueId 空间变化，查询量与轮换频率线性相关；7 天默认下可忽略；server 零改动 |

## 明确不在本次范围

- PDS 直读 resync / ratchetEpoch 跳代 / 自动检测脱钩（另立计划）
- external commit
- 每设备独立叶子（正统多端模型，见 1.6 末尾）
- web/miniapp 端的系统级安全存储（平台无 Keychain 等价物；web 用会话内存、miniapp 用会话内存缓解，见 1.2）
- 与 `unified-envelope-plan.md` 大重构的适配（若该重构落地，rotation 模块需跟随调整；两者不冲突）
