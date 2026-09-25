/**
 * utils/file-export.ts - Export a local file to the device / browser download.
 */

import { Platform, Share } from 'react-native';
import * as FileSystem from 'expo-file-system';

import { getCachedFileBytes, INDEXEDDB_PREFIX, isIndexedDbUri } from './file-cache';

export async function exportFileToDevice(
  sourceUri: string,
  fileName: string,
  mimeType: string,
): Promise<void> {
  if (Platform.OS === 'web') {
    let blob: Blob;
    if (isIndexedDbUri(sourceUri)) {
      const fileId = sourceUri.slice(INDEXEDDB_PREFIX.length);
      const bytes = await getCachedFileBytes(fileId);
      if (!bytes) {
        throw new Error('exportFileToDevice: cached bytes not found');
      }
      if (!(bytes.buffer instanceof ArrayBuffer)) {
        throw new Error('exportFileToDevice: cached file buffer is not a plain ArrayBuffer');
      }
      blob = new Blob([bytes.buffer], { type: mimeType });
    } else if (sourceUri.startsWith('blob:')) {
      const response = await fetch(sourceUri);
      blob = await response.blob();
    } else {
      throw new Error('exportFileToDevice: unsupported web source URI');
    }

    const blobUrl = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = blobUrl;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => {
      URL.revokeObjectURL(blobUrl);
    }, 1000);
    return;
  }

  const info = await FileSystem.getInfoAsync(sourceUri);
  if (!info.exists) {
    throw new Error('exportFileToDevice: file not found');
  }
  await Share.share({
    title: fileName,
    url: sourceUri,
  });
}
