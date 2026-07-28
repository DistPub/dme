# AGENTS.md

- 输出或提示优先用中文。
- 开始回答前先说"帅哥是这样的"

---

# dme-client

Expo ~52 + React Native + @shopify/react-native-skia 移动 App。TypeScript strict，Bun 管理。支持 1v1 和群组聊天。

## 结构

```
dme-client/
├── index.js              # 原生入口 (registerRootComponent)
├── index.web.js          # Web 入口（Skia WASM 异步预加载）
├── App.tsx               # 导航根 + Provider 栈
├── package.json          # @dme/client
├── tsconfig.json         # extends expo/tsconfig.base, strict:true
├── app.json              # scheme:dme, dark, 3 平台
├── metro.config.js       # unstable_enablePackageExports（@atproto/identity 需要）
└── src/
    ├── config.ts         # PDS_URL, DME_SERVER_URL, PLC_DIRECTORY_URL, 轮询间隔
    ├── crypto/           # MLS 加密模块（见 crypto/AGENTS.md）
    ├── atproto/          # session.ts / pds.ts / did.ts
    ├── handshake/        # handshake.ts / invite.ts / qr-encode.ts / qr-decode.ts / group-invite.ts
    ├── poll/poller.ts    # 5-15s 随机间隔轮询 + LRU 去重 + 批量预计算 future queueId
    ├── storage/db.ts     # AsyncStorage，key 前缀 dme:<did>:
    ├── state/AppContext.tsx  # 全局状态（15 字段，19 action）
    ├── protocol/         # types.ts + group-message.ts + lexicons/ JSON
    ├── ui/               # 14 个文件（9 屏幕 + 5 组件）
    └── types/            # navigation.ts (RootStackParamList) + qrcode.d.ts
```

## 快速定位

| 任务 | 位置 |
|---|---|
| 添加新屏幕 | `src/types/navigation.ts` 加路由 + `src/ui/` 新文件 |
| 修改全局状态 | `src/state/AppContext.tsx` |
| 改轮询逻辑 | `src/poll/poller.ts` |
| 改存储 key | `src/storage/db.ts` |
| 改 PDS/DID 交互 | `src/atproto/` |
| 改主题 | `src/ui/theme.ts` |
| 加新加密操作 | `src/crypto/`（见 crypto/AGENTS.md） |
| 改身份备份 | `src/crypto/backup.ts`（PBKDF2+AES-GCM 加密/解密 FullBackupData） |
| 改按钮组件 | `src/ui/Button.tsx`（Pressable+Text，支持中文） |
| 改设置页 | `src/ui/SettingsScreen.tsx` |
| 群聊消息类型 | `src/protocol/group-message.ts` |
| 群聊邀请协议 | `src/handshake/group-invite.ts` |
| 创建群聊 UI | `src/ui/CreateGroupScreen.tsx` |
| 群管理 UI | `src/ui/GroupSettingsScreen.tsx` |

## 导航流程

```
Login → (restoreSession) → Setup → ChatList ⇄ ChatView
                              ↘ QrDisplay（邀请）
                              ↘ QrScan（接受邀请）
                              ↘ CreateGroup（建群 / 邀请新成员）
                              ↘ GroupSettings（群管理）
                              ↘ Settings（选项）
```

Web 支持 `?goto=QrDisplay|QrScan|ChatList|Settings` 和 `?auto=1`、`?token=` 查询参数。

## 约定

- **加密**: MLS (RFC 9420) 替换旧 Double Ratchet + X3DH。使用 ts-mls 库 + @noble 系列。
- **身份密钥**: 每个用户拥有 Ed25519（签名/MLS 凭证）+ X25519（KeyPackage 加密）双密钥对
- **DID 文档**: `#dme_encryption`(X25519) 加密 KeyPackage + `#dme_signing`(Ed25519) 验证 MLS 凭证
- **KeyPackage**: 不上 PDS，通过 QR 或1:1通道点对点传递，用接收方 X25519 公钥加密
- **握手**: Alice 加密 KeyPackage -> QR -> Bob 扫码 -> 创建 MLS 群组 -> Welcome 走盲查通道
- **群聊邀请**: 通过已有1:1 MLS 通道传输 JSON 消息（group_invite_request/response/welcome/commit 等）
- **群聊 Commit**: addMember 产生的 Commit 通过1:1通道发给已有成员（poller 只轮询 application 消息）
- **状态管理**: 每字段一个 `useState` 的 React Context（非 useReducer），19 个 `useCallback` action
- **chatListVersion**: 单调计数器，storage 变化时递增触发 UI 刷新
- **屏幕模式**: `<View>` -> 绝对定位 `<Canvas><Fill/></Canvas>` -> flexbox 内容（RN Text/TextInput/Button）
- **阶段机**: 每个屏幕用联合类型 `Phase` 控制条件渲染
- **Skia 范围**: 仅屏幕背景 `<Canvas><Fill/></Canvas>` 用 Skia；按钮用原生 `Button`（Pressable+Text）
- **字体**: `FontProvider` 一次性加载 Roboto-Regular.ttf，`useAppFont(size)` 返回 SkFont
- **主题**: `theme.ts` 单一 `as const` 对象，暗色（#0a0a0a），无切换
- **命名导出**: 统一 `export function/class`，无 default export（除 App.tsx）
- **轮询**: 每 5-15s 随机间隔，批量预计算 `batchSize`（默认 3，1-20 可配置）个未来 queueId，按 generation 排序处理
- **消息类型**: `StoredMessage.kind` 区分 `text`/`group_invite`/`group_system`；`conversationId` 指定存储到哪个会话
- **身份备份**: `backup.ts` 用 PBKDF2-SHA256(100k iter)+AES-256-GCM 加密 FullBackupData（身份密钥+MLS会话+KeyPackage池+群聊元数据），存 PDS `dme.backup.identity` record（rkey=self）。Settings 页设密码备份，Setup 页检测到 DID 有 key 但本地不匹配时提供恢复入口
- **did:web 支持**: did:web 用户无法 PLC 操作，Setup 页 `web_instructions` step 提供 did.json 全文（DME 新增部分绿色高亮）供用户手动更新后点「检测」验证
- **AsyncStorage v3 web API**: `@react-native-async-storage/async-storage` v3 在 web 端只导出 `getItem`/`setItem`/`removeItem`/`getAllKeys`/`clear`/`getMany`/`setMany`/`removeMany`，**没有** v2 的 `multiRemove`/`multiGet`/`multiSet`。批量操作须用 `Promise.all(keys.map(k => AsyncStorage.removeItem(k)))` 等替代，禁止直接调 `AsyncStorage.multi*`（web 会抛 `TypeError: ... is not a function`，native 正常）

## 注意事项

- **无 Expo Router**: 用手动 `NavigationContainer` 而非文件路由，无 `app/` 目录
- **MessageBubble 非 Skia**: 实际用原生 RN View/Text，非 Skia Canvas 渲染
- **SkiaButton 已废弃**: 所有屏幕改用 `Button.tsx`（Pressable+Text，支持中文），`SkiaButton.tsx` 保留但无引用
- **RootStackParamList**: 集中定义在 `src/types/navigation.ts`，App.tsx 和各屏幕从此 import
- **secretTree 索引**: ts-mls 的 SecretTree 按树位置索引（0=leaf0, 1=parent, 2=leaf1），`getExpectedGeneration` 内部用 `leafIndex * 2`
- **群主不能离开**: MLS 禁止 removeMember 移除 committer，群主只能解散群组
- **群组只读状态**: dissolved/removed/left 标记后群组变为只读，保留消息但禁止发送
