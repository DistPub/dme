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

    if (url.pathname === '/xrpc/dme.file.blob') {
      if (request.method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
          },
        });
      }
      if (request.method === 'GET') {
        return getBlob(url);
      }
    }

    if (url.pathname === '/xrpc/dme.batch.get' && request.method === 'POST') {
      return proxy(request, env);
    }

    return new Response('Not Found', { status: 404 });
  },
};

async function getBlob(url: URL): Promise<Response> {
  const pds = url.searchParams.get('pds');
  const did = url.searchParams.get('did');
  const cid = url.searchParams.get('cid');

  if (!pds || !did || !cid) {
    return new Response('Missing required params: pds, did, cid', {
      status: 400,
      headers: { 'Access-Control-Allow-Origin': '*' },
    });
  }

  const cacheKey = new Request(url.toString(), { method: 'GET' });
  const cached = await caches.default.match(cacheKey);
  if (cached) {
    return cached;
  }

  const blobUrl = pds + '/xrpc/com.atproto.sync.getBlob?did=' + encodeURIComponent(did) + '&cid=' + encodeURIComponent(cid);
  const upstream = await fetch(blobUrl);

  if (!upstream.ok) {
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }

  const body = await upstream.arrayBuffer();
  const response = new Response(body, {
    status: 200,
    headers: {
      'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=604800',
    },
  });

  await caches.default.put(cacheKey, response.clone());

  return response;
}

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
