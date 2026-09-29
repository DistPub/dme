/**
 * crypto/rng.ts - ts-mls `Rng` interface backed by @noble/hashes utils.
 *
 * ts-mls's defaultRng references the global `crypto.getRandomValues` directly.
 * In React Native that global may not exist, and on the web we want a stable
 * source that matches the rest of the @noble stack. `randomBytes` from
 * @noble/hashes/utils uses `crypto.getRandomValues` when available and falls
 * back to `crypto.randomBytes` in Node-like environments, throwing if neither
 * is present. That is sufficient for dme-client (web + RN).
 */

import { randomBytes } from '@noble/hashes/utils';
import { crypto as nobleCrypto } from '@noble/hashes/crypto';
import type { Rng } from 'ts-mls';

/** Pure-JS randomness source that never touches WebCrypto `subtle`. */
export const nobleRng: Rng = {
  randomBytes(n: number): Uint8Array {
    try {
      return randomBytes(n);
    } catch (err) {
      const c = nobleCrypto as { getRandomValues?: (o: Uint8Array) => Uint8Array } | undefined;
      if (c && typeof c.getRandomValues === 'function') {
        return c.getRandomValues(new Uint8Array(n));
      }
      throw err;
    }
  },
};
