/**
 * ui/ImageViewerScreen.tsx - Full-screen image viewer with tap-to-dismiss.
 */

import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { useNavigation, useRoute } from '@react-navigation/native';
import type { NativeStackNavigationProp, NativeStackScreenProps } from '@react-navigation/native-stack';

import { theme } from './theme';
import { useFileUri } from '../utils/file-cache';
import type { RootStackParamList } from '../types/navigation';

type Navigation = NativeStackNavigationProp<RootStackParamList>;
type ImageViewerRouteProp = NativeStackScreenProps<RootStackParamList, 'ImageViewer'>['route'];

export function ImageViewerScreen(): React.JSX.Element {
  const navigation = useNavigation<Navigation>();
  const route = useRoute<ImageViewerRouteProp>();
  const { uri, fileName } = route.params;
  const resolvedUri = useFileUri(uri);

  return (
    <View style={styles.container}>
      <Pressable style={styles.imageWrapper} onPress={() => navigation.goBack()}>
        {resolvedUri ? (
          <Image
            source={{ uri: resolvedUri }}
            style={styles.image}
            contentFit="contain"
          />
        ) : (
          <ActivityIndicator size="large" color={theme.colors.textPrimary} />
        )}
      </Pressable>

      <Pressable style={styles.closeButton} onPress={() => navigation.goBack()}>
        <Text style={styles.closeText}>✕</Text>
      </Pressable>

      {fileName ? (
        <View style={styles.footer} pointerEvents="none">
          <Text style={styles.fileName} numberOfLines={1}>{fileName}</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000000',
  },
  imageWrapper: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  image: {
    width: '100%',
    height: '100%',
  },
  closeButton: {
    position: 'absolute',
    top: theme.spacing.lg,
    right: theme.spacing.lg,
    width: 40,
    height: 40,
    borderRadius: theme.borderRadius.full,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  closeText: {
    color: theme.colors.textPrimary,
    fontSize: 20,
    fontWeight: '600',
  },
  footer: {
    position: 'absolute',
    bottom: theme.spacing.lg,
    left: theme.spacing.lg,
    right: theme.spacing.lg,
    alignItems: 'center',
  },
  fileName: {
    color: theme.colors.textPrimary,
    fontSize: theme.typography.caption,
    textShadowColor: 'rgba(0, 0, 0, 0.75)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 2,
  },
});
