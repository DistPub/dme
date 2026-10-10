/**
 * ui/PostCardBubble.tsx - Embedded post-card message bubble.
 *
 * A `kind: 'post'` message carries `{uri, url, html}` (shared from fatesky via
 * `DME_SHARE`). Rendering is platform-split:
 *
 *   - Web:      an `uri`-derived sandboxed iframe preview, matching fatesky's
 *               `embed.js` (`<origin>/embed/<uri without at://>`). The iframe is
 *               locked down (`sandbox="allow-scripts allow-same-origin"` — no
 *               top-navigation, no forms, no popups). Its height adapts to the
 *               content: measured on load when the browser permits it, or
 *               adopted from a `{height}` postMessage sent by the embed page;
 *               when neither is available the iframe scrolls natively so the
 *               full post stays reachable (never clipped). `allow-same-origin`
 *               is REQUIRED: without it the iframe document gets an opaque
 *               `null` origin, which makes its in-page same-origin `<script
 *               src="fatesky-ssr.../static/*.js">` requests look cross-origin
 *               and fail CORS (no `Access-Control-Allow-Origin` on those
 *               assets). The iframe src is a different subdomain from DME, so
 *               this does NOT grant the embed script access to the DME page's
 *               DOM/permissions. Because the iframe accepts pointer events for
 *               native scrolling, taps on the embed area go to the embed page —
 *               tap the caption row ("帖子") to open the link, reusing
 *               `openMessageLink(url)` (the exact platform-aware behavior of a
 *               text-message URL).
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

// Embed iframe height: starts at a sane default, then adapts to the content.
// If the real content height can't be measured (cross-origin), the iframe
// scrolls natively instead of clipping — never hiding the rest of the post.
const POST_IFRAME_DEFAULT_HEIGHT = 320;
const POST_IFRAME_MAX_HEIGHT = 700;

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
  // Live height of the embed iframe. Updated on load (same-origin measure) or
  // via a height postMessage from the embed page; otherwise the default height
  // holds and the iframe's native scrollbar takes over.
  const [iframeHeight, setIframeHeight] = useState(POST_IFRAME_DEFAULT_HEIGHT);

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

  // The post embed is served cross-origin (fatesky-ssr.hukoubook.com), so the
  // parent page usually can't read the iframe's contentDocument. We still try
  // (it works whenever the browser permits it) and size the card to the
  // content. If we can't measure it, the default height stays and the iframe
  // scrolls natively — the rest of the post stays reachable either way.
  const handleIframeLoad = useCallback((e: React.SyntheticEvent<HTMLIFrameElement>): void => {
    const el = e.currentTarget;
    try {
      const doc = el.contentDocument ?? el.contentWindow?.document;
      const h = doc
        ? Math.max(doc.body?.scrollHeight ?? 0, doc.documentElement?.scrollHeight ?? 0)
        : 0;
      if (h > 0) {
        setIframeHeight(Math.min(POST_IFRAME_MAX_HEIGHT, h));
      }
    } catch {
      // Cross-origin: contentDocument access throws. Keep the default height;
      // the iframe's own scrollbar handles the overflow.
    }
  }, []);

  // Some embed pages post their rendered height back to the parent frame. If
  // one arrives, adopt it so the card fits the content exactly (no scrollbar).
  // This is a bonus path — native scrolling covers everything else.
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const onResize = (ev: MessageEvent): void => {
      const data = ev.data as { height?: unknown; type?: string } | null;
      if (
        data &&
        typeof data.height === 'number' &&
        Number.isFinite(data.height) &&
        data.height > 0
      ) {
        setIframeHeight(Math.min(POST_IFRAME_MAX_HEIGHT, Math.round(data.height)));
      }
    };
    window.addEventListener('message', onResize);
    return () => window.removeEventListener('message', onResize);
  }, []);

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
        <View
          style={[
            styles.embedWrap,
            // Match the message bubble background: blue for outgoing, dark gray
            // for incoming (visible while the embed loads / if it's transparent).
            isOutgoing ? styles.outgoing : styles.incoming,
          ]}
        >
          {React.createElement('iframe', {
            src: embedUrl,
            sandbox: 'allow-scripts allow-same-origin',
            onLoad: handleIframeLoad,
            style: {
              width: '100%',
              height: iframeHeight,
              border: 'none',
              display: 'block',
              // `auto` lets the embed scroll natively when its content is taller
              // than `iframeHeight` (cross-origin content can't be measured),
              // so the user can always reach the full post instead of it being
              // clipped. Taps on the iframe area go to the embed page — tap the
              // caption row below to open the link.
              pointerEvents: 'auto',
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
