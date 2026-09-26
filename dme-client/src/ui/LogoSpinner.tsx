/**
 * ui/LogoSpinner.tsx - Shared loading indicator (logo + spinner + slogan).
 *
 * Pure presentational component used by App.tsx (session restore) and
 * SetupScreen.tsx (identity key check). Provides its own inner layout
 * only; callers supply the full-screen / centered container.
 */

import React, { useEffect, useRef } from 'react';
import { ActivityIndicator, Animated, Easing, StyleSheet, View } from 'react-native';
import { Image } from 'expo-image';

import { theme } from './theme';

const SLOGAN_CHARS = ['大', '隐', '隐', '于', '市'];
const FLY_OFFSET = 44;
const CYCLE_MS = 5000;
const STAGGER_MS = 300;
const FLY_IN_MS = 800;
const HOLD_MS = 1800;
const FLY_OUT_MS = 800;
const GROUP_PAUSE_MS = 600;
const OUT_BASE_MS =
  (SLOGAN_CHARS.length - 1) * STAGGER_MS + FLY_IN_MS + GROUP_PAUSE_MS;
const TAIL_BASE_MS = CYCLE_MS - OUT_BASE_MS - FLY_OUT_MS;

function SloganChar({ char, index }: { char: string; index: number }): React.JSX.Element {
  const v = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const initialWait = index * STAGGER_MS;
    const tailWait = TAIL_BASE_MS - index * STAGGER_MS;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.delay(initialWait),
        Animated.timing(v, { toValue: 1, duration: FLY_IN_MS, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
        Animated.delay(HOLD_MS),
        Animated.timing(v, { toValue: 2, duration: FLY_OUT_MS, easing: Easing.in(Easing.cubic), useNativeDriver: true }),
        Animated.delay(tailWait),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [index, v]);

  const translateX = v.interpolate({ inputRange: [0, 1, 2], outputRange: [FLY_OFFSET, 0, -FLY_OFFSET] });
  const opacity = v.interpolate({ inputRange: [0, 0.35, 1.6, 2], outputRange: [0, 1, 1, 0] });

  return (
    <Animated.Text style={[styles.sloganChar, { opacity, transform: [{ translateX }] }]}>
      {char}
    </Animated.Text>
  );
}

export function LogoSpinner(): React.JSX.Element {
  return (
    <View style={styles.container}>
      <Image
        source={require('../../assets/images/logo.png')}
        style={styles.logo}
        contentFit="contain"
      />
      <ActivityIndicator size="small" color={theme.colors.accent} />
      <View style={styles.slogan}>
        {SLOGAN_CHARS.map((c, i) => (
          <SloganChar key={`${c}-${i}`} char={c} index={i} />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'column',
    alignItems: 'center',
  },
  logo: {
    width: 96,
    height: 96,
    marginBottom: theme.spacing.md,
  },
  slogan: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 20,
  },
  sloganChar: {
    fontSize: theme.typography.caption,
    color: theme.colors.textSecondary,
  },
});
