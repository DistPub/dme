/**
 * DME protocol types.
 *
 * The Lexicon itself lives in lexicons/dme.queue.envelope.json.
 * This file mirrors the Lexicon in TypeScript for type safety.
 */

export interface DmeEnvelope {
  /** Lexicon type identifier. */
  $type: 'dme.queue.envelope';

  /**
   * QueueID - the hash of the current ratchet state. Used as the lookup
   * key when polling via the gateway. Server and AppView use this
   * as the primary key in their KV store.
   */
  queueId: string;

  /**
   * Base64url-encoded ciphertext. Symmetrically encrypted with the
   * message key derived from the current ratchet state.
   */
  payload: string;

  /** ISO 8601 timestamp of when the envelope was created. */
  createdAt: string;

  /**
   * Ratchet epoch number. Allows the recipient to skip ahead when
   * they poll future queueIds and miss some intermediate states.
   */
  ratchetEpoch?: number;
}

/**
 * The Lexicon NSID (Namespaced Identifier) for the envelope record.
 * Used in PDS createRecord calls.
 */
export const DME_ENVELOPE_NSID = 'dme.queue.envelope' as const;

/**
 * TTL for envelopes on the server and AppView (7 days).
 * After this period, the ciphertext is physically destroyed.
 */
export const ENVELOPE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
