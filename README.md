# DME (Decentralized Message Envelope)

基于 Bluesky (AT Protocol) 的 MLS (RFC 9420) 端到端加密私信系统。

用户用 Bluesky 账号登录，通过 QR 码握手建立 MLS 加密会话，消息加密后写入 Bluesky PDS，经服务端索引后由收件人轮询拉取并本地解密。支持 1v1 和群组聊天。

三个独立系统：

- **dme-client** — 手机/网页客户端，负责身份管理、MLS 加解密、握手和收发消息
- **dme-server** — 服务端，实时监听 Bluesky 上的加密消息并暂存，供客户端批量查询
- **dme-gateway** — 网关代理，隐藏客户端真实 IP 后转发请求到服务端
