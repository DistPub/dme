/**
 * atproto/profile-cache.ts - DID 解析缓存 + 资料获取（小程序版）。
 *
 * 提供 24h TTL、本地持久化、内存热缓存、按 DID 请求去重。
 * DID 缓存条目原子地保存「DID 文档 + 派生字段（handle / PDS URL / 双公钥）」，
 * 调用方无需重复解析。
 *
 * 与 dme-client 的差异：
 *   - 解析改用 atproto/did.ts 的 resolveDidDocument（直连 PLC / did:web）
 *   - 资料获取改为经 DmePds.appViewGet 走 `{PDS}/xrpc/app.bsky.actor.*`，
 *     携带 atproto-proxy header 转发到自建 AppView —— 与 dme-client 的
 *     `agent.app.bsky.actor.getProfile(s)` 行为一致，且只占用 PDS 一个域名
 *   - 不用 @atproto/api 的 Agent / AppBskyActorDefs 类型（改本地最小类型）
 *
 * ⚠️ 小程序限制：所有网络请求必须命中「request 合法域名」白名单。因此
 * 这里**禁止**直连 bsky 官方公共端点，也**禁止**请求 `https://{handle}/
 * .well-known/atproto-did`（handle 任意 → 域名不可枚举 → 必然被拦截）。
 */

import { DmeAsyncStorage as AsyncStorage } from '../platform/storage';
import { resolveDidDocument, type DidDocumentLike } from './did';
import { DME_ENCRYPTION_KEY_ID, DME_SIGNING_KEY_ID } from '../crypto/identity';
import { decodeEd25519DidKey, decodeX25519DidKey } from '../crypto/did-key';
import { base64urlToBytes, bytesToBase64url } from '../crypto/utils';
import { PLC_DIRECTORY_URL } from '../config';

const DID_KEY_PREFIX = 'did:key:';
const DID_CACHE_PREFIX = 'dme:cache:did:';
const PROFILE_CACHE_PREFIX = 'dme:cache:profile:';
const TTL_MS = 86_400_000;

/** app.bsky.actor.defs#profileView 的最小本地类型。 */
export interface ProfileView {
  did: string;
  handle: string;
  displayName?: string;
  description?: string;
  avatar?: string;
  [key: string]: unknown;
}

interface DidCacheEntry {
  doc: DidDocumentLike;
  handle: string | null;
  pdsUrl: string | null;
  encKeyBase64: string | null;
  sigKeyBase64: string | null;
  fetchedAt: number;
}

interface ProfileCacheEntry {
  profile: ProfileView;
  fetchedAt: number;
}

/** 内存热缓存。 */
const didMemoryCache = new Map<string, DidCacheEntry>();
const profileMemoryCache = new Map<string, ProfileCacheEntry>();
/** 请求去重。 */
const didInFlight = new Map<string, Promise<DidCacheEntry | null>>();
const profileInFlight = new Map<string, Promise<ProfileView | null>>();

function didCacheKey(did: string): string {
  return DID_CACHE_PREFIX + did;
}
function profileCacheKey(did: string): string {
  return PROFILE_CACHE_PREFIX + did;
}
function isExpired(entry: { fetchedAt: number }): boolean {
  return Date.now() - entry.fetchedAt > TTL_MS;
}

/** 从 DID 文档抽取 handle（alsoKnownAs 里的 at://）。 */
function extractHandle(doc: DidDocumentLike): string | null {
  const aka = doc.alsoKnownAs ?? [];
  for (const a of aka) {
    if (typeof a === 'string' && a.startsWith('at://')) return a.slice('at://'.length);
  }
  return null;
}

/** 从 DID 文档抽取 PDS 地址。 */
function extractPdsUrl(doc: DidDocumentLike): string | null {
  const svc = doc.service?.find(
    (s) => s.type === 'AtprotoPersonalDataServer' && s.serviceEndpoint,
  );
  return svc?.serviceEndpoint ? svc.serviceEndpoint.replace(/\/+$/, '') : null;
}

/** 从 DID 文档抽取 DME 公钥。 */
function extractKey(doc: DidDocumentLike, fragment: string): Uint8Array | null {
  const vm = doc.verificationMethod?.find((m) => m.id.endsWith(fragment));
  if (!vm?.publicKeyMultibase) return null;
  const didKey = `${DID_KEY_PREFIX}${vm.publicKeyMultibase}`;
  return fragment === DME_ENCRYPTION_KEY_ID
    ? decodeX25519DidKey(didKey)
    : decodeEd25519DidKey(didKey);
}

