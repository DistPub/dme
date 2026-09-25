import React from 'react';
import { View, StyleSheet } from 'react-native';
import { theme } from './theme';

/**
 * ui/ScreenBackground.tsx - Solid-color screen background.
 *
 * Replaces the per-screen `<Canvas><Fill/></Canvas>` backdrop with a plain
 * absolutely-positioned `View`. Skia is dropped here because (a) the
 * background was always just a solid color (`theme.colors.background`),
 * (b) some browsers (e.g. headless / hardened / WebGL-disabled) fail to
 * create a WebGL context and surface initialization errors, and (c) every
 * container View already paints the same background via `backgroundColor`,
 * so the Skia layer was redundant.
 *
 * Usage: drop it as the first child of the screen container View, before
 * any content Views.
 */
export function ScreenBackground(): React.JSX.Element {
  return <View style={styles.bg} />;
}

const styles = StyleSheet.create({
  bg: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: theme.colors.background,
  },
});