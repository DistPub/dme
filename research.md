# DME 与 Bluesky 原生私信功能对比

**调研时间**：2026-07-29  
**对比对象**：DME（Decentralized Message Envelope）与 Bluesky 原生 Direct Messages（截至 2026 年 6 月）

## 核心结论

| 维度 | DME（本项目） | Bluesky 原生 DM |
|---|---|---|
| **加密** | 原生端到端加密（MLS RFC 9420） | 原生无 E2EE； moderation 可调取消息内容 |
| **客户端形态** | 独立 App（Expo + React Native） | 内嵌在 Bluesky 官方 App 中 |
| **1:1 聊天** | 支持 | 支持 |
| **群聊** | 支持，群主管理 | 支持（2026.06 上线），上限 50 人 |
| **媒体/图片** | 不支持 | 暂不支持（官方称需先完善安全系统） |
| **架构** | 去中心化：PDS 记录 + Jetstream + 自建 AppView | 中心化 chat service（`api.bsky.chat`） |
| **身份验证** | DID 文档声明 X25519/Ed25519 双公钥 | 复用 Bluesky 账号，无额外密钥声明 |
| **备份恢复** | PBKDF2+AES-GCM 全量备份到 PDS | 无此概念，依赖官方服务 |
| **内容 moderation** | 平台无法解密，无 moderation | Bluesky moderation 可调取举报消息及上下文 |
| **反垃圾/隐私设置** | 仅支持简单权限 | 可设置谁可发消息/谁可拉进群 |
| **互操作性** | 需双方都安装 DME 客户端 | 所有 Bluesky 用户原生互通 |

## 1. 加密与隐私

**DME** 从设计之初就是 E2EE：
- 使用 MLS（Messaging Layer Security，RFC 9420），密码套件为 `MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519`
- 每个用户在 DID 文档中声明 `#dme_encryption`（X25519）和 `#dme_signing`（Ed25519）公钥
- 消息内容以 MLS 密文写入 PDS，Jetstream 消费后存入 AppView；服务端只存储密文，无法解密
- 握手/建群依赖 X25519 ECDH + QR 码或 1:1 通道交换 KeyPackage

**Bluesky 原生 DM**：
- 官方文档和 safety 账号均确认：原生 DM **不是端到端加密**
- Bluesky moderation 可以在必要时（如调查垃圾、协同骚扰）访问消息内容
- 2025 年 7 月 Bluesky 与第三方 **Germ** 合作，在 Bluesky 个人资料页提供 Germ DM 按钮；Germ 才是基于 MLS 的 E2EE，但需要跳转到 Germ App

## 2. 架构差异

**DME** 是协议层去中心化方案：
- 密文作为 AT Protocol 记录（`dme.queue.envelope`）写入用户自己的 PDS
- AppView（dme-server）通过 Jetstream 监听全网的 envelope 记录，存入 BadgerDB
- 客户端轮询自建 AppView 批量盲查 queueId 获取消息
- 密钥、会话、群聊元数据全部存在本地，支持加密备份到 PDS

**Bluesky 原生 DM** 是服务层方案：
- 通过 `chat.bsky.convo.*` API 访问，请求先打到用户 PDS，再被代理到中心 chat service（`did:web:api.bsky.chat`）
- 消息由 Bluesky 运营的 chat service 存储和投递
- 更像传统社交平台的私信 backend

## 3. 群聊

**DME 群聊**：
- 通过 1:1 MLS 通道发送 `group_invite_request` / `group_invite_response`
- 群主收集 KeyPackage 后创建 MLS 群组并分发 `group_welcome` + `group_commit`
- 群主可 add/remove/dissolve；成员可主动 leave；MLS 限制群主不能 leave，只能解散
- 没有人数上限的硬编码，实际受 MLS 树性能和 KeyPackage 分发复杂度限制

**Bluesky 群聊**：
- 2026 年 6 月随 v1.124 上线，上限 **50 人**
- 群主可管理成员、生成邀请链接
- 用户可设置"谁可以邀请我进群"：所有人 / 仅我关注的人 / 没有人
- 仍走中心化 chat service，无 E2EE

## 4. 媒体与富媒体

- **DME**：目前只支持文本消息
- **Bluesky DM**：目前也仅支持文本、链接、富文本 facet、record embed；图片/视频/文件官方表示"很有价值，但要先建新的安全与 moderation 系统"

## 5. 用户体验与生态

**DME 的优势**：
- 真正的去中心化 + E2EE，平台方无法读取消息
- 身份密钥和群聊元数据可备份恢复，换设备可还原会话
- 不依赖 Bluesky 官方 chat service，理论上可在任何 AT Protocol 客户端/实例运行

**DME 的劣势**：
- 必须单独安装 DME 客户端，双方都用 DME 才能通信
- 没有 Bluesky 的原生 moderation、举报、反垃圾能力
- 握手和群管理流程较重（QR / KeyPackage 交换 / 群主离线即无法加人）

**Bluesky 原生 DM 的优势**：
- 内嵌官方 App，所有 Bluesky 用户原生可达
- 有成熟的隐私设置、举报、 moderation、消息请求箱
- 群聊有邀请链接、人数管理等易用功能

**Bluesky 原生 DM 的劣势**：
- 无原生 E2EE，隐私依赖平台信任
- 中心化 chat service 是单点

## 6. DME 相对于 Bluesky 原生 DM 的缺失功能

只对照 Bluesky 原生私信，DME 还缺失：

| 类别 | 缺失功能 |
|---|---|
| 消息内容 | 富文本 facet、record embed、emoji 反应、消息删除、消息长度限制 |
| 会话与通知 | 已读状态/未读数、消息请求箱、静音会话、离开 1:1 会话、推送通知、批量发消息 |
| 隐私与安全 | 谁可以发消息设置、谁可以拉我进群设置、屏蔽用户、举报消息/用户 |
| 群聊 | 群邀请链接、群人数上限显示、进群邀请请求箱 |
| 发现与新建聊天 | 通过 handle 搜索用户、从 Bluesky 关注列表导入 |

以下功能双方目前都**不支持**，因此不算 DME 相对于 Bluesky 的缺失：
- 端到端加密（Bluesky 原生无，DME 有）
- 图片/视频/文件发送
- 语音消息
- 消息编辑
- 链接预览
- 引用回复某条消息
- 消息转发
- 会话置顶/归档
- 消息搜索

## 一句话总结

DME 相当于"用 AT Protocol 自建的去中心化 Signal/MLS 消息层"，强调 **隐私和去中心化**；Bluesky 原生 DM 则是"传统社交平台私信"，强调 **易用性和 moderation**，但牺牲端到端加密。两者目前都不支持媒体消息，群聊能力都已具备。
