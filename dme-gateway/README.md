# dme-gateway

DME 网关，部署在 Cloudflare 边缘节点。

客户端的消息查询请求先到达网关，网关转发请求到服务端，服务端只能看到 Cloudflare 的边缘 IP 而非客户端真实地址，从而保护用户隐私。
