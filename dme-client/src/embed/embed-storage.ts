/**
 * embed/embed-storage.ts — EmbedStorageBackend: in-memory mirror + postMessage
 * delegation to fatesky first-party localStorage.
 *
 * In embed mode, AsyncStorage reads/writes are redirected here. Reads block
 * until STORAGE_DATA arrives from fatesky (10s timeout fallback). Writes are
 * fire-and-forget (SET/REMOVE posted immediately via postMessage).
 */
import {
  DME_EMBED_PROTOCOL,
  DME_MSG,
  isEmbedContext,
  resolveParentTargetOrigin,
} from './protocol';

export type StorageBackend = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
  getAllKeys(): Promise<readonly string[]>;
};

const READY_TIMEOUT_MS = 10_000;

export class EmbedStorageBackend {
  private mirror = new Map<string, string>();
  private dataReady = false;
  private readyPromise: Promise<void> | null = null;
  private readyResolve: (() => void) | null = null;
  private parentOrigin: string | null = null;

  /**
   * Called by bridge.ts when DME_STORAGE_DATA arrives.
   * Replaces the entire mirror (clears first, then fills).
   */
  loadEntries(entries: Record<string, string>, origin: string): void {
    this.mirror.clear();
    for (const [k, v] of Object.entries(entries)) {
      this.mirror.set(k, v);
    }
    this.parentOrigin = origin;
    if (!this.dataReady) {
      this.dataReady = true;
      this.readyResolve?.();
    }
  }

  /**
   * Reset all state (called by bridge.stop() for defensive cleanup).
   * Account switching relies on iframe remount (key={did}) resetting module state.
   */
  reset(): void {
    this.mirror.clear();
    this.dataReady = false;
    this.readyPromise = null;
    this.readyResolve = null;
    this.parentOrigin = null;
  }

  /**
   * Block until STORAGE_DATA has arrived. 10s timeout forces dataReady=true
   * (empty mirror degradation) to prevent permanent hang.
   */
  private ensureReady(): Promise<void> {
    if (this.dataReady) return Promise.resolve();
    if (!this.readyPromise) {
      this.readyPromise = new Promise<void>((resolve) => {
        this.readyResolve = resolve;
        setTimeout(() => {
          if (!this.dataReady) {
            this.dataReady = true;
            this.readyResolve?.();
          }
        }, READY_TIMEOUT_MS);
      });
    }
    return this.readyPromise;
  }

  private post(msg: { type: string; payload?: unknown }): void {
    if (!isEmbedContext()) return;
    const target = this.parentOrigin ?? resolveParentTargetOrigin();
    window.parent.postMessage({ ...msg, protocol: DME_EMBED_PROTOCOL }, target);
  }

  async getItem(key: string): Promise<string | null> {
    await this.ensureReady();
    return this.mirror.get(key) ?? null;
  }

  async setItem(key: string, value: string): Promise<void> {
    this.mirror.set(key, value);
    this.post({ type: DME_MSG.STORAGE_SET, payload: { key, value } });
  }

  async removeItem(key: string): Promise<void> {
    this.mirror.delete(key);
    this.post({ type: DME_MSG.STORAGE_REMOVE, payload: { key } });
  }

  async getAllKeys(): Promise<readonly string[]> {
    await this.ensureReady();
    return Array.from(this.mirror.keys());
  }

  /** Protocol endpoint: request storage load from fatesky. */
  sendLoad(): void {
    this.post({ type: DME_MSG.STORAGE_LOAD });
  }

  /** Protocol endpoint: clear all storage in fatesky. No DME-side caller (DmeStorage.clear uses getAllKeys + N×removeItem). */
  sendClear(): void {
    this.post({ type: DME_MSG.STORAGE_CLEAR });
  }
}

export const embedStorageBackend = new EmbedStorageBackend();
