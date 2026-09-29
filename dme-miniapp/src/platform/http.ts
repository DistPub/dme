/**
 * platform/http.ts - 轻量 XRPC 客户端（基于 Taro.request）。
 *
 * 替代 @atproto/api 的 Agent / CredentialSession（其内部依赖 fetch/Headers/URL，
 * 小程序运行时不完整）。上层 atproto/* 模块只依赖这里暴露的函数。
 *
 * 能力：
 *   - JSON 与 application/octet-stream 两种 body（Uint8Array → ArrayBuffer 切片转换）
 *   - 自定义 header（Authorization / atproto-proxy / dme-server）
 *   - 超时、错误归一化（HttpError 带 status + body）
 *   - 401 自动刷新：由上层注入 refresh 回调后重试一次（见 withAuthRetry）
 */

import Taro from '@tarojs/taro';

/** 请求超时（ms）。 */
const DEFAULT_TIMEOUT_MS = 20_000;

export class HttpError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string, message?: string) {
    super(message ?? `HTTP ${status}: ${body.slice(0, 200)}`);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
  }
}

export interface XrpcOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** 返回原始 ArrayBuffer（用于下载） */
  responseType?: 'json' | 'arraybuffer';
}

/** Uint8Array → 独立 ArrayBuffer（处理 byteOffset / 长度不足的情形）。 */
export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
    return bytes.buffer as ArrayBuffer;
  }
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function normalizeError(status: number, body: string, url: string): HttpError {
  let message = `HTTP ${status} @ ${url}`;
  try {
    const parsed = JSON.parse(body) as { error?: string; message?: string };
    if (parsed.message || parsed.error) {
      message = `${parsed.error ?? 'error'}: ${parsed.message ?? ''}`.trim();
    }
  } catch {
    /* 非 JSON 响应，保留原文 */
  }
  return new HttpError(status, body, message);
}

/** GET 请求，返回 JSON。 */
export async function xrpcGetJson<T>(url: string, options: XrpcOptions = {}): Promise<T> {
  const res = await Taro.request({
    url,
    method: 'GET',
    header: { Accept: 'application/json', ...(options.headers ?? {}) },
    timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    dataType: 'text',
  });
  const body = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw normalizeError(res.statusCode, body, url);
  }
  return (typeof res.data === 'string' ? JSON.parse(res.data) : res.data) as T;
}

/** POST JSON 请求（XRPC procedure）。 */
export async function xrpcPostJson<T>(
  url: string,
  payload: unknown,
  options: XrpcOptions = {},
): Promise<T> {
  const res = await Taro.request({
    url,
    method: 'POST',
    header: { 'Content-Type': 'application/json', ...(options.headers ?? {}) },
    data: payload as Record<string, unknown>,
    timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    dataType: 'text',
  });
  const body = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw normalizeError(res.statusCode, body, url);
  }
  if (!body) return undefined as T;
  return (typeof res.data === 'string' ? JSON.parse(res.data) : res.data) as T;
}

/**
 * POST 无 body 请求（com.atproto.server.refreshSession / deleteSession 等无输入 procedure）。
 *
 * ⚠️ 这类端点要求 body 必须为空：哪怕发一个 `{}`（Content-Length: 2），
 * PDS 也会返回 400 `InvalidRequest: A request body was provided when none was expected`
 * （2026-09-29 小程序实测踩坑）。因此不能复用 xrpcPostJson 传 {}，
 * 必须完全不携带 data —— Taro.request 在无 data 时不会发送请求体。
 * 同时也不设置 Content-Type，避免部分网关据此判定有 body。
 */
export async function xrpcPostEmpty<T>(url: string, options: XrpcOptions = {}): Promise<T> {
  const res = await Taro.request({
    url,
    method: 'POST',
    header: { Accept: 'application/json', ...(options.headers ?? {}) },
    timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    dataType: 'text',
  });
  const body = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw normalizeError(res.statusCode, body, url);
  }
  if (!body) return undefined as T;
  return (typeof res.data === 'string' ? JSON.parse(res.data) : res.data) as T;
}

/** 上传二进制（com.atproto.repo.uploadBlob）。三期文件功能使用。 */
export async function xrpcPostBytes<T>(
  url: string,
  bytes: Uint8Array,
  contentType: string,
  options: XrpcOptions = {},
): Promise<T> {
  const res = await Taro.request({
    url,
    method: 'POST',
    header: { 'Content-Type': contentType, ...(options.headers ?? {}) },
    data: toArrayBuffer(bytes),
    timeout: options.timeoutMs ?? 120_000,
    dataType: 'text',
  });
  const body = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw normalizeError(res.statusCode, body, url);
  }
  return (typeof res.data === 'string' ? JSON.parse(res.data) : res.data) as T;
}

/** 下载二进制（blob 拉取）。 */
export async function xrpcGetBytes(
  url: string,
  options: XrpcOptions = {},
): Promise<{ bytes: Uint8Array; contentType: string }> {
  const res = await Taro.request({
    url,
    method: 'GET',
    header: { ...(options.headers ?? {}) },
    responseType: 'arraybuffer',
    timeout: options.timeoutMs ?? 120_000,
  });
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new HttpError(res.statusCode, '', `下载失败 HTTP ${res.statusCode} @ ${url}`);
  }
  const data = res.data as unknown;
  const bytes =
    data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : new Uint8Array(data as ArrayBufferLike);
  const contentType =
    (res.header?.['Content-Type'] as string) ?? (res.header?.['content-type'] as string) ?? '';
  return { bytes, contentType };
}

/**
 * 带 401 自动刷新的请求包装。
 *
 * @param run     - 实际请求；若抛 HttpError(401) 则触发刷新并重试一次
 * @param refresh - 刷新会话（成功后再次调用 run）
 */
export async function withAuthRetry<T>(
  run: () => Promise<T>,
  refresh: () => Promise<void>,
): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof HttpError && err.status === 401) {
      await refresh();
      return await run();
    }
    throw err;
  }
}

/** 拼接 URL（避免重复斜杠）。 */
export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}
