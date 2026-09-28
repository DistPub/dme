/**
 * platform/file-transfer.ts - 分块加密上传 / blob 下载。
 *
 * 等价 web `dme-client/src/state/AppContext.tsx` 里的
 * `uploadFileChunks()` + `uploadBlobWithProgress()`，但不绑定 PDS：
 * 读取与上传两端都通过参数注入，这样单测/复用都更容易。
 *
 * ⚠️ 上传**不能**用 `wx.uploadFile`：它强制 `multipart/form-data`，而
 *    `com.atproto.repo.uploadBlob` 要求 raw `application/octet-stream`
 *    （DME 是字节精确的，接收端按 chunkSize 切分解密）。
 *    上传单元是**内存里的密文 Uint8Array**，不是磁盘文件。
 *    详见 IMPROVEMENT-PLAN.md §4.1。
 *
 * 进度策略：`Taro.request` 没有上传进度事件，所以进度按「已上传密文字节 /
 * 预计总密文字节」计算（每个 5MB 分片加密后固定 +16 字节 GCM tag）。
 * 粒度是分片级，UI 上不要承诺精确百分比。
 */

import Taro from '@tarojs/taro';
import { sha256 } from '@noble/hashes/sha256';

import type { DmeBlobRef } from '../protocol/types';
import { bytesToHex } from '../crypto/utils';
import { encryptChunk } from '../crypto/file-crypto';
import { xrpcGetBytes } from './http';
import { removeFile, readFileBytes } from './file-cache';

/** 与 web 一致：5MB 分片。 */
export const FILE_CHUNK_SIZE = 5 * 1024 * 1024;

export interface UploadFileChunksParams {
  fileSize: number;
  /** 默认 5MB；重试上传时沿用 `fileMeta.chunkSize`。 */
  chunkSize?: number;
  fileKey: Uint8Array;
  fileId: Uint8Array;
  /** 读取明文的第 [offset, offset + readSize) 段。 */
  readChunk: (offset: number, readSize: number) => Promise<Uint8Array>;
  /** 上传一段密文，返回 blob 引用。 */
  uploadChunk: (encrypted: Uint8Array, chunkIndex: number) => Promise<DmeBlobRef>;
  onProgress?: (progress: number) => void;
}

export interface UploadFileChunksResult {
  blobRefs: DmeBlobRef[];
  /** 明文的 SHA-256（hex）。 */
  sha256: string;
  chunkCount: number;
}

/**
 * 逐块加密上传。与 web 实现逐行同构，只是把网络层抽成 `uploadChunk`。
 */
export async function uploadFileChunks(
  params: UploadFileChunksParams,
): Promise<UploadFileChunksResult> {
  const chunkSize = params.chunkSize && params.chunkSize > 0 ? params.chunkSize : FILE_CHUNK_SIZE;
  const hasher = sha256.create();
  const blobRefs: DmeBlobRef[] = [];

  let offset = 0;
  let chunkIndex = 0;
  let uploadedBytes = 0;
  // 每片加密后固定增加 16 字节 GCM tag
  const totalEncryptedBytes = params.fileSize + Math.ceil(params.fileSize / chunkSize) * 16;

  while (offset < params.fileSize) {
    const readSize = Math.min(chunkSize, params.fileSize - offset);
    const block = await params.readChunk(offset, readSize);
    hasher.update(block);

    const encrypted = await encryptChunk(block, params.fileKey, params.fileId, chunkIndex);
    const blobRef = await params.uploadChunk(encrypted, chunkIndex);
    blobRefs.push(blobRef);

    uploadedBytes += encrypted.byteLength;
    params.onProgress?.(Math.min(99, Math.round((uploadedBytes / totalEncryptedBytes) * 100)));

    offset += readSize;
    chunkIndex++;
  }

  return {
    blobRefs,
    sha256: bytesToHex(hasher.digest()),
    chunkCount: chunkIndex,
  };
}

export interface DownloadBlobResult {
  bytes: Uint8Array;
  /** 实际走的通道，便于诊断（downloadFile 有字节级进度，request 没有）。 */
  via: 'downloadFile' | 'request';
}

/** `Taro.downloadFile` 包成 Promise + 进度回调。 */
function downloadFileToTempPath(
  url: string,
  onProgress?: (loaded: number, total: number) => void,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const task = Taro.downloadFile({
      url,
      timeout: 120_000,
      success: (res) => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(res.tempFilePath);
        } else {
          reject(new Error(`downloadBlob: HTTP ${res.statusCode}`));
        }
      },
      fail: (err) => reject(new Error(`downloadBlob: ${err.errMsg}`)),
    });

    if (onProgress && typeof task.onProgressUpdate === 'function') {
      task.onProgressUpdate((p) => onProgress(p.totalBytesWritten, p.totalBytesExpectedToWrite));
    }
  });
}

/**
 * 下载一个加密 blob 的全部字节。
 *
 * 主路径 `Taro.downloadFile`：GET，有 `DownloadTask.onProgressUpdate`
 * **字节级**进度（对应 web 的 `response.body.getReader()` 流式进度）。
 * 需要把下载域名加进「downloadFile 合法域名」。
 *
 * 回退路径 `Taro.request`（`xrpcGetBytes`）：只需「request 合法域名」，
 * 但没有字节级进度——此时只在开始/结束各报一次进度，UI 显示「下载中...」。
 */
export async function downloadBlobBytes(
  url: string,
  onProgress?: (loaded: number, total: number) => void,
): Promise<DownloadBlobResult> {
  try {
    const tempPath = await downloadFileToTempPath(url, onProgress);
    try {
      const bytes = await readFileBytes(tempPath);
      return { bytes, via: 'downloadFile' };
    } finally {
      // 临时目录由系统管理，但主动清理更干净
      removeFile(tempPath);
    }
  } catch (err) {
    console.warn('file-transfer: downloadFile 不可用，回退到 Taro.request（无字节级进度）', err);
  }

  const { bytes } = await xrpcGetBytes(url);
  onProgress?.(bytes.byteLength, bytes.byteLength);
  return { bytes, via: 'request' };
}
