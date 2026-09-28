/**
 * atproto/did.ts - DID 文档读写（小程序版）。
 *
 * 发布 Ed25519(#dme_signing) + X25519(#dme_encryption) 双公钥到用户 DID 文档；
 * 握手方通过该文档发现对方公钥，无需独立密钥服务器。
 *
 * 与 dme-client 的差异：
 *   - DID 解析：不再用 @atproto/identity 的 DidResolver，改为
 *     did:plc → GET {PLC_DIRECTORY_URL}/{did}
 *     did:web → GET https://{domain}/.well-known/did.json
 *     并自建内存缓存（替代 MemoryCache）。
 *   - PLC 写操作：用 XRPC 直连 PDS 的 com.atproto.identity.* 端点。
 *
 * ⚠️ 合法域名：plc.directory 与 did:web 域名需在微信后台配置；
 *    开发期用开发者工具「不校验合法域名」。
 */

import {
  decodeEd25519DidKey,
  decodeX25519DidKey,
  encodeEd25519DidKey,
  encodeX25519DidKey,
} from '../crypto/did-key';
import {
  DME_ENCRYPTION_KEY_ID,
  DME_SIGNING_KEY_ID,
  type IdentityKeys,
} from '../crypto/identity';
import { PLC_DIRECTORY_URL } from '../config';
import { HttpError, joinUrl, xrpcGetJson, xrpcPostJson } from '../platform/http';
import type { DmeSession } from './session';

/** DID_KEY_PREFIX prepended to multibase values from PLC documents. */
const DID_KEY_PREFIX = 'did:key:';

/** A verificationMethod entry in a DID document. */
export interface DidVerificationMethod {
  id: string;
  type: string;
  controller: string;
  publicKeyMultibase?: string;
}

/** Minimal DID document structure for DME's needs. */
export interface DidDocumentLike {
  id: string;
  verificationMethod?: DidVerificationMethod[];
  service?: Array<{ id?: string; type?: string; serviceEndpoint?: string }>;
  alsoKnownAs?: string[];
}

/** com.atproto.identity.getRecommendedDidCredentials 响应。 */
interface DidCredentials {
  rotationKeys?: string[];
  alsoKnownAs?: string[];
  verificationMethods?: Record<string, string>;
  services?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// DID 解析（替代 @atproto/identity 的 DidResolver + MemoryCache）
// ---------------------------------------------------------------------------

/** 内存缓存（对应 Web 端 MemoryCache 行为）。 */
const didCache = new Map<string, { doc: DidDocumentLike; at: number }>();
/** 缓存 TTL（10 分钟）。 */
const DID_CACHE_TTL_MS = 10 * 60 * 1000;

/** 将 DID 转为文档 URL。 */
function didDocumentUrl(did: string): string {
  if (did.startsWith('did:plc:')) {
    return joinUrl(PLC_DIRECTORY_URL, did);
  }
  if (did.startsWith('did:web:')) {
    const rest = did.slice('did:web:'.length);
    const parts = rest.split(':');
    const host = decodeURIComponent(parts[0]);
    const path = parts.slice(1).map((p) => decodeURIComponent(p)).join('/');
    return path
      ? `https://${host}/${path}/did.json`
      : `https://${host}/.well-known/did.json`;
  }
  throw new Error(`不支持的 DID 方法: ${did}`);
}

/**
 * 解析 DID 文档。
 *
 * @param did   - 目标 DID
 * @param fresh - true 时绕过内存缓存直接拉取（用于「已更新」检测）
 */
export async function resolveDidDocument(
  did: string,
  fresh = false,
): Promise<DidDocumentLike | null> {
  if (!fresh) {
    const cached = didCache.get(did);
    if (cached && Date.now() - cached.at < DID_CACHE_TTL_MS) return cached.doc;
  }

  const url = didDocumentUrl(did);
  try {
    const doc = await xrpcGetJson<DidDocumentLike>(url, { timeoutMs: 20_000 });
    if (!doc || typeof doc !== 'object') return null;
    didCache.set(did, { doc, at: Date.now() });
    return doc;
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) return null;
    throw err;
  }
}

