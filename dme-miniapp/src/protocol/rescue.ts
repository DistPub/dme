/**
 * protocol/rescue.ts - 1v1 rescue handshake message types.
 *
 * Rescue messages are exchanged over a queueId derived from the long-term
 * identity X25519 keys of both parties. They carry only the data needed to
 * re-run the initial QR handshake and establish a fresh 1v1 MLS session.
 */

/** A rescue request sent by the party that believes the session is stuck. */
export interface RescueMessage {
  /** Message type discriminator. */
  type: 'need_rescue';
  /** DID of the party requesting rescue. */
  fromDid: string;
  /** Standard QR payload (base64url) produced by prepareInviteQr(). */
  qrData: string;
  /** Callback queueId where the rescuer should deliver the Welcome. */
  callbackQueueId: string;
  /** ISO-8601 timestamp when the message was created. */
  sentAt: string;
  /** Single-use nonce to prevent replay. */
  nonce: string;
  /** Ed25519 signature over the canonical JSON of the fields above. */
  signature: string;
}

/** Stored on the rescuer side while waiting for user confirmation. */
export interface PendingRescueInvite {
  /** Local date (YYYY-MM-DD) when the invite was received. Only shown today. */
  date: string;
  /** DID of the party requesting rescue. */
  fromDid: string;
  /** QR payload that can be passed to acceptInvite(). */
  qrData: string;
  /** Callback queueId where the Welcome should be delivered. */
  callbackQueueId: string;
}

/** Stored on the rescue-requester side while waiting for the Welcome. */
export interface PendingRescueCallback {
  /** Local date (YYYY-MM-DD) when the request was sent. */
  date: string;
  /** Welcome queueId to poll. */
  callbackQueueId: string;
}
