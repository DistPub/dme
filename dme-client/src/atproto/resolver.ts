/**
 * atproto/resolver.ts - Shared DID resolver instance.
 *
 * Kept in a separate module to avoid a circular import between did.ts
 * (which wraps DID-document helpers) and profile-cache.ts (which adds
 * AsyncStorage persistence and profile caching on top of resolution).
 */

import { DidResolver, MemoryCache } from '@atproto/identity';

import { PLC_DIRECTORY_URL } from '../config';

/**
 * Shared DID resolver with in-memory caching.
 *
 * Using a single instance avoids creating a new resolver on every UI render and
 * lets @atproto/identity cache DID documents across the app. did:plc DIDs are
 * routed to PLC_DIRECTORY_URL automatically.
 */
export const sharedDidResolver = new DidResolver({
  plcUrl: PLC_DIRECTORY_URL,
  didCache: new MemoryCache(),
  timeout: 20_000,
});

/**
 * Resolve a DID document bypassing the in-memory cache.
 *
 * Used by flows that must observe the latest DID document (e.g. the
 * did:web "I have updated" check on the Setup screen), where a stale
 * cached document would show a false negative. The fresh document is
 * written back into the shared cache, so subsequent cached reads see it.
 */
export async function resolveDidDocumentFresh(
  did: string,
): Promise<unknown> {
  return sharedDidResolver.resolve(did, true);
}
