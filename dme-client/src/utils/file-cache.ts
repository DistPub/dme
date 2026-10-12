/**
 * utils/file-cache.ts - Persistent file cache for web (IndexedDB) and URI resolver.
 *
 * Web file pickers / URL.createObjectURL produce blob: URLs that are invalidated
 * on page reload. We cache the actual file bytes in IndexedDB and use a stable
 * "indexeddb://{fileId}" URI as localPath. Components resolve this to a fresh
 * blob URL at render time.
 */

import { useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';

const DB_NAME = 'dme-file-cache';
const STORE_NAME = 'files';
const DB_VERSION = 1;
export const INDEXEDDB_PREFIX = 'indexeddb://';

interface CachedFile {
  data: ArrayBuffer;
  mimeType: string;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error ?? new Error('indexedDB open failed'));
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
  });
}

export async function cacheFile(fileId: string, data: Uint8Array, mimeType: string): Promise<void> {
  if (Platform.OS !== 'web') return;
  if (typeof indexedDB === 'undefined') return;
  const db = await openDb();
  try {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const cached: CachedFile = { data: data.slice().buffer, mimeType };
    await new Promise<void>((resolve, reject) => {
      const request = store.put(cached, fileId);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error ?? new Error('indexedDB put failed'));
    });
  } finally {
    db.close();
  }
}

export async function getCachedFileUrl(fileId: string): Promise<string | null> {
  if (Platform.OS !== 'web') return null;
  if (typeof indexedDB === 'undefined') return null;
  const db = await openDb();
  try {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const cached = await new Promise<CachedFile | undefined>((resolve, reject) => {
      const request = store.get(fileId);
      request.onsuccess = () => resolve(request.result as CachedFile | undefined);
      request.onerror = () => reject(request.error ?? new Error('indexedDB get failed'));
    });
    if (!cached) return null;
    return URL.createObjectURL(new Blob([cached.data], { type: cached.mimeType }));
  } finally {
    db.close();
  }
}

export async function getCachedFileBytes(fileId: string): Promise<Uint8Array | null> {
  if (Platform.OS !== 'web') return null;
  if (typeof indexedDB === 'undefined') return null;
  const db = await openDb();
  try {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const cached = await new Promise<CachedFile | undefined>((resolve, reject) => {
      const request = store.get(fileId);
      request.onsuccess = () => resolve(request.result as CachedFile | undefined);
      request.onerror = () => reject(request.error ?? new Error('indexedDB get failed'));
    });
    if (!cached) return null;
    return new Uint8Array(cached.data);
  } finally {
    db.close();
  }
}

export function makeIndexedDbUri(fileId: string): string {
  return `${INDEXEDDB_PREFIX}${fileId}`;
}

export function isIndexedDbUri(uri: string): boolean {
  return uri.startsWith(INDEXEDDB_PREFIX);
}

export async function resolveFileUri(uri: string): Promise<string | null> {
  if (isIndexedDbUri(uri)) {
    const fileId = uri.slice(INDEXEDDB_PREFIX.length);
    return getCachedFileUrl(fileId);
  }
  return uri;
}

export interface FileUriState {
  /** Resolved, renderable URI (blob: URL on web). undefined while loading or if the local bytes are unavailable. */
  uri: string | undefined;
  /**
   * True only AFTER a real resolve attempt returned nothing — i.e. the local
   * cached bytes are gone (e.g. the web IndexedDB file cache was evicted).
   * Used by callers to self-heal by re-downloading from blobCids.
   * False while still loading and for native file:// paths (never "missing").
   */
  missing: boolean;
}

export function useFileUri(uri: string | undefined): FileUriState {
  const [resolved, setResolved] = useState<string | undefined>(undefined);
  const [missing, setMissing] = useState(false);
  const objectUrlRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    let active = true;
    setMissing(false);

    async function resolve() {
      if (!uri) {
        const prev = objectUrlRef.current;
        objectUrlRef.current = undefined;
        if (prev?.startsWith('blob:')) {
          URL.revokeObjectURL(prev);
        }
        if (active) {
          setResolved(undefined);
          setMissing(false);
        }
        return;
      }

      const resolvedUri = await resolveFileUri(uri);
      if (!active) {
        if (resolvedUri?.startsWith('blob:')) {
          URL.revokeObjectURL(resolvedUri);
        }
        return;
      }

      const prev = objectUrlRef.current;
      objectUrlRef.current = resolvedUri ?? undefined;
      if (prev?.startsWith('blob:') && prev !== objectUrlRef.current) {
        URL.revokeObjectURL(prev);
      }
      if (active) {
        setResolved(objectUrlRef.current);
        // A genuine miss (indexeddb:// with no record) yields undefined here.
        setMissing(objectUrlRef.current === undefined);
      }
    }

    resolve();

    return () => {
      active = false;
    };
  }, [uri]);

  useEffect(() => {
    return () => {
      const current = objectUrlRef.current;
      objectUrlRef.current = undefined;
      if (current?.startsWith('blob:')) {
        URL.revokeObjectURL(current);
      }
    };
  }, []);

  return { uri: resolved, missing };
}
