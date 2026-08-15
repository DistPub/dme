import React, { useCallback, useMemo, useRef } from 'react';
import { View, Text, StyleSheet, ActivityIndicator, TouchableOpacity, Pressable } from 'react-native';
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
  onRetry?: () => void;
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
  onRetry,
  onDownload,
  onImagePress,
  onReactionPress,
  onOpenPicker,
}: FileMessageBubbleProps): React.JSX.Element {
  const { fileName, fileSize, mimeType, downloadStatus, localPath } = fileMeta;
  const resolvedUri = useFileUri(localPath);
  const isImage = mimeType.startsWith('image/');
  const isVideo = mimeType.startsWith('video/');
  const isAudio = mimeType.startsWith('audio/');
  const emojiBtnRef = useRef<View>(null);

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

  const renderContent = () => {
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
      return (
        <View style={styles.statusRow}>
          <ActivityIndicator size="small" color={theme.colors.textSecondary} />
          <Text style={styles.statusText}>Downloading...</Text>
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
      styles.wrapper,
      isOutgoing ? styles.wrapperOutgoing : styles.wrapperIncoming,
    ]}>
      <View style={styles.bubbleRow}>
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
          {renderContent()}
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
  );
}

const styles = StyleSheet.create({
  wrapper: {
    marginVertical: 2,
    maxWidth: 320,
  },
  wrapperOutgoing: {
    alignSelf: 'flex-end',
  },
  wrapperIncoming: {
    alignSelf: 'flex-start',
  },
  bubbleRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  container: {
    borderRadius: theme.borderRadius.md,
    padding: theme.spacing.sm,
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
