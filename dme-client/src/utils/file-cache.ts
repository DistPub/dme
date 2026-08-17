/**
 * utils/file-cache.ts - Persistent file cache for web (IndexedDB) and URI resolver.
 *
 * Web file pickers / URL.createObjectURL produce blob: URLs that are invalidated
 * on page reload. We cache the actual file bytes in IndexedDB and use a stable
 * "indexeddb://{fileId}" URI as localPath. Components resolve this to a fresh
 * blob URL at render time.
 */

import { useEffect, useState } from 'react';
import { Platform } from 'react-native';

const DB_NAME = 'dme-file-cache';
const STORE_NAME = 'files';
const DB_VERSION = 1;
const INDEXEDDB_PREFIX = 'indexeddb://';

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

export function useFileUri(uri: string | undefined): string | undefined {
  const [resolved, setResolved] = useState<string | undefined>(undefined);

  useEffect(() => {
    let objectUrl: string | undefined;
    let cancelled = false;

    async function resolve() {
      if (!uri) {
        setResolved(undefined);
        return;
      }
      const resolvedUri = await resolveFileUri(uri);
      if (cancelled) {
        if (resolvedUri && resolvedUri.startsWith('blob:')) {
          URL.revokeObjectURL(resolvedUri);
        }
        return;
      }
      objectUrl = resolvedUri ?? undefined;
      setResolved(objectUrl);
    }

    resolve();

    return () => {
      cancelled = true;
      if (objectUrl && objectUrl.startsWith('blob:')) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [uri]);

  return resolved;
}