async function readDidCache(did: string): Promise<DidCacheEntry | null> {
  const memoryEntry = didMemoryCache.get(did);
  if (memoryEntry && !isExpired(memoryEntry)) return memoryEntry;

  try {
    const raw = await AsyncStorage.getItem(didCacheKey(did));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as DidCacheEntry;
    if (!parsed.doc || typeof parsed.fetchedAt !== 'number') return null;
    if (isExpired(parsed)) return null;
    didMemoryCache.set(did, parsed);
    return parsed;
  } catch (err) {
    console.warn('profile-cache: 读取 DID 缓存失败', did, err);
    return null;
  }
}

async function writeDidCache(did: string, entry: DidCacheEntry): Promise<void> {
  didMemoryCache.set(did, entry);
  try {
    await AsyncStorage.setItem(didCacheKey(did), JSON.stringify(entry));
  } catch (err) {
    console.warn('profile-cache: 写入 DID 缓存失败', did, err);
  }
}

async function fetchDidEntry(did: string): Promise<DidCacheEntry | null> {
  try {
    const doc = await resolveDidDocument(did);
    if (!doc) return null;
    const encKey = extractKey(doc, DME_ENCRYPTION_KEY_ID);
    const sigKey = extractKey(doc, DME_SIGNING_KEY_ID);
    const entry: DidCacheEntry = {
      doc,
      handle: extractHandle(doc),
      pdsUrl: extractPdsUrl(doc),
      encKeyBase64: encKey ? bytesToBase64url(encKey) : null,
      sigKeyBase64: sigKey ? bytesToBase64url(sigKey) : null,
      fetchedAt: Date.now(),
    };
    await writeDidCache(did, entry);
    return entry;
  } catch (err) {
    console.warn('profile-cache: DID 解析失败', did, err);
    return null;
  }
}

async function resolveDidEntry(did: string): Promise<DidCacheEntry | null> {
  const cached = await readDidCache(did);
  if (cached) return cached;

  const inFlight = didInFlight.get(did);
  if (inFlight) return inFlight;

  const promise = fetchDidEntry(did).finally(() => didInFlight.delete(did));
  didInFlight.set(did, promise);
  return promise;
}

async function readProfileCache(did: string): Promise<ProfileView | null> {
  const memoryEntry = profileMemoryCache.get(did);
  if (memoryEntry && !isExpired(memoryEntry)) return memoryEntry.profile;

  try {
    const raw = await AsyncStorage.getItem(profileCacheKey(did));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ProfileCacheEntry;
    if (!parsed.profile || typeof parsed.fetchedAt !== 'number') return null;
    if (isExpired(parsed)) return null;
    profileMemoryCache.set(did, parsed);
    return parsed.profile;
  } catch (err) {
    console.warn('profile-cache: 读取资料缓存失败', did, err);
    return null;
  }
}

async function writeProfileCache(did: string, profile: ProfileView): Promise<void> {
  const entry: ProfileCacheEntry = { profile, fetchedAt: Date.now() };
  profileMemoryCache.set(did, entry);
  try {
    await AsyncStorage.setItem(profileCacheKey(did), JSON.stringify(entry));
  } catch (err) {
    console.warn('profile-cache: 写入资料缓存失败', did, err);
  }
}

// ---------------------------------------------------------------------------
// DID 派生字段（带缓存）
// ---------------------------------------------------------------------------

/** 解析 DID 文档（带缓存），可选强制刷新。 */
export async function resolveDidDocumentCached(did: string): Promise<DidDocumentLike | null> {
  const entry = await resolveDidEntry(did);
  return entry?.doc ?? null;
}

/** 解析 handle；失败时回退返回 DID 本身。 */
export async function resolveHandleCached(did: string): Promise<string> {
  const entry = await resolveDidEntry(did);
  return entry?.handle || did;
}

/**
 * 解析 PDS 地址（带缓存）。
 * @throws 没有 PDS endpoint 或解析失败时抛错
 */
export async function resolvePdsUrlCached(did: string): Promise<string> {
  const entry = await resolveDidEntry(did);
  if (!entry?.pdsUrl) {
    throw new Error(`resolvePdsUrlCached: ${did} 没有 AtprotoPersonalDataServer`);
  }
  return entry.pdsUrl;
}

/** 读取远端 X25519 加密公钥（带缓存）。 */
export async function getRemoteEncryptionKeyCached(did: string): Promise<Uint8Array | null> {
  const entry = await resolveDidEntry(did);
  if (!entry?.encKeyBase64) return null;
  return base64urlToBytes(entry.encKeyBase64);
}

/** 读取远端 Ed25519 签名公钥（带缓存）。 */
export async function getRemoteSigningKeyCached(did: string): Promise<Uint8Array | null> {
  const entry = await resolveDidEntry(did);
  if (!entry?.sigKeyBase64) return null;
  return base64urlToBytes(entry.sigKeyBase64);
}

// ---------------------------------------------------------------------------
// handle → DID 解析（小程序需要，Web 端由 Agent 提供）
// ---------------------------------------------------------------------------

