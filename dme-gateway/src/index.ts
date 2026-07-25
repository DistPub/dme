/**
 * DME Gateway - 反向代理，剥离客户端 IP，转发到 dme-server。
 *
 * 不实现 OHTTP/HPKE 加密层。职责单一：
 *   1. 收到客户端请求
 *   2. 剥离所有客户端标识 header（IP、User-Agent 等）
 *   3. 转发 body 到 dme-server
 *   4. 返回响应
 *
 * dme-server 只看到 CF 边缘 IP，看不到客户端真实 IP。
 */

interface Env {
  DME_SERVER_URL: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/_health') {
      return new Response('ok', { status: 200 });
    }

    if (url.pathname === '/xrpc/dme.batch.get' && request.method === 'POST') {
      return proxy(request, env);
    }

    return new Response('Not Found', { status: 404 });
  },
};

async function proxy(request: Request, env: Env): Promise<Response> {
  const body = await request.arrayBuffer();

  const serverResponse = await fetch(env.DME_SERVER_URL + '/xrpc/dme.batch.get', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });

  const responseBody = await serverResponse.arrayBuffer();
  return new Response(responseBody, {
    status: serverResponse.status,
    headers: { 'Content-Type': 'application/json' },
  });
}
