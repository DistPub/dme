/**
 * platform/file-cache.ts - 本地文件缓存（替代 web 的 IndexedDB）。
 *
 * web 端把文件字节存进 IndexedDB，用 `indexeddb://<fileId>` 当稳定的
 * `localPath`，渲染时再转成 blob URL（`utils/file-cache.ts`）。
 *
 * 小程序没有 IndexedDB，改为把文件直接写进 `USER_DATA_PATH/dme-files/`，
 * **文件路径本身就是可用的 localPath**——`<Image src>`、`InnerAudioContext.src`、
 * `Taro.downloadFile` 都能直接吃。所以 web 的 `makeIndexedDbUri` / `useFileUri`
 * 这一层在小程序里**整体不需要**。
 *
 * ⚠️ `Taro.env.USER_DATA_PATH` 配额约 200MB，是**用户数据目录**而非缓存目录，
 *    不会被自动清理。所以：
 *    - 只放「自己发出的文件副本」与「已下载的文件」；
 *    - 提供 `deleteCachedFile()` / `clearCacheDir()` 供后续做容量治理
 *      （目前未接 UI，遵守「不做 web 没有的功能」原则）。
 *
 * ⚠️ 所有 `FileSystemManager` 同步方法（accessSync 等）在小程序里是**同步阻塞**
 *    调用，只用于存在性判断这类轻量场景，不要用在大文件读写上。
 */

import Taro from '@tarojs/taro';

import { base64ToBytes } from '../crypto/utils';
import { toArrayBuffer } from './http';

const DIR_NAME = 'dme-files';

let dirReady = false;

function fs(): Taro.FileSystemManager {
  return Taro.getFileSystemManager();
}

/** `USER_DATA_PATH` 在部分环境可能缺省，这里显式兜底并给出可诊断的错误。 */
function userDataPath(): string {
  const path = Taro.env?.USER_DATA_PATH;
  if (!path) {
    throw new Error('file-cache: 当前环境不支持 Taro.env.USER_DATA_PATH（无法缓存文件）');
  }
  return path;
}

function cacheDir(): string {
  return `${userDataPath()}/${DIR_NAME}`;
}

/** 去掉路径分隔符与非常规字符，避免拼出越界路径。 */
function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}

/** 缓存目录下的稳定路径（fileId 前缀保证同一文件不互相覆盖）。 */
export function cachedFilePath(fileIdHex: string, fileName: string): string {
  return `${cacheDir()}/${fileIdHex}_${sanitize(fileName)}`;
}

/** 保证缓存目录存在（幂等）。 */
export async function ensureCacheDir(): Promise<void> {
  if (dirReady) return;
  const dir = cacheDir();
  try {
    fs().accessSync(dir);
    dirReady = true;
    return;
  } catch {
    // 目录不存在，走下面的创建
  }

  await new Promise<void>((resolve, reject) => {
    fs().mkdir({
      dirPath: dir,
      recursive: true,
      success: () => resolve(),
      fail: (err) => {
        // 并发创建时可能已被别的调用建好，再探测一次
        try {
          fs().accessSync(dir);
          resolve();
          return;
        } catch {
          /* 确实失败 */
        }
        reject(new Error(`file-cache: 创建缓存目录失败 ${err.errMsg}`));
      },
    });
  });
  dirReady = true;
}

/** 文件是否存在。 */
export function fileExists(filePath: string): boolean {
  try {
    fs().accessSync(filePath);
    return true;
  } catch {
    return false;
  }
}

/** 文件字节数（不存在时抛错）。 */
export function fileSize(filePath: string): number {
  const stat = fs().statSync(filePath) as unknown as { size?: number; stats?: { size: number } };
  const size = stat.size ?? stat.stats?.size;
  if (typeof size !== 'number') {
    throw new Error(`file-cache: 无法获取文件大小 ${filePath}`);
  }
  return size;
}

/** 把 picker 返回的临时文件复制进缓存目录（等价 web 的「先落盘再上传」）。 */
export async function copyIntoCache(
  srcPath: string,
  fileIdHex: string,
  fileName: string,
): Promise<string> {
  await ensureCacheDir();
  const destPath = cachedFilePath(fileIdHex, fileName);
  await new Promise<void>((resolve, reject) => {
    fs().copyFile({
      srcPath,
      destPath,
      success: () => resolve(),
      fail: (err) => reject(new Error(`file-cache: 复制文件失败 ${err.errMsg}`)),
    });
  });
  return destPath;
}

/** 把字节写入缓存目录（下载完成后落盘）。 */
export async function writeBytesToCache(
  fileIdHex: string,
  fileName: string,
  bytes: Uint8Array,
): Promise<string> {
  await ensureCacheDir();
  const destPath = cachedFilePath(fileIdHex, fileName);
  await new Promise<void>((resolve, reject) => {
    fs().writeFile({
      filePath: destPath,
      data: toArrayBuffer(bytes),
      success: () => resolve(),
      fail: (err) => reject(new Error(`file-cache: 写入文件失败 ${err.errMsg}`)),
    });
  });
  return destPath;
}

/**
 * 读取文件的一段（base64 中转，与 web 的非 web 分支完全同构）。
 *
 * `readFile` 的 `[position, position + length)` 是左闭右开区间，
 * 与 web `expo-file-system.readAsStringAsync({ position, length })` 语义一致。
 */
export async function readFileChunk(
  filePath: string,
  offset: number,
  length: number,
): Promise<Uint8Array> {
  const base64 = await new Promise<string>((resolve, reject) => {
    fs().readFile({
      filePath,
      position: offset,
      length,
      encoding: 'base64',
      success: (res) => resolve(typeof res.data === 'string' ? res.data : ''),
      fail: (err) => reject(new Error(`file-cache: 读取文件片段失败 ${err.errMsg}`)),
    });
  });
  return base64ToBytes(base64);
}

/** 读取整个文件。 */
export async function readFileBytes(filePath: string): Promise<Uint8Array> {
  const data = await new Promise<string | ArrayBuffer>((resolve, reject) => {
    fs().readFile({
      filePath,
      success: (res) => resolve(res.data),
      fail: (err) => reject(new Error(`file-cache: 读取文件失败 ${err.errMsg}`)),
    });
  });
  return data instanceof ArrayBuffer ? new Uint8Array(data) : base64ToBytes(data);
}

/** 删除单个文件（失败只告警，不抛错）。也用于清理 `downloadFile` 的临时文件。 */
export function removeFile(filePath: string): void {
  try {
    fs().unlinkSync(filePath);
  } catch (err) {
    console.warn('file-cache: 删除文件失败', filePath, err);
  }
}

/** 清空缓存目录（供后续容量治理使用）。 */
export function clearCacheDir(): void {
  try {
    fs().rmdirSync(cacheDir(), true);
  } catch (err) {
    console.warn('file-cache: 清空缓存目录失败', err);
  }
  dirReady = false;
}