/** 清空 DID 缓存（设置页手动刷新等场景）。 */
export function clearDidCache(): void {
  didCache.clear();
}

// ---------------------------------------------------------------------------
// 公钥读取
// ---------------------------------------------------------------------------

/** 按 fragment 查找 verificationMethod。 */
async function findVerificationMethod(
  did: string,
  fragment: string,
  fresh = false,
): Promise<DidVerificationMethod | null> {
  const doc = await resolveDidDocument(did, fresh);
  if (!doc?.verificationMethod) return null;
  return doc.verificationMethod.find((vm) => vm.id.endsWith(fragment)) ?? null;
}

/**
 * 读取远端用户的 X25519 加密公钥（#dme_encryption）。
 *
 * @returns 32 字节公钥；未声明时返回 null
 */
export async function getRemoteEncryptionKey(
  did: string,
  fresh = false,
): Promise<Uint8Array | null> {
  const vm = await findVerificationMethod(did, DME_ENCRYPTION_KEY_ID, fresh);
  if (!vm?.publicKeyMultibase) return null;
  return decodeX25519DidKey(DID_KEY_PREFIX + vm.publicKeyMultibase);
}

/**
 * 读取远端用户的 Ed25519 签名公钥（#dme_signing）。
 *
 * @returns 32 字节公钥；未声明时返回 null
 */
export async function getRemoteSigningKey(
  did: string,
  fresh = false,
): Promise<Uint8Array | null> {
  const vm = await findVerificationMethod(did, DME_SIGNING_KEY_ID, fresh);
  if (!vm?.publicKeyMultibase) return null;
  return decodeEd25519DidKey(DID_KEY_PREFIX + vm.publicKeyMultibase);
}

/**
 * 解析 DID 的 PDS 地址（从 service 数组里找 AtprotoPersonalDataServer）。
 */
export async function resolvePdsUrl(did: string, fresh = false): Promise<string> {
  const doc = await resolveDidDocument(did, fresh);
  const svc = doc?.service?.find(
    (s) => s.type === 'AtprotoPersonalDataServer' && s.serviceEndpoint,
  );
  if (!svc?.serviceEndpoint) {
    throw new Error(`resolvePdsUrl: ${did} 的 DID 文档中没有 PDS service endpoint`);
  }
  return svc.serviceEndpoint.replace(/\/+$/, '');
}

/** 判断 DID 方法。 */
export function getDidMethod(did: string): 'plc' | 'web' | 'other' {
  if (did.startsWith('did:plc:')) return 'plc';
  if (did.startsWith('did:web:')) return 'web';
  return 'other';
}

// ---------------------------------------------------------------------------
// 密钥声明（写入 DID 文档）
// ---------------------------------------------------------------------------

/** 通过 PDS 请求 PLC 操作签名 token（发送到用户邮箱）。 */
export async function requestPlcSignature(session: DmeSession): Promise<void> {
  const token = requireToken(session);
  await xrpcPostJson(
    joinUrl(session.pdsUrlStr, 'xrpc/com.atproto.identity.requestPlcOperationSignature'),
    {},
    { headers: { Authorization: `Bearer ${token}` } },
  );
}

/**
 * 把两个 DME 公钥声明进 did:plc 文档。
 *
 * 流程：
 *   1. getRecommendedDidCredentials —— 拉取当前 DID 字段
 *   2. 合并两个 did:key 到 verificationMethods
 *   3. signPlcOperation —— 由 PDS 签名
 *   4. submitPlcOperation —— 发布到 PLC
 *
 * @param did      - 用户自己的 DID（必须与会话 DID 一致）
 * @param keys     - 双身份密钥
 * @param session  - 已登录会话
 * @param plcToken - 邮箱收到的 PLC token
 */
