/**
 * ui/MessageBubble.tsx - RN native message bubble.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';

import { theme } from './theme';
import type { Reaction } from '../storage/db';
import { linkify, openMessageLink } from '../utils/link-open';
import type { TextSegment } from '../utils/link-open';

export interface MessageBubbleProps {
  text: string;
  isOutgoing: boolean;
  senderDisplayName?: string;
  senderHandle?: string;
  senderAvatarUrl?: string | null;
  senderAvatarError?: boolean;
  reactions?: Reaction[];
  currentDid?: string;
  onReactionPress?: (emoji: string) => void;
  onOpenPicker?: (layout: { x: number; y: number; width: number; height: number }) => void;
  onShowActionMenu?: (layout: { x: number; y: number; width: number; height: number }) => void;
}

const BUBBLE_PADDING = 12;
const BUBBLE_MARGIN = 16;
const BUBBLE_MAX_WIDTH_RATIO = 0.75;

export function MessageBubble({
  text,
  isOutgoing,
  senderDisplayName,
  senderHandle,
  senderAvatarUrl,
  senderAvatarError,
  reactions,
  currentDid,
  onReactionPress,
  onOpenPicker,
  onShowActionMenu,
}: MessageBubbleProps): React.JSX.Element {
  const emojiBtnRef = useRef<View>(null);
  const bubbleRef = useRef<View>(null);
  const [avatarError, setAvatarError] = useState(false);

  useEffect(() => {
    setAvatarError(false);
  }, [senderAvatarUrl]);

  // Web: right-click (contextmenu) on the bubble opens the action menu.
  // Native: onLongPress below handles it.
  useEffect(() => {
    if (Platform.OS !== 'web' || !onShowActionMenu) return;
    const node = bubbleRef.current as unknown as HTMLElement | null;
    if (!node) return;

    const handleContextMenu = (e: MouseEvent): void => {
      e.preventDefault();
      // iOS Web: long-press may start a text selection before contextmenu fires.
      // Clear any selection so the system callout menu does not appear over our menu.
      if (typeof window !== 'undefined' && window.getSelection) {
        window.getSelection()?.removeAllRanges();
      }
      bubbleRef.current?.measureInWindow((x, y, width, height) => {
        onShowActionMenu({ x, y, width, height });
      });
    };

    node.addEventListener('contextmenu', handleContextMenu);
    return () => node.removeEventListener('contextmenu', handleContextMenu);
  }, [onShowActionMenu]);

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

  const openPickerFromButton = useCallback(() => {
    emojiBtnRef.current?.measureInWindow((x, y, width, height) => {
      onOpenPicker?.({ x, y, width, height });
    });
  }, [onOpenPicker]);

  const clearSelection = useCallback((): void => {
    if (typeof window !== 'undefined' && window.getSelection) {
      window.getSelection()?.removeAllRanges();
    }
  }, []);

  const showActionMenu = useCallback(() => {
    clearSelection();
    bubbleRef.current?.measureInWindow((x, y, width, height) => {
      onShowActionMenu?.({ x, y, width, height });
    });
  }, [onShowActionMenu, clearSelection]);

  const renderText = (): React.ReactNode => {
    // Native: links not handled yet — render plain text as before.
    if (Platform.OS !== 'web') {
      return text;
    }
    const segments = linkify(text);
    const linkStyle = isOutgoing ? styles.linkOutgoing : styles.linkIncoming;
    return segments.map((segment: TextSegment, index: number) => {
      if (!segment.url) {
        return <Text key={index}>{segment.text}</Text>;
      }
      const url = segment.url;
      return (
        <Text
          key={index}
          style={linkStyle}
          onPress={() => openMessageLink(url)}
        >
          {segment.text}
        </Text>
      );
    });
  };

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

  const renderContent = (): React.JSX.Element => (
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
            <Pressable
              onPress={onOpenPicker ? openPickerFromButton : undefined}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Text style={styles.emojiBtnText}>😀</Text>
            </Pressable>
          </View>
        )}
        <Pressable
          ref={bubbleRef}
          onLongPress={onShowActionMenu ? showActionMenu : undefined}
          onTouchStart={onShowActionMenu ? clearSelection : undefined}
          delayLongPress={300}
          style={[
            styles.bubble,
            isOutgoing ? styles.outgoing : styles.incoming,
          ]}
        >
          <Text style={styles.text}>{renderText()}</Text>
        </Pressable>
        {!isOutgoing && (
          <View ref={emojiBtnRef} style={styles.emojiBtnWrap}>
            <Pressable
              onPress={onOpenPicker ? openPickerFromButton : undefined}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Text style={styles.emojiBtnText}>😀</Text>
            </Pressable>
          </View>
        )}
      </View>
      {grouped.length > 0 && (
        <View style={[styles.reactionsRow, isOutgoing ? styles.reactionsRowOutgoing : styles.reactionsRowIncoming]}>
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

  return (
    <View style={[
      styles.row,
      isOutgoing ? styles.rowOutgoing : styles.rowIncoming,
    ]}>
      {!isOutgoing && renderAvatar()}
      {renderContent()}
      {isOutgoing && renderAvatar()}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginHorizontal: BUBBLE_MARGIN,
    marginVertical: BUBBLE_MARGIN / 2,
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
  bubble: {
    maxWidth: `${BUBBLE_MAX_WIDTH_RATIO * 100}%`,
    paddingVertical: BUBBLE_PADDING,
    paddingHorizontal: BUBBLE_PADDING,
    borderRadius: theme.borderRadius.md,
  },
  outgoing: {
    alignSelf: 'flex-end',
    backgroundColor: theme.colors.outgoingBubble,
  },
  incoming: {
    alignSelf: 'flex-start',
    backgroundColor: theme.colors.incomingBubble,
  },
  text: {
    color: theme.colors.textPrimary,
    fontSize: theme.typography.body,
  },
  linkIncoming: {
    color: theme.colors.accent,
    textDecorationLine: 'underline',
  },
  linkOutgoing: {
    color: '#FFFFFF',
    textDecorationLine: 'underline',
  },
  emojiBtnWrap: {
    padding: 2,
    marginLeft: 4,
    marginRight: 4,
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
  reactionsRowIncoming: {
    justifyContent: 'flex-start',
  },
  reactionsRowOutgoing: {
    justifyContent: 'flex-end',
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
