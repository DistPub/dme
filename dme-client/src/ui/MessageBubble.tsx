/**
 * ui/MessageBubble.tsx - RN native message bubble.
 */

import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { theme } from './theme';
import type { Reaction } from '../storage/db';

export interface MessageBubbleProps {
  text: string;
  isOutgoing: boolean;
  senderName?: string;
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
  senderName,
  reactions,
  currentDid,
  onReactionPress,
  onOpenPicker,
  onShowActionMenu,
}: MessageBubbleProps): React.JSX.Element {
  const emojiBtnRef = useRef<View>(null);
  const bubbleRef = useRef<View>(null);

  // Web: right-click (contextmenu) on the bubble opens the action menu.
  // Native: onLongPress below handles it.
  useEffect(() => {
    if (Platform.OS !== 'web' || !onShowActionMenu) return;
    const node = bubbleRef.current as unknown as HTMLElement | null;
    if (!node) return;

    const handleContextMenu = (e: MouseEvent): void => {
      e.preventDefault();
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

  const showActionMenu = useCallback(() => {
    bubbleRef.current?.measureInWindow((x, y, width, height) => {
      onShowActionMenu?.({ x, y, width, height });
    });
  }, [onShowActionMenu]);

  return (
    <View style={styles.container}>
      {senderName && !isOutgoing && (
        <Text style={styles.senderName} numberOfLines={1}>{senderName}</Text>
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
          delayLongPress={300}
          style={[
            styles.bubble,
            isOutgoing ? styles.outgoing : styles.incoming,
          ]}
        >
          <Text style={styles.text}>{text}</Text>
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
}

const styles = StyleSheet.create({
  container: {
    marginHorizontal: BUBBLE_MARGIN,
    marginVertical: BUBBLE_MARGIN / 2,
  },
  senderName: {
    color: theme.colors.textSecondary,
    fontSize: 12,
    marginLeft: 4,
    marginBottom: 2,
  },
  bubbleRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
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