/**
 * 解析 handle 到 DID。
 *
 * 走 `{PDS}/xrpc/com.atproto.identity.resolveHandle`（带 atproto-proxy），
 * 由 PDS / 自建 AppView 完成解析。
 *
 * 刻意**不**走 `https://{handle}/.well-known/atproto-did`：那会产生
 * 任意域名请求，在小程序的合法域名白名单下必然失败。
 */
export async function resolveHandleToDid(
  handle: string,
  pds?: PdsLike,
): Promise<string | null> {
  const clean = handle.replace(/^@/, '').trim();
  if (!clean) return null;
  if (clean.startsWith('did:')) return clean;
  if (!pds) return null;

  try {
    const res = await pds.appViewGet<{ did?: string }>(
      'com.atproto.identity.resolveHandle',
      `handle=${encodeURIComponent(clean)}`,
    );
    if (res?.did && res.did.startsWith('did:')) return res.did;
  } catch (err) {
    console.warn('profile-cache: resolveHandle 失败', clean, err);
  }

  return null;
}

// ---------------------------------------------------------------------------
// 资料获取（经 PDS → 自建 AppView）
// ---------------------------------------------------------------------------

/** 满足 ProfileCache 需求的最小 PDS 接口（便于解耦与替换）。 */
export interface PdsLike {
  appViewGet<T>(nsid: string, query?: string): Promise<T>;
}

async function fetchSingleProfile(
  pds: PdsLike,
  did: string,
): Promise<ProfileView | null> {
  try {
    const profile = await pds.appViewGet<ProfileView>(
      'app.bsky.actor.getProfile',
      `actor=${encodeURIComponent(did)}`,
    );
    if (!profile?.did) return null;
    await writeProfileCache(did, profile);
    return profile;
  } catch (err) {
    console.warn('profile-cache: getProfile 失败', did, err);
    return null;
  }
}

/**
 * 获取单个用户资料（带缓存 + 请求去重）。
 *
 * @param pds - DmePds 实例（经 PDS → 自建 AppView）；未传入时仅返回缓存
 * @param did - 目标用户 DID
 */
export async function getProfileCached(
  pds: PdsLike | null,
  did: string,
): Promise<ProfileView | null> {
  const cached = await readProfileCache(did);
  if (cached) return cached;
  if (!pds) return null;

  const inFlight = profileInFlight.get(did);
  if (inFlight) return inFlight;

  const promise = fetchSingleProfile(pds, did).finally(() => profileInFlight.delete(did));
  profileInFlight.set(did, promise);
  return promise;
}

/**
 * 批量获取用户资料（带缓存 + 一次批量请求）。
 *
 * @param pds  - DmePds 实例（经 PDS → 自建 AppView）；未传入时仅返回缓存
 * @param dids - 目标用户 DID 列表
 * @returns DID → ProfileView 的映射；失败项静默省略
 */
export async function getProfilesCached(
  pds: PdsLike | null,
  dids: string[],
): Promise<Record<string, ProfileView>> {
  const result: Record<string, ProfileView> = {};
  const missing: string[] = [];
  const pending = new Map<string, Promise<ProfileView | null>>();

  for (const did of dids) {
    const cached = await readProfileCache(did);
    if (cached) {
      result[did] = cached;
      continue;
    }
    const inFlight = profileInFlight.get(did);
    if (inFlight) {
      pending.set(did, inFlight);
      continue;
    }
    missing.push(did);
  }

  if (missing.length > 0 && pds) {
    const batchPromise = (async (): Promise<Record<string, ProfileView>> => {
      const fetched: Record<string, ProfileView> = {};
      try {
        const query = missing.map((d) => `actors=${encodeURIComponent(d)}`).join('&');
        const res = await pds.appViewGet<{ profiles: ProfileView[] }>(
          'app.bsky.actor.getProfiles',
          query,
        );
        for (const profile of res?.profiles ?? []) {
          if (!profile.did) continue;
          await writeProfileCache(profile.did, profile);
          fetched[profile.did] = profile;
        }
      } catch (err) {
        console.warn('profile-cache: getProfiles 失败', missing, err);
      }
      return fetched;
    })();

    for (const did of missing) {
      const didPromise = batchPromise.then((fetched) => fetched[did] ?? null);
      profileInFlight.set(did, didPromise);
      pending.set(did, didPromise);
    }

    const fetched = await batchPromise;
    for (const did of missing) profileInFlight.delete(did);
    Object.assign(result, fetched);
  }

  for (const [did, promise] of pending.entries()) {
    const profile = await promise;
    if (profile) result[did] = profile;
  }

  return result;
}

/** PLC 目录地址（供设置页展示）。 */
export const PLC_URL = PLC_DIRECTORY_URL;
