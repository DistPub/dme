/**
 * ui/LogoSpinner.tsx - Shared loading indicator (logo + spinner).
 *
 * Pure presentational component used by App.tsx (session restore) and
 * SetupScreen.tsx (identity key check). Provides its own inner layout
 * only; callers supply the full-screen / centered container.
 */

import React from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { Image } from 'expo-image';

import { theme } from './theme';

export function LogoSpinner(): React.JSX.Element {
  return (
    <View style={styles.container}>
      <Image
        source={require('../../assets/images/logo.png')}
        style={styles.logo}
        contentFit="contain"
      />
      <ActivityIndicator size="small" color={theme.colors.accent} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
  },
  logo: {
    width: 96,
    height: 96,
    marginBottom: theme.spacing.md,
  },
});
