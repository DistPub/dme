/**
 * components/FileMessageBubble.tsx - 文件消息气泡。
 *
 * 对齐 web `dme-client/src/ui/FileMessageBubble.tsx` 的全部分支：
 *   上传中 / 上传失败可重试 / 音频（可播） /
 *   图片预览（点击放大） / 视频（缩略图或 ▶ 卡片） /
 *   下载中 / 下载失败可重试 / 待下载可下载 / 普通文件卡
 *   外加 reactions pill、😀 表情按钮、💾 保存到设备。
 *
 * 小程序差异：
 *   - web 的 `useFileUri()` 负责 indexeddb:// → blob url 的转换；小程序里
 *     `fileMeta.localPath` 本身就是可用的本地文件路径，直接用。
 *   - 视频缩略图不抓帧（见 IMPROVEMENT-PLAN.md §4.4 #5）：有 thumbnailPath
 *     就显示缩略图 + ▶ 覆盖层，否则回退 ▶ 卡片（web 本来就有这条回退）。
 *   - 音频播放改用 `Taro.createInnerAudioContext()` 替代 expo-av。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, Image } from '@tarojs/components';
import Taro from '@tarojs/taro';

import type { FileMeta } from '../protocol/types';
import type { Reaction } from '../storage/db';
import { useI18n } from '../i18n/I18nContext';
import { posFromEvent, type TapPos } from '../utils/screen';
import './FileMessageBubble.scss';

export interface FileMessageBubbleProps {
  fileMeta: FileMeta;
  isOutgoing: boolean;
  reactions?: Reaction[];
  currentDid?: string;
  senderDisplayName?: string;
  senderHandle?: string;
  senderAvatarUrl?: string | null;
  onRetry?: () => void;
  onRetryUpload?: () => void;
  onDownload?: () => void;
  onImagePress?: () => void;
  onVideoPress?: () => void;
  onSave?: () => void;
  onReactionPress?: (emoji: string) => void;
  /** 打开表情选择浮层，参数为触点视口坐标。 */
  onOpenPicker?: (pos: TapPos) => void;
}

