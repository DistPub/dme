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

const CORS_ORIGIN = '*';
const CORS_METHODS = 'GET, POST, OPTIONS';
const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': CORS_ORIGIN,
  'Access-Control-Allow-Methods': CORS_METHODS,
  'Access-Control-Allow-Headers': 'Content-Type, dme-server, Authorization',
  'Access-Control-Max-Age': '86400',
};

const UPSTREAM_TIMEOUT_MS = 15_000;
const MAX_CACHEABLE_BYTES = 100 * 1024 * 1024;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (url.pathname === '/_health') {
      return new Response('ok', { status: 200, headers: CORS_HEADERS });
    }

    if (url.pathname === '/xrpc/dme.file.blob' && request.method === 'GET') {
      return getBlob(url, ctx);
    }

    if (url.pathname === '/xrpc/dme.batch.get' && request.method === 'POST') {
      return proxy(request, env);
    }

    return new Response('Not Found', { status: 404, headers: CORS_HEADERS });
  },
};

async function getBlob(url: URL, ctx: ExecutionContext): Promise<Response> {
  const pds = url.searchParams.get('pds');
  const did = url.searchParams.get('did');
  const cid = url.searchParams.get('cid');

  if (!pds || !did || !cid) {
    return new Response('Missing required params: pds, did, cid', {
      status: 400,
      headers: CORS_HEADERS,
    });
  }

  const cacheKey = new Request(url.toString(), { method: 'GET' });
  const cached = await caches.default.match(cacheKey);
  if (cached) {
    return cached;
  }

  const blobUrl = pds + '/xrpc/com.atproto.sync.getBlob?did=' + encodeURIComponent(did) + '&cid=' + encodeURIComponent(cid);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  let upstream: Response;
  try {
    upstream = await fetch(blobUrl, { signal: controller.signal });
  } catch {
    return new Response('Upstream blob fetch failed', {
      status: 504,
      headers: CORS_HEADERS,
    });
  } finally {
    clearTimeout(timer);
  }

  const contentType = upstream.headers.get('content-type') || 'application/octet-stream';

  if (!upstream.ok) {
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        'Content-Type': contentType,
        ...CORS_HEADERS,
      },
    });
  }

  const response = new Response(upstream.body, {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=604800',
      ...CORS_HEADERS,
    },
  });

  const contentLength = Number(upstream.headers.get('content-length') ?? '0');
  if (Number.isFinite(contentLength) && contentLength > 0 && contentLength <= MAX_CACHEABLE_BYTES) {
    ctx.waitUntil(
      caches.default.put(cacheKey, response.clone()).catch(() => {}),
    );
  }

  return response;
}

function getTargetServerUrl(request: Request, env: Env): string {
  const headerUrl = request.headers.get('dme-server');
  if (headerUrl) {
    try {
      new URL(headerUrl);
      return headerUrl.replace(/\/$/, '');
    } catch {
    }
  }
  return env.DME_SERVER_URL;
}

async function proxy(request: Request, env: Env): Promise<Response> {
  const body = await request.arrayBuffer();
  const targetUrl = getTargetServerUrl(request, env) + '/xrpc/dme.batch.get';

  const serverResponse = await fetch(targetUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });

  const responseBody = await serverResponse.arrayBuffer();
  return new Response(responseBody, {
    status: serverResponse.status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}
