# DME (Decentralized Message Envelope)

基于 AT Protocol 的端到端加密私信协议。三个独立系统，各自独立构建部署：

```
dme/
├── dme-client/     Expo App - 身份、加解密、握手、轮询
├── dme-server/     Go 服务 - AppView，订阅 firehose + KV 暂存 + 批量盲查
└── dme-gateway/    Cloudflare Worker - OHTTP 盲化代理
```

各系统独立管理依赖，无共享配置。详见各子目录 README。
