/**
 * atproto/profile-cache.ts - Cached DID resolution and profile fetching.
 *
 * Provides 24h TTL, storage persistence, an in-memory hot cache, and
 * per-DID request deduplication. DID cache entries atomically store the DID
 * document together with derived fields (handle, PDS URL, encryption/signing
 * public keys) so callers can read derived values without re-parsing.
 */

import { storage } from '../storage/backend';
import { Agent, AppBskyActorDefs } from '@atproto/api';

import { sharedDidResolver } from './resolver';
import {
  DME_ENCRYPTION_KEY_ID,
  DME_SIGNING_KEY_ID,
} from '../crypto/identity';
import {
  decodeEd25519DidKey,
  decodeX25519DidKey,
} from '../crypto/did-key';
import {
  base64urlToBytes,
  bytesToBase64url,
} from '../crypto/utils';

const DID_KEY_PREFIX = 'did:key:';
const DID_CACHE_PREFIX = 'dme:cache:did:';
const PROFILE_CACHE_PREFIX = 'dme:cache:profile:';
const TTL_MS = 86_400_000;

type ProfileView = AppBskyActorDefs.ProfileView;

interface DidVerificationMethod {
  id: string;
  type: string;
  controller: string;
  publicKeyMultibase?: string;
}

/**
 * Minimal DID document structure for DME's needs.
 */
