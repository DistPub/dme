/** 默认 Bluesky PDS base URL,用户可在登录页覆盖。 */
export const PDS_URL = 'https://network.hukoubook.com';

/** 默认 AppView proxy，写入 PDS 时通过 atproto-proxy header 指定。 */
export const DEFAULT_APPVIEW_PROXY = 'did:web:fatesky.hukoubook.com#fatesky_appview';

/** DME server base URL (direct or via gateway, client doesn't distinguish). */
export const DME_SERVER_URL = 'http://localhost:8080';

/**
 * DME gateway (Cloudflare Worker) URL - 客户端面向的网关地址。
 * 空字符串表示直连 server（不经网关）。
 */
export const DEFAULT_DME_GATEWAY_URL = '';

/** PLC directory base URL. */
export const PLC_DIRECTORY_URL = 'https://plc.directory';

/** Handshake polling interval in ms (shorter than normal message polling). */
export const HANDSHAKE_POLL_INTERVAL_MS = 1500;

/** Handshake timeout in ms (2 minutes). */
export const HANDSHAKE_TIMEOUT_MS = 120_000;