export async function declareKeys(
  did: string,
  keys: IdentityKeys,
  session: DmeSession,
  plcToken: string,
): Promise<void> {
  const token = requireToken(session);
  if (session.did !== did) {
    throw new Error(`declareKeys: 会话 DID ${session.did} 与目标 ${did} 不一致`);
  }
  const auth = { headers: { Authorization: `Bearer ${token}` } };
  const base = session.pdsUrlStr;

  const creds = await xrpcGetJson<DidCredentials>(
    joinUrl(base, 'xrpc/com.atproto.identity.getRecommendedDidCredentials'),
    auth,
  );

  const encFragment = DME_ENCRYPTION_KEY_ID.slice(1);
  const sigFragment = DME_SIGNING_KEY_ID.slice(1);
  const verificationMethods: Record<string, string> = {
    ...(creds.verificationMethods ?? {}),
    [encFragment]: encodeX25519DidKey(keys.encryption.publicKey),
    [sigFragment]: encodeEd25519DidKey(keys.signing.publicKey),
  };

  const signed = await xrpcPostJson<{ operation: unknown }>(
    joinUrl(base, 'xrpc/com.atproto.identity.signPlcOperation'),
    {
      token: plcToken,
      verificationMethods,
      rotationKeys: creds.rotationKeys,
      alsoKnownAs: creds.alsoKnownAs,
      services: creds.services,
    },
    auth,
  );

  await xrpcPostJson(
    joinUrl(base, 'xrpc/com.atproto.identity.submitPlcOperation'),
    { operation: signed.operation },
    auth,
  );

  // 声明成功后使缓存失效，后续 fresh 读取能看到新公钥
  didCache.delete(did);
}

/** did:web 需要手工添加的 verificationMethod 条目。 */
export interface DidWebEntry {
  id: string;
  type: string;
  controller: string;
  publicKeyMultibase: string;
}

/**
 * 为 did:web 用户生成需要更新的 DID 文档内容。
 *
 * 成功拉到当前文档则返回合并后的完整 did.json（用户直接替换）；
 * 失败则返回 null，调用方应展示 newEntries 让用户手工添加。
 */
export async function generateDidWebUpdate(
  did: string,
  keys: IdentityKeys,
  fresh = false,
): Promise<{ didJson: string | null; newEntries: DidWebEntry[] }> {
  const encEntry: DidWebEntry = {
    id: `${did}${DME_ENCRYPTION_KEY_ID}`,
    type: 'Multikey',
    controller: did,
    publicKeyMultibase: encodeX25519DidKey(keys.encryption.publicKey).replace(DID_KEY_PREFIX, ''),
  };
  const sigEntry: DidWebEntry = {
    id: `${did}${DME_SIGNING_KEY_ID}`,
    type: 'Multikey',
    controller: did,
    publicKeyMultibase: encodeEd25519DidKey(keys.signing.publicKey).replace(DID_KEY_PREFIX, ''),
  };
  const newEntries = [encEntry, sigEntry];

  const doc = await resolveDidDocument(did, fresh).catch(() => null);
  if (!doc) return { didJson: null, newEntries };

  const existingVMs = doc.verificationMethod ?? [];
  const filtered = existingVMs.filter(
    (vm) => !vm.id.endsWith(DME_ENCRYPTION_KEY_ID) && !vm.id.endsWith(DME_SIGNING_KEY_ID),
  );

  const updatedDoc = { ...doc, verificationMethod: [...filtered, encEntry, sigEntry] };
  return { didJson: JSON.stringify(updatedDoc, null, 2), newEntries };
}

/** 取 accessJwt，未登录时抛错。 */
function requireToken(session: DmeSession): string {
  const token = session.accessJwt;
  if (!token) throw new Error('declareKeys: 未登录');
  return token;
}
