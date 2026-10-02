/**
 * DME embed protocol — single source of truth for the postMessage constants and
 * parent-origin whitelist shared with fatesky's `src/lib/dme-embed/constants.ts`.
 *
 * Message names and the protocol version string MUST stay byte-for-byte in sync
 * across both repos. When fatesky's constants.ts changes, mirror it here.
 */

import { Platform } from 'react-native';

/** Version of the postMessage protocol spoken between the app and the embed. */
export const DME_EMBED_PROTOCOL = 'dme-embed/v1';

/** Message type names exchanged over the embed bridge. */
export const DME_MSG = {
  READY: 'DME_READY',
  TOKEN: 'DME_TOKEN',
  SESSION_INVALID: 'DME_SESSION_INVALID',
  UNREAD: 'DME_UNREAD',
  CHAT_ACTIVE: 'DME_CHAT_ACTIVE',
  PING: 'DME_PING',
  PONG: 'DME_PONG',
} as const;

/** Credentials handed to the embed via the `DME_TOKEN` message. */
export type EmbedTokenPayload = {
  did: string;
  handle: string;
  accessJwt: string;
  refreshJwt: string;
  service?: string;
};

/** Origin of the fatesky parent app, used when `document.referrer` is unusable. */
export const FALLBACK_PARENT_ORIGIN = 'https://app.hukoubook.com';

const LOCALHOST_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

/**
 * Whether the given origin is an allowed parent frame origin: the production
 * fatesky origin or a localhost/127.0.0.1 dev host.
 */
export function isAllowedParentOrigin(origin: string): boolean {
  return origin === FALLBACK_PARENT_ORIGIN || LOCALHOST_ORIGIN_RE.test(origin);
}

/** Whether DME is running inside a parent iframe on the web. */
export function isEmbedContext(): boolean {
  return (
    Platform.OS === 'web' &&
    typeof window !== 'undefined' &&
    window.parent !== window
  );
}

/**
 * Resolve the target origin for parent-bound postMessage calls from
 * `document.referrer`, falling back to `FALLBACK_PARENT_ORIGIN` when it is
 * missing, unparsable, or not whitelisted.
 */
export function resolveParentTargetOrigin(): string {
  if (!isEmbedContext()) {
    return FALLBACK_PARENT_ORIGIN;
  }
  const referrer = document.referrer;
  if (!referrer) {
    return FALLBACK_PARENT_ORIGIN;
  }
  try {
    const origin = new URL(referrer).origin;
    return isAllowedParentOrigin(origin) ? origin : FALLBACK_PARENT_ORIGIN;
  } catch {
    return FALLBACK_PARENT_ORIGIN;
  }
}
