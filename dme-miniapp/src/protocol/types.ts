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

  /**
   * 群 commit 谱系序号（P1，group-fork-plan.md 3.1）。仅群 commit 信封携带：
   * per-group 单调递增，commit 发起方按本地谱系账本 last+1 填写。
   * 放在信封明文（MLS 密文之外）是设计核心——分叉后对方谱系的信封解不开，
   * 只有明文元数据是两条谱系仍共享的观测面（检测器唯一可用的信号源）。
   */
  groupSeq?: number;

  /**
   * 本 commit 引用的上一条 commit 信封的 queueId（谱系成链；组的首条 commit
   * 缺省）。P1 仅记录不判定：1v1 通道扇出的同一逻辑 commit 每份副本 queueId
   * 不同，收端只能见到自己那份，跨端 parent 比对会误报，留待后续方案细化。
   */
  parentQueueId?: string;
}

/** File download status. */
export type FileDownloadStatus = 'pending' | 'downloading' | 'ready' | 'failed';

/** File upload status. */
export type FileUploadStatus = 'uploading' | 'uploaded' | 'failed';

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
  /**
   * 下载/发送后生成的视频首帧缩略图 URI（web 为 indexeddb://，native 为 documentDirectory 文件 URI）；
   * 缺失时 UI 回退 ▶ 卡片。
   */
  readonly thumbnailPath?: string;
  readonly downloadStatus: FileDownloadStatus;
  readonly uploadStatus?: FileUploadStatus;
  readonly uploadProgress?: number;
  readonly downloadProgress?: number;
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
/**
 * 备份记录外层明文元数据：只做展示与覆盖提示，不做机器方向判定，
 * 恢复流程完全不读它（永不随恢复流转）。会话指纹用身份签名私钥派生
 * 的 HMAC key 计算，云端只能比对「是否包含某会话」，不泄露 groupId。
 */
export interface BackupMeta {
  /** 设备短码（安装期随机生成、持久化于本机 storage，不进加密载荷）。 */
  deviceId: string;
  /** 平台标签：web / ios / android / miniapp。 */
  platform: string;
  /** 全部本机会话的 HMAC 指纹（与加密载荷内的会话集合一致）。 */
  sessionFps: string[];
  /**
   * 写这份备份时的账号级 commit 高水位（宣言 v2）。
   *
   * v3 修正（2026-10-27）新增：这是判定「恢复备份能否修好」的关键依据——
   * 宣言高水位 seq 若 ≤ 本字段，说明这份备份写于该次推进**之后**，恢复它
   * 能拿到推进后的状态（stale，恢复备份有效）；若 > 本字段，说明备份写于
   * 推进**之前**，恢复只会倒灌旧状态、修不好（adopt，须接管高水位）。
   *
   * 旧记录无此字段 → 视为 undefined（按「无法证明覆盖」处理，即 adopt）。
   */
  commitSeq?: number;
}

export interface IdentityBackupRecord {
  $type: 'dme.backup.identity';
  encryptedData: string;
  createdAt: string;
  /** 外层明文元数据（2026-10-19 起）。旧记录无此字段 → 视为 unknown，提示逻辑降级放行。 */
  meta?: BackupMeta;
}

/** Lexicon NSID for the key-rotation claim record. */
export const DME_ROTATION_CLAIM_NSID = 'dme.rotation.claim' as const;

/**
 * PDS record declaring "this device performs the upcoming rotation commit".
 * rkey 由 pre-commit exporterSecret 派生（本 epoch 所有端一致）；payload 为
 * HKDF(exporterSecret) 派生密钥加密的宣言内容（仓库公开可读，必须不透明）。
 */
export interface RotationClaimRecord {
  $type: 'dme.rotation.claim';
  /** base64url(iv(12) || AES-256-GCM ciphertext)。 */
  payload: string;
  createdAt: string;
}
