/**
 * utils/web-title.ts - Sets document.title on web.
 *
 * Appends " - DME" to whatever page title the caller supplies.
 * On native platforms this is a no-op so React Native renderer never touches DOM.
 */

import { useCallback } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import { Platform } from 'react-native';

const APP_SUFFIX = 'DME';

/**
 * Set the browser tab title to `${title} - DME`.
 * Only mutates `document.title` when running on web; native is a no-op.
 *
 * Safe to call on every navigation: cheap and idempotent.
 */
export function setWebTitle(title: string): void {
  if (Platform.OS !== 'web') return;
  if (typeof document === 'undefined') return;
  document.title = `${title} - ${APP_SUFFIX}`;
}

/**
 * Screen-managed web document.title for pages whose title depends on
 * per-conversation state (group name / friend profile) that only the screen
 * itself can resolve.
 *
 * Uses `useFocusEffect` so the title is re-applied both when the screen gains
 * focus (including returning from a pushed screen such as group settings,
 * where the screen instance is not remounted) and whenever `title` changes
 * (async name resolution, language switch). On native it is a no-op.
 */
export function useWebTitle(title: string): void {
  useFocusEffect(
    useCallback(() => {
      setWebTitle(title);
    }, [title])
  );
}