export interface DidDocumentLike {
  id: string;
  alsoKnownAs?: string[];
  service?: Array<{ type?: string; serviceEndpoint?: string }>;
  verificationMethod?: DidVerificationMethod[];
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

const didMemoryCache = new Map<string, DidCacheEntry>();
const profileMemoryCache = new Map<string, ProfileCacheEntry>();
const didInFlight = new Map<string, Promise<DidCacheEntry | null>>();
const profileInFlight = new Map<string, Promise<ProfileView | null>>();

function isExpired(entry: { fetchedAt: number }): boolean {
  return Date.now() - entry.fetchedAt >= TTL_MS;
}

function didCacheKey(did: string): string {
  return `${DID_CACHE_PREFIX}${did}`;
}

function profileCacheKey(did: string): string {
  return `${PROFILE_CACHE_PREFIX}${did}`;
}

function extractHandle(doc: DidDocumentLike): string | null {
  const aka = doc.alsoKnownAs?.[0];
  if (!aka) return null;
  const handle = aka.replace(/^at:\/\//, '');
  return handle || null;
}

function extractPdsUrl(doc: DidDocumentLike): string | null {
  const pds = doc.service?.find(
    (s) => s.type === 'AtprotoPersonalDataServer',
  )?.serviceEndpoint;
  return pds || null;
}

function extractKey(
  doc: DidDocumentLike,
  fragment: string,
): Uint8Array | null {
  const vm = doc.verificationMethod?.find((m) => m.id.endsWith(fragment));
  if (!vm?.publicKeyMultibase) return null;
  const didKey = `${DID_KEY_PREFIX}${vm.publicKeyMultibase}`;
  return fragment === DME_ENCRYPTION_KEY_ID
    ? decodeX25519DidKey(didKey)
    : decodeEd25519DidKey(didKey);
}

async function readDidCache(did: string): Promise<DidCacheEntry | null> {
  const memoryEntry = didMemoryCache.get(did);
  if (memoryEntry && !isExpired(memoryEntry)) {
    return memoryEntry;
  }

  try {
    const raw = await storage.getItem(didCacheKey(did));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as DidCacheEntry;
    if (!parsed.doc || typeof parsed.fetchedAt !== 'number') return null;
    if (isExpired(parsed)) return null;
    didMemoryCache.set(did, parsed);
    return parsed;
  } catch (err) {
    console.warn('profile-cache: failed to read DID cache', did, err);
    return null;
  }
}

async function writeDidCache(
  did: string,
  entry: DidCacheEntry,
): Promise<void> {
  didMemoryCache.set(did, entry);
  try {
    await storage.setItem(didCacheKey(did), JSON.stringify(entry));
  } catch (err) {
    console.warn('profile-cache: failed to write DID cache', did, err);
  }
}

async function fetchDidEntry(did: string): Promise<DidCacheEntry | null> {
  try {
    const resolved = await sharedDidResolver.resolve(did);
    if (!resolved) return null;
    const doc = resolved as DidDocumentLike;
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
    console.warn('profile-cache: DID resolution failed', did, err);
    return null;
  }
}

async function resolveDidEntry(did: string): Promise<DidCacheEntry | null> {
  const cached = await readDidCache(did);
  if (cached) return cached;

  const inFlight = didInFlight.get(did);
  if (inFlight) return inFlight;

  const promise = fetchDidEntry(did).finally(() => {
    didInFlight.delete(did);
  });
  didInFlight.set(did, promise);
  return promise;
}

async function readProfileCache(did: string): Promise<ProfileView | null> {
  const memoryEntry = profileMemoryCache.get(did);
  if (memoryEntry && !isExpired(memoryEntry)) {
    return memoryEntry.profile;
  }

  try {
    const raw = await storage.getItem(profileCacheKey(did));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ProfileCacheEntry;
    if (!parsed.profile || typeof parsed.fetchedAt !== 'number') return null;
    if (isExpired(parsed)) return null;
    profileMemoryCache.set(did, parsed);
    return parsed.profile;
  } catch (err) {
    console.warn('profile-cache: failed to read profile cache', did, err);
    return null;
  }
}

async function writeProfileCache(
  did: string,
  profile: ProfileView,
): Promise<void> {
  const entry: ProfileCacheEntry = { profile, fetchedAt: Date.now() };
  profileMemoryCache.set(did, entry);
  try {
    await storage.setItem(profileCacheKey(did), JSON.stringify(entry));
  } catch (err) {
    console.warn('profile-cache: failed to write profile cache', did, err);
  }
}

/**
 * Resolve a DID to its document with caching.
 *
 * @param did - The DID to resolve.
 * @returns The DID document, or null if resolution fails.
 */
export async function resolveDidDocumentCached(
  did: string,
): Promise<DidDocumentLike | null> {
  const entry = await resolveDidEntry(did);
  return entry?.doc ?? null;
}

/**
 * Resolve a DID to its handle with caching.
 *
 * Falls back to returning the DID itself if no handle is declared or
 * resolution fails, matching the existing resolveDidToHandle behaviour.
 *
 * @param did - The DID to resolve.
 * @returns The handle, or the input DID as a fallback.
 */
export async function resolveHandleCached(did: string): Promise<string> {
  const entry = await resolveDidEntry(did);
  return entry?.handle || did;
}

/**
 * Resolve a DID to its PDS URL with caching.
 *
 * @param did - The DID to resolve.
 * @returns The AtprotoPersonalDataServer service endpoint.
 * @throws Error if the DID has no PDS endpoint or resolution fails.
 */
export async function resolvePdsUrlCached(did: string): Promise<string> {
  const entry = await resolveDidEntry(did);
  if (!entry?.pdsUrl) {
    throw new Error(
      `resolvePdsUrlCached: no AtprotoPersonalDataServer for ${did}`,
    );
  }
  return entry.pdsUrl;
}

/**
 * Read a remote user's DME X25519 encryption public key with caching.
 *
 * @param did - The remote user's DID.
 * @returns 32-byte X25519 public key, or null if not declared.
 */
export async function getRemoteEncryptionKeyCached(
  did: string,
): Promise<Uint8Array | null> {
  const entry = await resolveDidEntry(did);
  if (!entry?.encKeyBase64) return null;
  return base64urlToBytes(entry.encKeyBase64);
}

/**
 * Read a remote user's DME Ed25519 signing public key with caching.
 *
 * @param did - The remote user's DID.
 * @returns 32-byte Ed25519 public key, or null if not declared.
 */
export async function getRemoteSigningKeyCached(
  did: string,
): Promise<Uint8Array | null> {
  const entry = await resolveDidEntry(did);
  if (!entry?.sigKeyBase64) return null;
  return base64urlToBytes(entry.sigKeyBase64);
}

async function fetchSingleProfile(
  agent: Agent,
  did: string,
): Promise<ProfileView | null> {
  try {
    const response = await agent.app.bsky.actor.getProfile({ actor: did });
    const profile = response.data as ProfileView;
    await writeProfileCache(did, profile);
    return profile;
  } catch (err) {
    console.warn('profile-cache: getProfile failed', did, err);
    return null;
  }
}

/**
 * Fetch a single profile with caching.
 *
 * @param agent - Authenticated AT Protocol agent.
 * @param did - The DID whose profile to fetch.
 * @returns The profile, or null if it could not be fetched.
 */
export async function getProfileCached(
  agent: Agent,
  did: string,
): Promise<ProfileView | null> {
  const cached = await readProfileCache(did);
  if (cached) return cached;

  const inFlight = profileInFlight.get(did);
  if (inFlight) return inFlight;

  const promise = fetchSingleProfile(agent, did).finally(() => {
    profileInFlight.delete(did);
  });
  profileInFlight.set(did, promise);
  return promise;
}

/**
 * Fetch profiles for multiple DIDs with caching and batching.
 *
 * Valid cache entries are returned immediately. Missing or expired entries
 * are requested in a single batch call. Only the input DIDs are included in
 * the returned record; failures are silently omitted.
 *
 * @param agent - Authenticated AT Protocol agent.
 * @param dids - Array of DIDs to resolve.
 * @returns Record mapping DID to profile for successfully resolved profiles.
 */
export async function getProfilesCached(
  agent: Agent,
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

  if (missing.length > 0) {
    const batchPromise = (async (): Promise<Record<string, ProfileView>> => {
      const fetched: Record<string, ProfileView> = {};
      try {
        const response = await agent.app.bsky.actor.getProfiles({
          actors: missing,
        });
        for (const profile of response.data.profiles) {
          if (!profile.did) continue;
          await writeProfileCache(profile.did, profile as ProfileView);
          fetched[profile.did] = profile as ProfileView;
        }
      } catch (err) {
        console.warn('profile-cache: getProfiles failed', missing, err);
      }
      return fetched;
    })();

    for (const did of missing) {
      const didPromise = batchPromise.then(
        (fetched) => fetched[did] ?? null,
      );
      profileInFlight.set(did, didPromise);
      pending.set(did, didPromise);
    }

    const fetched = await batchPromise;
    for (const did of missing) {
      profileInFlight.delete(did);
    }
    Object.assign(result, fetched);
  }

  for (const [did, promise] of pending.entries()) {
    const profile = await promise;
    if (profile) {
      result[did] = profile;
    }
  }

  return result;
}
