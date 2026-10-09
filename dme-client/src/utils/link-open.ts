/**
 * utils/link-open.ts - Message text link detection + platform-aware open.
 *
 * Web-only feature: text messages containing URLs render as underlined links.
 * Click behavior by platform:
 *   - PC web:        `window.open` in a new window/tab.
 *   - iOS web embed: postMessage DME_OPEN_URL — the fatesky parent launches a
 *     web view (`window.open` is unreliable inside the embed WKWebView).
 *   - iOS web standalone: `window.open` fallback (no parent to ask).
 *   - Fatesky links (host=app.hukoubook.com) while embedded: postMessage
 *     DME_NAVIGATE so the parent SPA navigates to the link's path instead.
 *   - Native: not handled yet (plain text, no links).
 */

import { Platform } from 'react-native';

import { isEmbedContext } from '../embed/protocol';
import { sendNavigate, sendOpenUrl } from '../embed/bridge';

/** Host that marks a URL as a fatesky in-app link. */
export const FATESKY_HOST = 'app.hukoubook.com';

/** One rendered piece of a message text: plain text or a detected URL. */
export interface TextSegment {
  text: string;
  /** Absolute URL when this segment is a link; absent for plain text. */
  url?: string;
}

const URL_RE = /(https?:\/\/[^\s]+|www\.[^\s]+)/g;

/** Trailing punctuation stripped from detected URLs (sentence punctuation only). */
const TRAILING_PUNCT_RE = /[.,;:!?]+$/;

/** Split message text into plain-text and URL segments for rendering. */
export function linkify(text: string): TextSegment[] {
  const segments: TextSegment[] = [];
  const re = new RegExp(URL_RE.source, 'g'); // fresh lastIndex per call
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const start = m.index;
    const raw = m[0];
    const trailMatch = raw.match(TRAILING_PUNCT_RE);
    const trail = trailMatch ? trailMatch[0] : '';
    const urlPart = trail ? raw.slice(0, raw.length - trail.length) : raw;
    if (start > last) {
      segments.push({ text: text.slice(last, start) });
    }
    segments.push({ text: urlPart, url: urlPart });
    last = start + raw.length;
    if (trail) {
      segments.push({ text: trail });
    }
  }
  if (last < text.length) {
    segments.push({ text: text.slice(last) });
  }
  return segments;
}

export interface ParsedLink {
  /** Absolute http(s) URL, used for window.open / DME_OPEN_URL. */
  href: string;
  /** pathname + search + hash, used for DME_NAVIGATE. */
  path: string;
  /** Lowercased hostname without port. */
  hostname: string;
}

/** Normalize + parse a detected URL segment. Returns null when unusable. */
export function parseLink(raw: string): ParsedLink | null {
  let href = raw.trim();
  if (href.length === 0) return null;
  if (!/^https?:\/\//i.test(href)) {
    href = `https://${href}`;
  }
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const path = `${url.pathname || '/'}${url.search}${url.hash}`;
  return { href: url.href, path, hostname: url.hostname.toLowerCase() };
}

/** Whether the hostname marks a fatesky in-app link. */
export function isFateskyLink(hostname: string): boolean {
  return hostname === FATESKY_HOST;
}

/** iOS Safari / WKWebView detection (incl. iPadOS 13+ reporting as Mac). */
export function isIOSWeb(): boolean {
  if (Platform.OS !== 'web' || typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  const iosUA = /iPad|iPhone|iPod/.test(ua);
  const ipadOS =
    navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  return iosUA || ipadOS;
}

/**
 * Handle a tap on a message link. Web-only; native is a no-op for now.
 */
export function openMessageLink(raw: string): void {
  if (Platform.OS !== 'web') return;

  const parsed = parseLink(raw);
  if (!parsed) return;

  // Fatesky link + embed mode: ask the parent to navigate its own path.
  if (isEmbedContext() && isFateskyLink(parsed.hostname)) {
    sendNavigate(parsed.path);
    return;
  }

  if (isIOSWeb()) {
    if (isEmbedContext()) {
      // Inside the fatesky embed `window.open` cannot launch a browsing
      // context — the parent presents a web view instead.
      sendOpenUrl(parsed.href);
    } else {
      // Standalone iOS Safari: new tab fallback.
      window.open(parsed.href, '_blank', 'noopener,noreferrer');
    }
    return;
  }

  // PC web: open in a new window/tab.
  window.open(parsed.href, '_blank', 'noopener,noreferrer');
}
