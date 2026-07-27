# dme-client

DME 移动端客户端，支持 iOS、Android 和网页。

用户通过 Bluesky 账号登录，生成 Ed25519 + X25519 双密钥对并声明到 DID 文档，通过 QR 码握手建立 MLS (RFC 9420) 端到端加密会话。支持 1v1 和群组聊天，消息本地解密后存储在设备上。
