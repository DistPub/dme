/**
 * DME Gateway — Cloudflare Snippets 版（请求阶段极简版）
 *
 * 核心原则：snippet 只做「请求前的改写与转发」，改完立刻 return。
 * 响应侧的 CORS 头、blob 缓存、OPTIONS 预检全部交给 Cloudflare 原生规则
 * （Response Header Transform Rules / Cache Rules / Return Fixed Response），
 * 不在 snippet 里做任何响应包装 —— 这样 CPU 占用只有 URL 字符串拼接，
 * 远低于 Snippets 5ms/请求 的限制，大 blob 转发也是零拷贝流式透传。
 *
 * 平台限制与规避：
 *   - 无 env 绑定      → DME_SERVER_URL 硬编码为常量
 *   - 无 caches API    → 缓存交给 Cache Rules（Edge TTL）
 *   - 无 ctx.waitUntil → 已不需要（无异步缓存写入）
 *   - 不继承客户端 header → 只显式带 Content-Type（保持原 Worker 版「剥离客户端标识」语义）
 *
 * 依赖的 CF 规则（在 Dashboard 配置，见 README）：
 *   1. Response Header Transform Rules → 统一加 CORS 响应头（作用于 snippet 返回的
 *      所有响应，包括 OPTIONS 的 204 和 /_health 的 200）
 *   2. Cache Rules → /xrpc/dme.file.blob 设 Edge TTL
 * （OPTIONS 预检不依赖外部规则，snippet 内直接返回 204 空响应）
 */

const DME_SERVER_URL = "https://dme-server.example.com"; // TODO: 改为实际 dme-server 地址

export default {
  async fetch(request) {
    const url = new URL(request.url);

    // 预检：构造空响应直接返回（常数时间，几乎零 CPU）；CORS 头由 CF
    // Response Header Transform Rules 统一补到这个 204 上。
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204 });
    }

    // 健康检查：一行返回，不触碰代理链路
    if (url.pathname === "/_health") {
      return new Response("ok");
    }

    // 盲查转发：改写目标 URL，body 以流原样透传，响应直接 return（不读、不包）
    if (url.pathname === "/xrpc/dme.batch.get" && request.method === "POST") {
      const target = resolveServer(request) + "/xrpc/dme.batch.get";
      return fetch(new Request(target, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: request.body,
      }));
    }

    // blob 代理：参数拼装后转发到 PDS，响应直接 return（缓存交给 Cache Rules）
    if (url.pathname === "/xrpc/dme.file.blob" && request.method === "GET") {
      const pds = url.searchParams.get("pds");
      const did = url.searchParams.get("did");
      const cid = url.searchParams.get("cid");
      if (!pds || !did || !cid) {
        return new Response("Missing required params: pds, did, cid", { status: 400 });
      }
      return fetch(
        pds + "/xrpc/com.atproto.sync.getBlob?did=" +
          encodeURIComponent(did) + "&cid=" +
          encodeURIComponent(cid),
      );
    }

    // 兜底：透传到 origin（正常由 snippet 匹配规则限定路径，不会走到这）
    return fetch(request);
  },
};

// 允许请求头 dme-server 动态覆盖目标 server（便于多 server 部署 / 测试）
function resolveServer(request) {
  const headerUrl = request.headers.get("dme-server");
  if (headerUrl) {
    try {
      new URL(headerUrl);
      return headerUrl.replace(/\/$/, "");
    } catch (e) {
      // 非法 header，忽略并回落到默认地址
    }
  }
  return DME_SERVER_URL;
}
