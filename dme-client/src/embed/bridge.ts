/**
 * DME embed postMessage bridge — module singleton (NOT a React hook).
 *
 * Handles the DME⇄fatesky handshake with strict origin/source/protocol
 * validation. All entry points are guarded by `isEmbedContext()` so calling
 * code can use them unconditionally — standalone runs are no-ops.
 */

import {
  DME_EMBED_PROTOCOL,
  DME_MSG,
  isEmbedContext,
  isAllowedParentOrigin,
  resolveParentTargetOrigin,
} from './protocol';
import type { EmbedTokenPayload } from './protocol';

/** Callback signature for chat-active state changes. */
export type ChatActiveChangeHandler = (active: boolean) => void;

// ---------------------------------------------------------------------------
// Module-level singleton state
// ---------------------------------------------------------------------------

let onTokenHandler: ((p: EmbedTokenPayload) => void) | null = null;
let started = false;
let parentOrigin: string | null = null;
let readyRetryTimer: ReturnType<typeof setTimeout> | null = null;
let readyRetryCount = 0;
let lastUnread: { count: number; hasNew: boolean } | null = null;
let lastInvalidJwt: string | null = null;
let isChatActive = false;
const chatActiveHandlers = new Set<ChatActiveChangeHandler>();

const READY_RETRY_MS = 2500;
const READY_RETRY_MAX = 3;

// ---------------------------------------------------------------------------
// Inbound message handler (registered once)
// ---------------------------------------------------------------------------

function handleMessage(event: MessageEvent): void {
  if (!isAllowedParentOrigin(event.origin)) return;
  const isFromParent = event.source === window.parent;
  if (!isFromParent) return;

  const data = event.data;
  if (!data || data.protocol !== DME_EMBED_PROTOCOL) return;

  // Record validated origin for outbound messages.
  parentOrigin = event.origin;

  if (data.type === DME_MSG.TOKEN) {
    const payload = data.payload;
    if (
      payload &&
      typeof payload.did === 'string' && payload.did.length > 0 &&
      typeof payload.handle === 'string' && payload.handle.length > 0 &&
      typeof payload.accessJwt === 'string' && payload.accessJwt.length > 0 &&
      typeof payload.refreshJwt === 'string' && payload.refreshJwt.length > 0
    ) {
      clearReadyRetry();
      onTokenHandler?.(payload as EmbedTokenPayload);
    }
    // Invalid payload — silently ignore.
    return;
  }

  if (data.type === DME_MSG.PING) {
    window.parent.postMessage(
      { protocol: DME_EMBED_PROTOCOL, type: DME_MSG.PONG },
      event.origin,
    );
    return;
  }

  if (data.type === DME_MSG.CHAT_ACTIVE) {
    const payload = data.payload;
    if (payload && typeof payload.active === 'boolean') {
      const next = payload.active;
      if (next !== isChatActive) {
        isChatActive = next;
        for (const handler of chatActiveHandlers) {
          try {
            handler(next);
          } catch (err) {
            console.error('embed chat-active handler failed:', err);
          }
        }
      }
    }
    return;
  }

  // Unknown type — ignore.
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clearReadyRetry(): void {
  if (readyRetryTimer !== null) {
    clearTimeout(readyRetryTimer);
    readyRetryTimer = null;
  }
  readyRetryCount = 0;
}

// ---------------------------------------------------------------------------
// Exported API — all named exports, no namespace object
// ---------------------------------------------------------------------------

/**
 * Start listening for parent-posted messages. Idempotent — calling again
 * replaces the token handler without adding a second listener.
 */
export function start(onToken: (p: EmbedTokenPayload) => void): void {
  if (!isEmbedContext()) return;

  if (started) {
    onTokenHandler = onToken;
    return;
  }

  onTokenHandler = onToken;
  started = true;
  window.addEventListener('message', handleMessage);
}

/**
 * Notify the parent that DME is ready. If no TOKEN has arrived yet,
 * re-sends every 2 500 ms up to 3 times total.
 */
export function sendReady(): void {
  if (!isEmbedContext()) return;

  const target = parentOrigin ?? resolveParentTargetOrigin();

  window.parent.postMessage(
    { protocol: DME_EMBED_PROTOCOL, type: DME_MSG.READY },
    target,
  );

  if (readyRetryCount < READY_RETRY_MAX) {
    readyRetryCount++;
    readyRetryTimer = setTimeout(() => {
      readyRetryTimer = null;
      sendReady();
    }, READY_RETRY_MS);
  }
}

/**
 * Push unread-count info to the parent. Value-deduplicated — same
 * (count, hasNew) pair is sent at most once.
 */
export function sendUnread(count: number, hasNew: boolean): void {
  if (!isEmbedContext()) return;

  if (lastUnread?.count === count && lastUnread?.hasNew === hasNew) return;
  lastUnread = { count, hasNew };

  const target = parentOrigin ?? resolveParentTargetOrigin();

  window.parent.postMessage(
    {
      protocol: DME_EMBED_PROTOCOL,
      type: DME_MSG.UNREAD,
      payload: { count, hasNew },
    },
    target,
  );
}

/**
 * Inform the parent that the current session JWT is invalid. Deduplicated
 * per-JWT — the same string is notified at most once.
 */
export function notifySessionInvalid(jwt: string): void {
  if (!isEmbedContext()) return;

  if (lastInvalidJwt === jwt) return;
  lastInvalidJwt = jwt;

  const target = parentOrigin ?? resolveParentTargetOrigin();

  window.parent.postMessage(
    {
      protocol: DME_EMBED_PROTOCOL,
      type: DME_MSG.SESSION_INVALID,
      payload: { reason: 'expired' },
    },
    target,
  );
}

/**
 * Tear down the bridge: remove the message listener and reset all state.
 */
export function stop(): void {
  if (!started) return;

  window.removeEventListener('message', handleMessage);
  started = false;

  clearReadyRetry();
  parentOrigin = null;
  onTokenHandler = null;
  lastUnread = null;
  lastInvalidJwt = null;
  readyRetryCount = 0;
  isChatActive = false;
  chatActiveHandlers.clear();
}

/**
 * Register a callback invoked whenever the parent reports a chat-active
 * state change. Idempotent for the same handler reference.
 */
export function onChatActiveChange(handler: ChatActiveChangeHandler): void {
  chatActiveHandlers.add(handler);
}

/**
 * Remove a previously registered chat-active change callback.
 */
export function offChatActiveChange(handler: ChatActiveChangeHandler): void {
  chatActiveHandlers.delete(handler);
}

/**
 * Return the last known chat-active state reported by the parent.
 * Defaults to false until a DME_CHAT_ACTIVE message is received.
 */
export function getIsChatActive(): boolean {
  return isChatActive;
}
