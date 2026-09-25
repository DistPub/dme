/**
 * utils/video-thumbnail.ts - Generate a local first-frame thumbnail for a video.
 *
 * Native: uses expo-video-thumbnails to extract the first frame and copies it
 *   into documentDirectory as `{thumbKey}_thumb.jpg`.
 * Web: reads the cached video bytes from IndexedDB (`indexeddb://{fileId}`),
 *   draws the first frame onto a <canvas>, and caches the JPEG back into
 *   IndexedDB under the key `{thumbKey}_thumb`.
 *
 * Any failure returns null (never throws).
 */

import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system';

import {
  cacheFile,
  getCachedFileBytes,
  isIndexedDbUri,
  makeIndexedDbUri,
} from './file-cache';

const INDEXEDDB_PREFIX = 'indexeddb://';

export interface GenerateVideoThumbnailOptions {
  sourceUri: string;
  mimeType: string;
  thumbKey: string;
}

/** Resolve when the video fires `event`; reject on media error or timeout. */
function waitForVideoEvent(video: HTMLVideoElement, event: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onEvent = (): void => {
      finish();
      resolve();
    };
    const onError = (): void => {
      finish();
      reject(new Error(`video ${event} failed`));
    };
    const finish = (): void => {
      if (timer) clearTimeout(timer);
      video.removeEventListener(event, onEvent);
      video.removeEventListener('error', onError);
    };
    timer = setTimeout(() => {
      finish();
      reject(new Error(`video ${event} timed out`));
    }, 10000);
    video.addEventListener(event, onEvent);
    video.addEventListener('error', onError);
  });
}

async function generateWebThumbnail(opts: GenerateVideoThumbnailOptions): Promise<string | null> {
  if (!isIndexedDbUri(opts.sourceUri)) {
    console.warn(`web: sourceUri is not an indexeddb URI (${opts.sourceUri})`);
    return null;
  }

  const fileId = opts.sourceUri.slice(INDEXEDDB_PREFIX.length);
  const bytes = await getCachedFileBytes(fileId);
  if (!bytes) {
    console.warn(`web: getCachedFileBytes empty for ${fileId}`);
    return null;
  }

  // getCachedFileBytes stores a real ArrayBuffer in IndexedDB, but the TS lib
  // types its buffer as ArrayBufferLike (may include SharedArrayBuffer).
  const blob = new Blob([bytes.buffer as ArrayBuffer], { type: opts.mimeType });
  const objectUrl = URL.createObjectURL(blob);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'metadata';
  // opacity:0 + off-screen + sizeable dimensions: some browsers skip decoding
  // for visibility:hidden or 1x1 elements, so keep a real decoding surface.
  video.style.position = 'fixed';
  video.style.top = '-9999px';
  video.style.left = '-9999px';
  video.style.width = '640px';
  video.style.height = '480px';
  video.style.opacity = '0';
  video.style.pointerEvents = 'none';
  video.style.zIndex = '-1';

  try {
    video.src = objectUrl;
    // Some browsers (Safari / iOS WebView) refuse to decode media metadata
    // while the <video> element is detached from the DOM. Insert it hidden,
    // then explicitly call load() so loadedmetadata/seeked fire reliably.
    document.body.appendChild(video);
    video.load();
    await waitForVideoEvent(video, 'loadedmetadata');

    if (!video.videoWidth || !video.videoHeight) {
      // readyState may already be 4, but explicitly wait for canplay to make
      // sure the browser has decoded enough to report dimensions.
      try {
        await waitForVideoEvent(video, 'canplay');
      } catch {
        // canplay may not fire; fall through to the diagnostic below.
      }
    }

    if (!video.videoWidth || !video.videoHeight) {
      const videoTracks = (video as HTMLVideoElement & { videoTracks?: { length: number } }).videoTracks;
      if (video.duration > 0) {
        console.warn(
          `web: video codec not supported by browser (audio-only or unsupported codec, duration=${video.duration}s, mimeType=${opts.mimeType})`,
        );
      } else {
        console.warn(
          `web: zero dimensions (${video.videoWidth}x${video.videoHeight}) readyState=${video.readyState} duration=${video.duration} videoTracks=${videoTracks?.length ?? '?'} bytes=${bytes.length} blobSize=${blob.size} mimeType=${opts.mimeType}`,
        );
      }
      return null;
    }

    // Seek slightly past the first frame to avoid blank/key frames.
    video.currentTime = 0.1;
    await waitForVideoEvent(video, 'seeked');

    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      console.warn('web: canvas 2d context null');
      return null;
    }
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    const jpegBlob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.7);
    });
    if (!jpegBlob) {
      console.warn('web: canvas toBlob returned null');
      return null;
    }

    const buf = new Uint8Array(await jpegBlob.arrayBuffer());
    const thumbFileId = `${opts.thumbKey}_thumb`;
    await cacheFile(thumbFileId, buf, 'image/jpeg');
    return makeIndexedDbUri(thumbFileId);
  } catch (err) {
    console.warn(
      `web: video load/seek failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  } finally {
    URL.revokeObjectURL(objectUrl);
    video.remove();
  }
}

async function generateNativeThumbnail(
  opts: GenerateVideoThumbnailOptions,
): Promise<string | null> {
  const targetDir = FileSystem.documentDirectory;
  if (!targetDir) {
    console.warn('native: documentDirectory unavailable');
    return null;
  }

  if (!opts.sourceUri) {
    console.warn('native: sourceUri empty');
    return null;
  }

  try {
    const { getThumbnailAsync } = await import('expo-video-thumbnails');
    const result = await getThumbnailAsync(opts.sourceUri, {
      time: 0,
      quality: 0.7,
    });

    const target = `${targetDir}${opts.thumbKey}_thumb.jpg`;
    await FileSystem.copyAsync({ from: result.uri, to: target });
    return target;
  } catch (err) {
    console.warn(
      `native: getThumbnailAsync failed for ${opts.sourceUri}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/**
 * Generate and cache a local first-frame thumbnail for a video file.
 * Returns the local URI (native path or `indexeddb://{thumbKey}_thumb`),
 * or null if the thumbnail cannot be generated.
 */
export async function generateVideoThumbnail(
  opts: GenerateVideoThumbnailOptions,
): Promise<string | null> {
  try {
    if (Platform.OS === 'web') {
      return await generateWebThumbnail(opts);
    }
    return await generateNativeThumbnail(opts);
  } catch (err) {
    console.warn(
      `generateVideoThumbnail: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}
