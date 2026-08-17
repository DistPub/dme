import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet, ActivityIndicator, TouchableOpacity, Pressable, Platform } from 'react-native';
import { Image } from 'expo-image';
import { theme } from './theme';
import { Button } from './Button';
import type { FileMeta } from '../protocol/types';
import type { Reaction } from '../storage/db';
import { useFileUri } from '../utils/file-cache';

interface FileMessageBubbleProps {
  fileMeta: FileMeta;
  isOutgoing: boolean;
  reactions?: Reaction[];
  currentDid?: string;
  senderDisplayName?: string;
  senderHandle?: string;
  senderAvatarUrl?: string | null;
  senderAvatarError?: boolean;
  onRetry?: () => void;
  onRetryUpload?: () => void;
  onDownload?: () => void;
  onImagePress?: () => void;
  onReactionPress?: (emoji: string) => void;
  onOpenPicker?: (layout: { x: number; y: number; width: number; height: number }) => void;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function FileMessageBubble({
  fileMeta,
  isOutgoing,
  reactions,
  currentDid,
  senderDisplayName,
  senderHandle,
  senderAvatarUrl,
  senderAvatarError,
  onRetry,
  onRetryUpload,
  onDownload,
  onImagePress,
  onReactionPress,
  onOpenPicker,
}: FileMessageBubbleProps): React.JSX.Element {
  const { fileName, fileSize, mimeType, downloadStatus, uploadStatus, localPath, uploadProgress, downloadProgress } = fileMeta;
  const resolvedUri = useFileUri(localPath);
  const isImage = mimeType.startsWith('image/');
  const isVideo = mimeType.startsWith('video/');
  const isAudio = mimeType.startsWith('audio/');
  const emojiBtnRef = useRef<View>(null);
  const [avatarError, setAvatarError] = useState(false);
  const [isPlayingAudio, setIsPlayingAudio] = useState(false);
  const webAudioRef = useRef<HTMLAudioElement | null>(null);
  const nativeSoundRef = useRef<any>(null);

  useEffect(() => {
    setAvatarError(false);
  }, [senderAvatarUrl]);

  useEffect(() => {
    return () => {
      if (Platform.OS === 'web') {
        if (webAudioRef.current) {
          webAudioRef.current.pause();
          webAudioRef.current.src = '';
          webAudioRef.current = null;
        }
      } else if (nativeSoundRef.current) {
        nativeSoundRef.current.unloadAsync().catch(() => {});
        nativeSoundRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (Platform.OS === 'web') {
      if (webAudioRef.current) {
        webAudioRef.current.pause();
        webAudioRef.current.src = '';
        webAudioRef.current = null;
      }
    } else if (nativeSoundRef.current) {
      nativeSoundRef.current.unloadAsync().catch(() => {});
      nativeSoundRef.current = null;
    }
    setIsPlayingAudio(false);
  }, [resolvedUri]);

  const handleAudioPress = useCallback(async () => {
    if (downloadStatus === 'pending') {
      onDownload?.();
      return;
    }
    if (downloadStatus !== 'ready' || !resolvedUri) return;

    try {
      if (Platform.OS === 'web') {
        if (!webAudioRef.current) {
          webAudioRef.current = new Audio(resolvedUri);
          webAudioRef.current.onended = () => setIsPlayingAudio(false);
        }
        if (isPlayingAudio) {
          webAudioRef.current.pause();
          setIsPlayingAudio(false);
        } else {
          await webAudioRef.current.play();
          setIsPlayingAudio(true);
        }
      } else {
        const { Audio } = await import('expo-av');
        if (!nativeSoundRef.current) {
          const sound = new Audio.Sound();
          await sound.loadAsync({ uri: resolvedUri });
          sound.setOnPlaybackStatusUpdate((status: any) => {
            if (status?.didFinish) {
              setIsPlayingAudio(false);
            }
          });
          nativeSoundRef.current = sound;
        }
        if (isPlayingAudio) {
          await nativeSoundRef.current.pauseAsync();
          setIsPlayingAudio(false);
        } else {
          await nativeSoundRef.current.playAsync();
          setIsPlayingAudio(true);
        }
      }
    } catch (err) {
      console.error('Audio playback failed:', err);
    }
  }, [downloadStatus, resolvedUri, onDownload, isPlayingAudio]);

  const grouped = useMemo(() => {
    const map = new Map<string, { emoji: string; count: number; includesMe: boolean }>();
    for (const r of reactions ?? []) {
      const entry = map.get(r.emoji) ?? { emoji: r.emoji, count: 0, includesMe: false };
      entry.count += 1;
      if (r.did === currentDid) entry.includesMe = true;
      map.set(r.emoji, entry);
    }
    return [...map.values()];
  }, [reactions, currentDid]);

  const openPicker = useCallback(() => {
    emojiBtnRef.current?.measureInWindow((x, y, width, height) => {
      onOpenPicker?.({ x, y, width, height });
    });
  }, [onOpenPicker]);

  const effectiveAvatarError = senderAvatarError || avatarError;

  const renderAvatar = (): React.JSX.Element | null => {
    if (senderAvatarUrl === undefined) return null;
    const fallbackLetter = (senderDisplayName?.[0] ?? '?').toUpperCase();
    return (
      <View style={styles.avatarWrap}>
        {senderAvatarUrl && !effectiveAvatarError ? (
          <Image
            source={{ uri: senderAvatarUrl }}
            style={styles.avatarImage}
            contentFit="cover"
            transition={300}
            onError={() => setAvatarError(true)}
          />
        ) : (
          <Text style={styles.avatarFallbackText}>{fallbackLetter}</Text>
        )}
      </View>
    );
  };

  const renderFileContent = () => {
    if (uploadStatus === 'uploading') {
      const pct = uploadProgress && uploadProgress > 0 ? `${uploadProgress}%` : '';
      return (
        <View style={styles.statusRow}>
          <ActivityIndicator size="small" color={theme.colors.textSecondary}/>
          <Text style={styles.statusText}>{`上传中...${pct}`}</Text>
        </View>
      );
    }

    if (uploadStatus === 'failed') {
      return (
        <View style={styles.fileCard}>
          <Text style={styles.fileIcon}>{isVideo ? '▶' : isAudio ? '🔊' : '📎'}</Text>
          <View style={styles.fileInfo}>
            <Text style={styles.fileName} numberOfLines={1}>{fileName}</Text>
            <Text style={styles.fileSize}>{formatFileSize(fileSize)}</Text>
            <Text style={styles.statusText}>上传失败</Text>
          </View>
          {onRetryUpload && (
            <Button label="重试" onPress={onRetryUpload} variant="primary" style={styles.retryBtn} />
          )}
        </View>
      );
    }

    if (isAudio) {
      const resolvingUri = downloadStatus === 'ready' && !resolvedUri;
      const showSpinner = downloadStatus === 'downloading' || resolvingUri;
      const showRetry = downloadStatus === 'failed';
      const disabled = showSpinner || showRetry;
      return (
        <TouchableOpacity
          onPress={disabled ? undefined : handleAudioPress}
          style={styles.audioCard}
          activeOpacity={disabled ? 1 : 0.7}
        >
          <View style={[styles.audioPlayBtn, disabled && styles.audioPlayBtnDisabled]}>
            <Text style={styles.audioPlayIcon}>{isPlayingAudio ? '⏸' : '▶'}</Text>
          </View>
          <View style={styles.fileInfo}>
            <Text style={styles.fileName} numberOfLines={1}>{fileName}</Text>
            <Text style={styles.fileSize}>{formatFileSize(fileSize)}</Text>
          </View>
          {showSpinner && (
            <>
              <ActivityIndicator size="small" color={theme.colors.textSecondary} />
              <Text style={styles.statusText}>
                {downloadStatus === 'downloading' && downloadProgress && downloadProgress > 0
                  ? `下载中... ${downloadProgress}%`
                  : '下载中...'}
              </Text>
            </>
          )}
          {showRetry && onRetry && (
            <Button label="Retry" onPress={onRetry} variant="primary" style={styles.retryBtn} />
          )}
        </TouchableOpacity>
      );
    }

    if (downloadStatus === 'ready' && resolvedUri && isImage) {
      return (
        <Pressable onPress={onImagePress} disabled={!onImagePress}>
          <Image
            source={{ uri: resolvedUri }}
            style={styles.imagePreview}
            contentFit="cover"
          />
        </Pressable>
      );
    }

    if (downloadStatus === 'downloading') {
      let statusText = '下载中...';
      if (downloadProgress && downloadProgress > 0) {
        statusText = `下载中... ${downloadProgress}%`;
      }
      return (
        <View style={styles.statusRow}>
          <ActivityIndicator size="small" color={theme.colors.textSecondary} />
          <Text style={styles.statusText}>{statusText}</Text>
        </View>
      );
    }

    if (downloadStatus === 'failed') {
      return (
        <View style={styles.fileCard}>
          <Text style={styles.fileIcon}>📎</Text>
          <View style={styles.fileInfo}>
            <Text style={styles.fileName} numberOfLines={1}>{fileName}</Text>
            <Text style={styles.fileSize}>{formatFileSize(fileSize)}</Text>
          </View>
          {onRetry && (
            <Button label="Retry" onPress={onRetry} variant="primary" style={styles.retryBtn} />
          )}
        </View>
      );
    }

    if (downloadStatus === 'pending') {
      return (
        <TouchableOpacity onPress={onDownload} style={styles.fileCard} activeOpacity={0.7}>
          <Text style={styles.fileIcon}>{isVideo ? '▶' : isAudio ? '🔊' : '📎'}</Text>
          <View style={styles.fileInfo}>
            <Text style={styles.fileName} numberOfLines={1}>{fileName}</Text>
            <Text style={styles.fileSize}>{formatFileSize(fileSize)}</Text>
          </View>
          <ActivityIndicator size="small" color={theme.colors.textSecondary} />
          {onDownload && (
            <Text style={styles.downloadHint}>Tap to download</Text>
          )}
        </TouchableOpacity>
      );
    }

    return (
      <View style={styles.fileCard}>
        <Text style={styles.fileIcon}>{isVideo ? '▶' : isAudio ? '🔊' : '📎'}</Text>
        <View style={styles.fileInfo}>
          <Text style={styles.fileName} numberOfLines={1}>{fileName}</Text>
          <Text style={styles.fileSize}>{formatFileSize(fileSize)}</Text>
        </View>
      </View>
    );
  };

  return (
    <View style={[
      styles.row,
      isOutgoing ? styles.rowOutgoing : styles.rowIncoming,
    ]}>
      {!isOutgoing && renderAvatar()}
      <View style={styles.contentCol}>
        {senderDisplayName && !isOutgoing && (
          <>
            <Text style={styles.senderName} numberOfLines={1}>{senderDisplayName}</Text>
            {senderHandle ? (
              <Text style={styles.senderHandle} numberOfLines={1}>@{senderHandle}</Text>
            ) : null}
          </>
        )}
        <View style={[styles.bubbleRow, isOutgoing ? styles.bubbleRowOutgoing : styles.bubbleRowIncoming]}>
          {isOutgoing && (
            <View ref={emojiBtnRef} style={styles.emojiBtnWrap}>
              <Pressable onPress={onOpenPicker ? openPicker : undefined} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <Text style={styles.emojiBtnText}>😀</Text>
              </Pressable>
            </View>
          )}
          <View style={[
            styles.container,
            isOutgoing ? styles.outgoing : styles.incoming,
          ]}>
            {renderFileContent()}
          </View>
          {!isOutgoing && (
            <View ref={emojiBtnRef} style={styles.emojiBtnWrap}>
              <Pressable onPress={onOpenPicker ? openPicker : undefined} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <Text style={styles.emojiBtnText}>😀</Text>
              </Pressable>
            </View>
          )}
        </View>
        {grouped.length > 0 && (
          <View style={[
            styles.reactionsRow,
            isOutgoing ? styles.reactionsRowOutgoing : styles.reactionsRowIncoming,
          ]}>
            {grouped.map((entry) => (
              <Pressable
                key={entry.emoji}
                onPress={onReactionPress ? () => onReactionPress(entry.emoji) : undefined}
                style={[
                  styles.reactionPill,
                  entry.includesMe ? styles.reactionPillActive : styles.reactionPillInactive,
                ]}
              >
                <Text style={styles.reactionEmoji}>{entry.emoji}</Text>
                {entry.count > 1 && (
                  <Text style={styles.reactionCount}>{entry.count}</Text>
                )}
              </Pressable>
            ))}
          </View>
        )}
      </View>
      {isOutgoing && renderAvatar()}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginHorizontal: 16,
    marginVertical: 8,
  },
  rowIncoming: {
    justifyContent: 'flex-start',
  },
  rowOutgoing: {
    justifyContent: 'flex-end',
  },
  avatarWrap: {
    width: 40,
    height: 40,
    borderRadius: 20,
    overflow: 'hidden',
    backgroundColor: theme.colors.accent,
    justifyContent: 'center',
    alignItems: 'center',
    marginHorizontal: theme.spacing.xs,
  },
  avatarImage: {
    width: 40,
    height: 40,
  },
  avatarFallbackText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700',
  },
  contentCol: {
    flex: 1,
  },
  senderName: {
    color: theme.colors.textPrimary,
    fontSize: 13,
    fontWeight: '600',
    marginBottom: 1,
    includeFontPadding: false,
  },
  senderHandle: {
    color: theme.colors.textSecondary,
    fontSize: 11,
    marginBottom: 4,
    includeFontPadding: false,
  },
  bubbleRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    alignSelf: 'stretch',
  },
  bubbleRowIncoming: {
    justifyContent: 'flex-start',
  },
  bubbleRowOutgoing: {
    justifyContent: 'flex-end',
  },
  container: {
    borderRadius: theme.borderRadius.md,
    padding: theme.spacing.sm,
    maxWidth: 320,
  },
  outgoing: {
    backgroundColor: theme.colors.outgoingBubble,
  },
  incoming: {
    backgroundColor: theme.colors.incomingBubble,
  },
  imagePreview: {
    width: 200,
    height: 150,
    borderRadius: theme.borderRadius.sm,
  },
  fileCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
  },
  audioCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
  },
  audioPlayBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: theme.colors.accent,
    justifyContent: 'center',
    alignItems: 'center',
  },
  audioPlayBtnDisabled: {
    opacity: 0.5,
  },
  audioPlayIcon: {
    fontSize: 16,
    color: '#FFFFFF',
    marginLeft: 2,
  },
  fileIcon: {
    fontSize: 24,
  },
  fileInfo: {
    flex: 1,
    minWidth: 0,
  },
  fileName: {
    color: theme.colors.textPrimary,
    fontSize: theme.typography.caption,
    fontWeight: '600',
  },
  fileSize: {
    color: theme.colors.textSecondary,
    fontSize: theme.typography.small,
    marginTop: 2,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    padding: theme.spacing.xs,
  },
  statusText: {
    color: theme.colors.textSecondary,
    fontSize: theme.typography.small,
  },
  retryBtn: {
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: 4,
  },
  downloadHint: {
    color: theme.colors.textSecondary,
    fontSize: theme.typography.small,
    marginLeft: theme.spacing.xs,
  },
  emojiBtnWrap: {
    padding: 2,
    marginHorizontal: theme.spacing.xs,
  },
  emojiBtnText: {
    fontSize: 14,
    opacity: 0.6,
  },
  reactionsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: theme.spacing.xs,
    marginTop: theme.spacing.xs,
  },
  reactionsRowOutgoing: {
    justifyContent: 'flex-end',
  },
  reactionsRowIncoming: {
    justifyContent: 'flex-start',
  },
  reactionPill: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: theme.spacing.xs,
    paddingVertical: 2,
    borderRadius: theme.borderRadius.full,
  },
  reactionPillInactive: {
    backgroundColor: theme.colors.surface,
  },
  reactionPillActive: {
    backgroundColor: theme.colors.accent,
  },
  reactionEmoji: {
    fontSize: 14,
  },
  reactionCount: {
    fontSize: theme.typography.small,
    color: theme.colors.textSecondary,
    marginLeft: 2,
  },
});
