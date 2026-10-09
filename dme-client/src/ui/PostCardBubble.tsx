/**
 * ui/PostCardBubble.tsx - Embedded post-card message bubble.
 *
 * A `kind: 'post'` message carries `{uri, url, html}` (shared from fatesky via
 * `DME_SHARE`). Rendering is platform-split:
 *
 *   - Web:      an `uri`-derived sandboxed iframe preview, matching fatesky's
 *               `embed.js` (`<origin>/embed/<uri without at://>`). The iframe is
 *               locked down (`sandbox="allow-scripts allow-same-origin"` — no
 *               top-navigation, no forms, no popups) and made pointer-transparent
 *               so the whole card is one tap target. `allow-same-origin` is
 *               REQUIRED: without it the iframe document gets an opaque `null`
 *               origin, which makes its in-page same-origin `<script
 *               src="fatesky-ssr.../static/*.js">` requests look cross-origin and
 *               fail CORS (no `Access-Control-Allow-Origin` on those assets). The
 *               iframe src is a different subdomain from DME, so this does NOT
 *               grant the embed script access to the DME page's DOM/permissions.
 *               Tapping reuses `openMessageLink(url)`, i.e. the exact same
 *               platform-aware behavior as a text-message URL.
 *   - Native:   no iframe — a plain link-text card (per product decision),
 *               tapping is a no-op (consistent with the native URL behavior).
 *
 * Layout mirrors MessageBubble / FileMessageBubble (avatar + row + reactions).
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';

import { theme } from './theme';
import type { Reaction } from '../storage/db';
import { openMessageLink } from '../utils/link-open';
import { useI18n } from '../i18n/I18nContext';
import { buildPostEmbedUrl } from '../protocol/types';

export interface PostCardBubbleProps {
  uri: string;
  url: string;
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

const BUBBLE_MARGIN = 16;
const CARD_MAX_WIDTH = 320;

export function PostCardBubble({
  uri,
  url,
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
}: PostCardBubbleProps): React.JSX.Element {
  const { t } = useI18n();
  const emojiBtnRef = useRef<View>(null);
  const bubbleRef = useRef<View>(null);
  const [avatarError, setAvatarError] = useState(false);

  useEffect(() => {
    setAvatarError(false);
  }, [senderAvatarUrl]);

  // Web: right-click (contextmenu) opens the action menu. Native: onLongPress.
  useEffect(() => {
    if (Platform.OS !== 'web' || !onShowActionMenu) return;
    const node = bubbleRef.current as unknown as HTMLElement | null;
    if (!node) return;

    const handleContextMenu = (e: MouseEvent): void => {
      e.preventDefault();
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

  // Tapping the card is identical to tapping a text-message URL.
  const handlePress = useCallback((): void => {
    if (Platform.OS !== 'web') return; // native: no-op, matches URL behavior
    openMessageLink(url);
  }, [url]);

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

  const renderCard = (): React.JSX.Element => {
    const embedUrl = buildPostEmbedUrl(uri);
    if (Platform.OS === 'web' && embedUrl) {
      return (
        <View style={styles.embedWrap}>
          {React.createElement('iframe', {
            src: embedUrl,
            sandbox: 'allow-scripts allow-same-origin',
            style: {
              width: '100%',
              height: 240,
              border: 'none',
              display: 'block',
              pointerEvents: 'none',
            },
          })}
        </View>
      );
    }
    // Native / mini-program (and malformed uri): plain link text.
    return (
      <View style={styles.linkTextWrap}>
        <Text style={styles.linkText} numberOfLines={3} onPress={handlePress}>
          {url}
        </Text>
      </View>
    );
  };

  return (
    <View style={[styles.row, isOutgoing ? styles.rowOutgoing : styles.rowIncoming]}>
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
            onPress={Platform.OS === 'web' ? handlePress : undefined}
            onLongPress={onShowActionMenu ? showActionMenu : undefined}
            onTouchStart={onShowActionMenu ? clearSelection : undefined}
            delayLongPress={300}
            style={[styles.card, isOutgoing ? styles.outgoing : styles.incoming]}
          >
            {renderCard()}
            <Text style={styles.caption} numberOfLines={1}>{t('bubble.postCard')}</Text>
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
  card: {
    maxWidth: CARD_MAX_WIDTH,
    borderRadius: theme.borderRadius.md,
    padding: theme.spacing.sm,
    overflow: 'hidden',
  },
  outgoing: {
    backgroundColor: theme.colors.outgoingBubble,
  },
  incoming: {
    backgroundColor: theme.colors.incomingBubble,
  },
  embedWrap: {
    width: CARD_MAX_WIDTH - 16,
    height: 240,
    borderRadius: theme.borderRadius.sm,
    overflow: 'hidden',
    backgroundColor: theme.colors.surface,
  },
  linkTextWrap: {
    maxWidth: CARD_MAX_WIDTH,
  },
  linkText: {
    color: theme.colors.accent,
    fontSize: theme.typography.body,
    textDecorationLine: 'underline',
  },
  caption: {
    color: theme.colors.textSecondary,
    fontSize: theme.typography.small,
    marginTop: theme.spacing.xs,
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
