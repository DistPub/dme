# AGENTS.md

- 输出或提示优先用中文。
- 开始回答前先说"帅哥是这样的"

---

# dme-client

Expo ~52 + React Native + @shopify/react-native-skia 移动 App。TypeScript strict，Bun 管理。

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
    ├── handshake/        # handshake.ts / invite.ts / qr-encode.ts / qr-decode.ts
    ├── poll/poller.ts    # 5-15s 随机间隔轮询 + LRU 去重 + 批量预计算 future queueId
    ├── storage/db.ts     # AsyncStorage，key 前缀 dme:<did>:
    ├── state/AppContext.tsx  # 全局状态（12 字段，11 action）
    ├── protocol/         # types.ts + lexicons/ JSON
    ├── ui/               # 11 个文件（7 屏幕 + 4 组件）
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
| 改设置页 | `src/ui/SettingsScreen.tsx` |

## 导航流程

```
Login → (restoreSession) → Setup → ChatList ⇄ ChatView
                              ↘ QrDisplay（邀请）
                              ↘ QrScan（接受邀请）
                              ↘ Settings（选项）
```

Web 支持 `?goto=QrDisplay|QrScan|ChatList|Settings` 和 `?auto=1`、`?token=` 查询参数。

## 约定

- **加密**: MLS (RFC 9420) 替换旧 Double Ratchet + X3DH。使用 ts-mls 库 + @noble 系列。
- **身份密钥**: 每个用户拥有 Ed25519（签名/MLS 凭证）+ X25519（KeyPackage 加密）双密钥对
- **DID 文档**: `#dme_encryption`(X25519) 加密 KeyPackage + `#dme_signing`(Ed25519) 验证 MLS 凭证
- **KeyPackage**: 不上 PDS，通过 QR 点对点传递，用接收方 X25519 公钥加密
- **握手**: Alice 加密 KeyPackage -> QR -> Bob 扫码 -> 创建 MLS 群组 -> Welcome 走盲查通道
- **状态管理**: 每字段一个 `useState` 的 React Context（非 useReducer），11 个 `useCallback` action
- **chatListVersion**: 单调计数器，storage 变化时递增触发 UI 刷新
- **屏幕模式**: `<View>` → 绝对定位 `<Canvas><Fill/></Canvas>` → flexbox 内容（RN Text/TextInput/SkiaButton）
- **阶段机**: 每个屏幕用联合类型 `Phase` 控制条件渲染
- **Skia 范围**: 仅 `SkiaButton`（Canvas + RoundedRect + Text + GestureDetector）和屏幕背景填充
- **字体**: `FontProvider` 一次性加载 Roboto-Regular.ttf，`useAppFont(size)` 返回 SkFont
- **主题**: `theme.ts` 单一 `as const` 对象，暗色（#0a0a0a），无切换
- **命名导出**: 统一 `export function/class`，无 default export（除 App.tsx）
- **轮询**: 每 5-15s 随机间隔，批量预计算 `batchSize`（默认 3，1-20 可配置）个未来 queueId，按 generation 排序处理

## 注意事项

- **无 Expo Router**: 用手动 `NavigationContainer` 而非文件路由，无 `app/` 目录
- **MessageBubble 非 Skia**: 实际用原生 RN View/Text，非 Skia Canvas 渲染
- **RootStackParamList**: 集中定义在 `src/types/navigation.ts`，App.tsx 和各屏幕从此 import
- **secretTree 索引**: ts-mls 的 SecretTree 按树位置索引（0=leaf0, 1=parent, 2=leaf1），`getExpectedGeneration` 内部用 `leafIndex * 2`