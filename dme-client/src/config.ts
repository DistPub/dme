/** 默认 Bluesky PDS base URL,用户可在登录页覆盖。 */
export const PDS_URL = 'https://network.hukoubook.com';

/** DME server base URL (direct or via gateway, client doesn't distinguish). */
export const DME_SERVER_URL = 'http://localhost:8080';

/** PLC directory base URL. */
export const PLC_DIRECTORY_URL = 'https://plc.directory';

/** Handshake polling interval in ms (shorter than normal message polling). */
export const HANDSHAKE_POLL_INTERVAL_MS = 1500;

/** Handshake timeout in ms (2 minutes). */
export const HANDSHAKE_TIMEOUT_MS = 120_000;
