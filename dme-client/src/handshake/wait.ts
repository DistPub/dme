/**
 * handshake/wait.ts - Polling-based handshake detection.
 *
 * Replaces the relay firehose subscription. During the X3DH handshake,
 * Alice publishes a QR code and waits for Bob to post his QueueID_1
 * envelope. Instead of subscribing to a WebSocket firehose (which
 * reveals timing patterns and requires a persistent connection), we
 * poll the DME server's batch endpoint at a short interval until the
 * envelope appears or the deadline expires.
 */

import type { DmeEnvelope } from '../protocol/index';
import type { DmePds } from '../atproto/pds';
import { HANDSHAKE_POLL_INTERVAL_MS, HANDSHAKE_TIMEOUT_MS } from '../config';

/**
 * Wait for a handshake envelope by polling the DME server.
 *
 * @param pds      - DmePds instance for batch envelope queries.
 * @param queueId1 - The QueueID Alice expects Bob to post.
 * @param timeoutMs - Maximum total wait time (default from config).
 * @param intervalMs - Poll interval (default from config).
 * @returns The first envelope matching queueId1.
 * @throws on timeout.
 */
export async function waitForHandshake(
  pds: DmePds,
  queueId1: string,
  timeoutMs = HANDSHAKE_TIMEOUT_MS,
  intervalMs = HANDSHAKE_POLL_INTERVAL_MS,
): Promise<DmeEnvelope> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const envelopes = await pds.batchGetEnvelopes([queueId1]);
    if (envelopes.length > 0) return envelopes[0];
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(
    `waitForHandshake: timed out after ${timeoutMs}ms waiting for ${queueId1}`,
  );
}