export function FileMessageBubble({
  fileMeta,
  isOutgoing,
  reactions,
  currentDid,
  senderDisplayName,
  senderHandle,
  senderAvatarUrl,
  onRetry,
  onRetryUpload,
  onDownload,
  onImagePress,
  onVideoPress,
  onSave,
  onReactionPress,
  onOpenPicker,
}: FileMessageBubbleProps): React.JSX.Element {
  const { t } = useI18n();
  const {
    fileName,
    fileSize,
    mimeType,
    downloadStatus,
    uploadStatus,
    localPath,
    thumbnailPath,
    uploadProgress,
    downloadProgress,
  } = fileMeta;

  const isImage = mimeType.startsWith('image/');
  const isVideo = mimeType.startsWith('video/');
  const isAudio = mimeType.startsWith('audio/');

  const [avatarError, setAvatarError] = useState(false);
  const [isPlayingAudio, setIsPlayingAudio] = useState(false);
  const audioRef = useRef<Taro.InnerAudioContext | null>(null);

  useEffect(() => {
    setAvatarError(false);
  }, [senderAvatarUrl]);

  const destroyAudio = useCallback((): void => {
    if (audioRef.current) {
      try {
        audioRef.current.stop();
        audioRef.current.destroy();
      } catch (err) {
        console.warn('FileMessageBubble: 释放音频失败', err);
      }
      audioRef.current = null;
    }
    setIsPlayingAudio(false);
  }, []);

  // 卸载 / 本地文件变化时释放音频实例（对齐 web 的 cleanup 语义）
  useEffect(() => destroyAudio, [destroyAudio, localPath]);

  const formatFileSize = useCallback(
    (bytes: number): string => {
      if (bytes < 1024) return t('bubble.sizeB', { n: bytes });
      if (bytes < 1024 * 1024) return t('bubble.sizeKB', { n: (bytes / 1024).toFixed(1) });
      return t('bubble.sizeMB', { n: (bytes / (1024 * 1024)).toFixed(1) });
    },
    [t],
  );

  const handleAudioPress = useCallback((): void => {
    if (downloadStatus === 'pending') {
      onDownload?.();
      return;
    }
    if (downloadStatus !== 'ready' || !localPath) return;

    try {
      if (isPlayingAudio && audioRef.current) {
        audioRef.current.pause();
        setIsPlayingAudio(false);
        return;
      }
      if (!audioRef.current) {
        const ctx = Taro.createInnerAudioContext();
        ctx.src = localPath;
        ctx.onEnded(() => setIsPlayingAudio(false));
        ctx.onError((err) => {
          console.error('FileMessageBubble: 音频播放失败', err);
          setIsPlayingAudio(false);
        });
        audioRef.current = ctx;
      }
      audioRef.current.play();
      setIsPlayingAudio(true);
    } catch (err) {
      console.error('FileMessageBubble: 音频播放异常', err);
    }
  }, [downloadStatus, localPath, onDownload, isPlayingAudio]);

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

  const renderAvatar = (): React.JSX.Element | null => {
    if (senderAvatarUrl === undefined) return null;
    const fallbackLetter = (senderDisplayName?.[0] ?? '?').toUpperCase();
    return (
      <View className="filebubble__avatarWrap">
        {senderAvatarUrl && !avatarError ? (
          <Image
            className="filebubble__avatarImg"
            src={senderAvatarUrl}
            mode="aspectFill"
            onError={() => setAvatarError(true)}
          />
        ) : (
          <Text className="filebubble__avatarLetter">{fallbackLetter}</Text>
        )}
      </View>
    );
  };

  const fileIcon = isVideo ? '▶' : isAudio ? '🔊' : '📎';

  /** 通用文件卡（含可选操作按钮）。 */
  const renderFileCard = (
    icon: string,
    actionLabel?: string,
    onAction?: () => void,
    extraHint?: string,
  ): React.JSX.Element => (
    <View className="filebubble__card">
      <Text className="filebubble__icon">{icon}</Text>
      <View className="filebubble__info">
        <Text className="filebubble__name">{fileName}</Text>
        <Text className="filebubble__size">{formatFileSize(fileSize)}</Text>
        {extraHint ? <Text className="filebubble__hint">{extraHint}</Text> : null}
      </View>
      {actionLabel && onAction ? (
        <View className="filebubble__actionBtn" onClick={onAction}>
          <Text className="filebubble__actionText">{actionLabel}</Text>
        </View>
      ) : null}
    </View>
  );

  const renderLoading = (text: string): React.JSX.Element => (
    <View className="filebubble__statusRow">
      <View className="filebubble__spinner" />
      <Text className="filebubble__statusText">{text}</Text>
    </View>
  );

  const renderFileContent = (): React.JSX.Element => {
    if (uploadStatus === 'uploading') {
      const pct = uploadProgress && uploadProgress > 0 ? ` ${uploadProgress}%` : '';
      return renderLoading(t('bubble.uploading', { pct }));
    }

    if (uploadStatus === 'failed') {
      return renderFileCard(
        fileIcon,
        onRetryUpload ? t('bubble.retry') : undefined,
        onRetryUpload,
        t('bubble.uploadFailed'),
      );
    }

    if (isAudio) {
      const canPlay = downloadStatus === 'ready' && !!localPath;
      const showSpinner = downloadStatus === 'downloading';
      return (
        <View className="filebubble__card">
          <View
            className={`filebubble__playBtn ${canPlay ? '' : 'filebubble__playBtn--disabled'}`}
            onClick={canPlay ? handleAudioPress : undefined}
          >
            <Text className="filebubble__playIcon">{isPlayingAudio ? '⏸' : '▶'}</Text>
          </View>
          <View className="filebubble__info">
            <Text className="filebubble__name">{fileName}</Text>
            <Text className="filebubble__size">{formatFileSize(fileSize)}</Text>
          </View>
          {showSpinner
            ? renderLoading(
                downloadProgress && downloadProgress > 0
                  ? t('bubble.downloading', { pct: downloadProgress })
                  : t('bubble.downloadingShort'),
              )
            : null}
          {downloadStatus === 'pending' && onDownload ? (
            <View className="filebubble__actionBtn" onClick={onDownload}>
              <Text className="filebubble__actionText">{t('bubble.download')}</Text>
            </View>
          ) : null}
          {downloadStatus === 'failed' && onRetry ? (
            <View className="filebubble__actionBtn" onClick={onRetry}>
              <Text className="filebubble__actionText">{t('common.retry')}</Text>
            </View>
          ) : null}
        </View>
      );
    }

    if (downloadStatus === 'ready' && localPath && isImage) {
      return (
        <View className="filebubble__mediaWrap" onClick={onImagePress}>
          <Image className="filebubble__imagePreview" src={localPath} mode="aspectFill" />
        </View>
      );
    }

    if (downloadStatus === 'ready' && localPath && isVideo && onVideoPress) {
      if (thumbnailPath) {
        return (
          <View className="filebubble__mediaWrap" onClick={onVideoPress}>
            <Image className="filebubble__imagePreview" src={thumbnailPath} mode="aspectFill" />
            <View className="filebubble__playOverlay">
              <Text className="filebubble__playOverlayIcon">▶</Text>
            </View>
          </View>
        );
      }
      return (
        <View className="filebubble__card" onClick={onVideoPress}>
          <Text className="filebubble__icon">▶</Text>
          <View className="filebubble__info">
            <Text className="filebubble__name">{fileName}</Text>
            <Text className="filebubble__size">{formatFileSize(fileSize)}</Text>
          </View>
        </View>
      );
    }

    if (downloadStatus === 'downloading') {
      const pctText =
        downloadProgress && downloadProgress > 0
          ? t('bubble.downloading', { pct: downloadProgress })
          : t('bubble.downloadingShort');
      return renderLoading(pctText);
    }

    if (downloadStatus === 'failed') {
      return renderFileCard('📎', onRetry ? t('common.retry') : undefined, onRetry);
    }

    if (downloadStatus === 'pending') {
      return renderFileCard(
        fileIcon,
        onDownload ? t('bubble.download') : undefined,
        onDownload,
      );
    }

    return renderFileCard(fileIcon);
  };

  const canSave = downloadStatus === 'ready' && !!localPath && !!onSave;

  return (
    <View className={`filebubble ${isOutgoing ? 'filebubble--out' : 'filebubble--in'}`}>
      {!isOutgoing ? renderAvatar() : null}

      <View className="filebubble__col">
        {senderDisplayName && !isOutgoing ? (
          <View className="filebubble__senderWrap">
            <Text className="filebubble__sender">{senderDisplayName}</Text>
            {senderHandle ? <Text className="filebubble__handle">@{senderHandle}</Text> : null}
          </View>
        ) : null}

        <View className={`filebubble__row ${isOutgoing ? 'filebubble__row--out' : 'filebubble__row--in'}`}>
          {isOutgoing && canSave ? (
            <View className="filebubble__emojiBtn" onClick={onSave}>
              <Text className="filebubble__emojiIcon">💾</Text>
            </View>
          ) : null}
          {isOutgoing && onOpenPicker ? (
            <View className="filebubble__emojiBtn" onClick={(e) => onOpenPicker(posFromEvent(e))}>
              <Text className="filebubble__emojiIcon">😀</Text>
            </View>
          ) : null}

          <View
            className={`filebubble__container ${isOutgoing ? 'filebubble__container--out' : 'filebubble__container--in'}`}
          >
            {renderFileContent()}
          </View>

          {!isOutgoing && onOpenPicker ? (
            <View className="filebubble__emojiBtn" onClick={(e) => onOpenPicker(posFromEvent(e))}>
              <Text className="filebubble__emojiIcon">😀</Text>
            </View>
          ) : null}
          {!isOutgoing && canSave ? (
            <View className="filebubble__emojiBtn" onClick={onSave}>
              <Text className="filebubble__emojiIcon">💾</Text>
            </View>
          ) : null}
        </View>

        {grouped.length > 0 ? (
          <View
            className={`filebubble__reactions ${isOutgoing ? 'filebubble__reactions--out' : 'filebubble__reactions--in'}`}
          >
            {grouped.map((entry) => (
              <View
                key={entry.emoji}
                className={`filebubble__pill ${entry.includesMe ? 'filebubble__pill--active' : ''}`}
                onClick={onReactionPress ? () => onReactionPress(entry.emoji) : undefined}
              >
                <Text className="filebubble__pillEmoji">{entry.emoji}</Text>
                {entry.count > 1 ? <Text className="filebubble__pillCount">{entry.count}</Text> : null}
              </View>
            ))}
          </View>
        ) : null}
      </View>

      {isOutgoing ? renderAvatar() : null}
    </View>
  );
}
