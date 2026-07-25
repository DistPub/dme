# dme-gateway

Cloudflare Worker 反向代理，剥离客户端 IP 后转发到 dme-server。

## 架构

```
Client -> CF Worker (剥离 IP) -> dme-server
```

dme-server 只看到 CF 边缘 IP，看不到客户端真实 IP。

## 开发

```bash
cp wrangler.toml.example wrangler.toml
bun install
bun run dev
bun run deploy
```

## 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/xrpc/dme.batch.get` | 转发到 dme-server 批量查询 |
| GET | `/_health` | 健康检查 |
