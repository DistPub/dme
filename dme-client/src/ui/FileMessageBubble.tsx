import React from 'react';
import { View, Text, StyleSheet, ActivityIndicator, TouchableOpacity } from 'react-native';
import { Image } from 'expo-image';
import { theme } from './theme';
import { Button } from './Button';
import type { FileMeta } from '../protocol/types';

interface FileMessageBubbleProps {
  fileMeta: FileMeta;
  isOutgoing: boolean;
  onRetry?: () => void;
  onDownload?: () => void;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function FileMessageBubble({ fileMeta, isOutgoing, onRetry, onDownload }: FileMessageBubbleProps): React.JSX.Element {
  const { fileName, fileSize, mimeType, downloadStatus, localPath } = fileMeta;
  const isImage = mimeType.startsWith('image/');
  const isVideo = mimeType.startsWith('video/');
  const isAudio = mimeType.startsWith('audio/');

  const renderContent = () => {
    if (downloadStatus === 'ready' && localPath && isImage) {
      return (
        <Image
          source={{ uri: localPath }}
          style={styles.imagePreview}
          contentFit="cover"
        />
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
      styles.container,
      isOutgoing ? styles.outgoing : styles.incoming,
    ]}>
      {renderContent()}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    maxWidth: 260,
    borderRadius: theme.borderRadius.md,
    padding: theme.spacing.sm,
    marginVertical: 2,
  },
  outgoing: {
    alignSelf: 'flex-end',
    backgroundColor: theme.colors.outgoingBubble,
  },
  incoming: {
    alignSelf: 'flex-start',
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
});
