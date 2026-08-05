/**
 * DME protocol types.
 *
 * The Lexicon itself lives in lexicons/dme.queue.envelope.json.
 * This file mirrors the Lexicon in TypeScript for type safety.
 *
 * MLS messages carry their own epoch in the wire format, so no
 * explicit epoch field is needed on the envelope.
 */

/**
 * MLS message type distinguishes application messages from group
 * management operations. The server uses this for routing decisions
 * (e.g., Welcome messages go to a different queueId than application
 * messages).
 */
export type MessageType = 'application' | 'commit' | 'welcome';

export interface DmeBlobRef {
  readonly $type: 'blob';
  readonly ref: { readonly $link: string };
  readonly mimeType: string;
  readonly size: number;
}

export interface DmeEnvelope {
  /** Lexicon type identifier. */
  $type: 'dme.queue.envelope';

  /**
   * QueueID - derived from MLS state (Welcome: SHA-256 of KeyPackage
   * initKey; Application: MLS exporter secret + leaf index + generation).
   * Used as the lookup key when polling via the gateway. Server and
   * AppView use this as the primary key in their KV store.
   */
  queueId: string;

  /**
   * Base64url-encoded MLS message bytes. Contains the full MLS wire
   * format (including epoch, framing, and AEAD ciphertext).
   */
  payload: string;

  /** ISO 8601 timestamp of when the envelope was created. */
  createdAt: string;

  /**
   * MLS message type. Distinguishes application messages from
   * commit/welcome group management operations.
   */
  messageType?: MessageType;

  /**
   * Standard ATProtocol blob references for the encrypted file chunks.
   * Present on file-manifest envelopes so the PDS recognizes and preserves
   * the blobs (preventing GC). Sent in plaintext on the record (outside the
   * MLS-encrypted payload); the manifest itself stays end-to-end encrypted.
   */
  blobCids?: DmeBlobRef[];
}

/** File download status. */
export type FileDownloadStatus = 'pending' | 'downloading' | 'ready' | 'failed';

/** Metadata for file messages stored locally. Stored in StoredMessage.fileMeta. */
export interface FileMeta {
  readonly fileId: string;
  readonly fileName: string;
  readonly fileSize: number;
  readonly mimeType: string;
  readonly sha256: string;
  readonly chunkCount: number;
  readonly chunkSize: number;
  readonly fileKey: string; // base64url-encoded 32-byte random key
  readonly localPath?: string; // filled after download
  readonly downloadStatus: FileDownloadStatus;
  readonly blobCids?: DmeBlobRef[];
}

/** Encrypted file manifest sent via MLS application message. */
export interface FileManifestMessage {
  readonly type: 'file';
  readonly fileId: string;
  readonly fileName: string;
  readonly fileSize: number;
  readonly mimeType: string;
  readonly sha256: string;
  readonly chunkCount: number;
  readonly chunkSize: number;
  readonly fileKey: string; // base64url-encoded
}

/** Type discriminator for file manifest messages. */
export const FILE_MANIFEST_TYPE = 'file' as const;

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

/** Lexicon NSID for the identity backup record. */
export const DME_BACKUP_NSID = 'dme.backup.identity' as const;

/** PDS record storing password-encrypted identity private keys. */
export interface IdentityBackupRecord {
  $type: 'dme.backup.identity';
  encryptedData: string;
  createdAt: string;
}
