/**
 * ui/VideoViewerScreen.tsx - Full-screen video viewer with system controls.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, Share, StyleSheet, Text, View } from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import type { NativeStackNavigationProp, NativeStackScreenProps } from '@react-navigation/native-stack';
import { VideoView, useVideoPlayer } from 'expo-video';
import * as FileSystem from 'expo-file-system';

import { Button } from './Button';
import { theme } from './theme';
import { getCachedFileBytes, INDEXEDDB_PREFIX, isIndexedDbUri, useFileUri } from '../utils/file-cache';
import type { RootStackParamList } from '../types/navigation';

type Navigation = NativeStackNavigationProp<RootStackParamList>;
type VideoViewerRouteProp = NativeStackScreenProps<RootStackParamList, 'VideoViewer'>['route'];

interface VideoPlaybackProps {
  readonly uri: string;
  readonly onError: () => void;
}

function VideoPlayback({ uri, onError }: VideoPlaybackProps): React.JSX.Element {
  const player = useVideoPlayer({ uri }, (p) => {
    p.muted = true;
    p.play();
  });

  useEffect(() => {
    player.muted = true;
    player.play();
  }, [player]);

  useEffect(() => {
    const subscription = player.addListener('statusChange', ({ status }) => {
      if (status === 'error') {
        onError();
      }
    });
    return () => subscription.remove();
  }, [player, onError]);

  return (
    <VideoView
      player={player}
      nativeControls
      contentFit="contain"
      style={styles.video}
    />
  );
}

async function downloadVideoWeb(
  sourceUri: string,
  resolvedUri: string | undefined,
  fileName: string | undefined,
): Promise<void> {
  let blob: Blob;
  if (isIndexedDbUri(sourceUri)) {
    const fileId = sourceUri.slice(INDEXEDDB_PREFIX.length);
    const bytes = await getCachedFileBytes(fileId);
    if (!bytes) {
      throw new Error('cached video bytes not found');
    }
    if (!(bytes.buffer instanceof ArrayBuffer)) {
      throw new Error('cached video buffer is not a plain ArrayBuffer');
    }
    blob = new Blob([bytes.buffer], { type: 'video/mp4' });
  } else if (resolvedUri?.startsWith('blob:')) {
    const response = await fetch(resolvedUri);
    blob = await response.blob();
  } else {
    throw new Error('unsupported video URI for download');
  }

  const blobUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = blobUrl;
  anchor.download = fileName ?? 'video.mp4';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(blobUrl);
}

async function downloadVideoNative(sourceUri: string, fileName: string | undefined): Promise<void> {
  const info = await FileSystem.getInfoAsync(sourceUri);
  if (!info.exists) {
    throw new Error('video file not found');
  }
  await Share.share({
    title: fileName ?? '保存视频',
    url: sourceUri,
  });
}

export function VideoViewerScreen(): React.JSX.Element {
  const navigation = useNavigation<Navigation>();
  const route = useRoute<VideoViewerRouteProp>();
  const { uri, fileName } = route.params;
  const resolvedUri = useFileUri(uri);
  const [hasError, setHasError] = useState(false);
  const [decoding, setDecoding] = useState<'checking' | 'ok' | 'unsupported'>(
    Platform.OS === 'web' ? 'checking' : 'ok',
  );

  useEffect(() => {
    if (resolvedUri) {
      setHasError(false);
    }
  }, [resolvedUri]);

  useEffect(() => {
    if (Platform.OS !== 'web') {
      setDecoding('ok');
      return;
    }

    if (!resolvedUri) {
      setDecoding('checking');
      return;
    }
    const source: string = resolvedUri;

    let cancelled = false;
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'metadata';
    video.style.position = 'fixed';
    video.style.top = '-9999px';
    video.style.left = '-9999px';
    video.style.width = '640px';
    video.style.height = '480px';
    video.style.opacity = '0';
    video.style.pointerEvents = 'none';
    video.style.zIndex = '-1';

    let timer: ReturnType<typeof setTimeout> | undefined;
    let rejectPromise: (reason: Error) => void = () => {};

    function cleanup(): void {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      rejectPromise(new Error('video precheck cancelled'));
      video.remove();
    }

    async function runCheck(): Promise<void> {
      try {
        await new Promise<void>((resolve, reject) => {
          rejectPromise = reject;
          const onLoaded = (): void => resolve();
          const onError = (): void => reject(new Error('video load failed'));
          video.addEventListener('loadedmetadata', onLoaded, { once: true });
          video.addEventListener('error', onError, { once: true });
          timer = setTimeout(() => {
            reject(new Error('video load timed out'));
          }, 10000);
          video.src = source;
          document.body.appendChild(video);
          video.load();
        });

        if (cancelled) return;
        if (video.videoWidth > 0 && video.videoHeight > 0) {
          setDecoding('ok');
        } else {
          console.warn(
            `web: video decoding not supported (dimensions ${video.videoWidth}x${video.videoHeight})`,
          );
          setDecoding('unsupported');
        }
      } catch (err) {
        if (cancelled) return;
        console.warn(
          `web: video precheck failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        setDecoding('unsupported');
      } finally {
        cleanup();
      }
    }

    runCheck();
    return () => {
      cancelled = true;
      cleanup();
    };
  }, [resolvedUri]);

  const handleError = useCallback(() => {
    setHasError(true);
  }, []);

  const handleDownload = useCallback(async () => {
    try {
      if (Platform.OS === 'web') {
        await downloadVideoWeb(uri, resolvedUri, fileName);
      } else {
        await downloadVideoNative(uri, fileName);
      }
    } catch (e) {
      console.warn('download video failed:', e instanceof Error ? e.message : String(e));
    }
  }, [uri, resolvedUri, fileName]);

  return (
    <View style={styles.container}>
      <View style={styles.videoWrapper}>
        {decoding === 'checking' || !resolvedUri ? (
          <ActivityIndicator size="large" color={theme.colors.textPrimary} />
        ) : decoding === 'unsupported' || hasError ? (
          <View style={styles.errorContainer}>
            <Text style={styles.errorText}>
              浏览器不支持视频解码，请下载到本地用其他播放器播放
            </Text>
            <Button label="下载" onPress={handleDownload} variant="primary" style={styles.downloadButton} />
          </View>
        ) : (
          <VideoPlayback uri={resolvedUri} onError={handleError} />
        )}
      </View>

      <Pressable style={styles.closeButton} onPress={() => navigation.goBack()}>
        <Text style={styles.closeText}>✕</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000000',
  },
  videoWrapper: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  video: {
    width: '100%',
    height: '100%',
  },
  errorContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: theme.spacing.lg,
  },
  errorText: {
    color: theme.colors.textPrimary,
    fontSize: theme.typography.body,
    textAlign: 'center',
    marginBottom: theme.spacing.lg,
  },
  downloadButton: {
    width: 160,
    height: 48,
  },
  closeButton: {
    position: 'absolute',
    top: theme.spacing.lg,
    right: theme.spacing.lg,
    width: 40,
    height: 40,
    borderRadius: theme.borderRadius.full,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  closeText: {
    color: theme.colors.textPrimary,
    fontSize: 20,
    fontWeight: '600',
  },
});
