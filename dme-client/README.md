# dme-client

TypeScript Web App for DME.

## 模块

- `src/crypto/identity.ts` — 身份密钥生成（WebCrypto），DID 公钥声明
- `src/crypto/ratchet.ts` — Double Ratchet 加密状态机
- `src/atproto/session.ts` — atproto OAuth 登录 + 会话管理
- `src/atproto/pds.ts` — PDS 记录创建（dme.queue.envelope）
- `src/atproto/firehose.ts` — 大洪水订阅（监听握手包裹）
- `src/poll/poller.ts` — 定时轮询，OHTTP 盲化请求
- `src/handshake/qr.ts` — 加密二维码生成/扫描
- `src/ui/` — 聊天界面

## 开发

```bash
bun install
bun run dev
```
