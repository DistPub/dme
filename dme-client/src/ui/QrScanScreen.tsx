/**
 * ui/QrScanScreen.tsx - Scan QR from gallery and accept invite (MLS).
 *
 * All content uses flexbox layout. Canvas only renders background.
 */

import React, { useCallback, useState } from 'react';
import {
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Canvas, Fill } from '@shopify/react-native-skia';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import * as ImagePicker from 'expo-image-picker';
import jsQR from 'jsqr';

import { theme } from './theme';
import { SkiaButton } from './SkiaButton';
import { useApp } from '../state/AppContext';
import { decodeQrPayload } from '../handshake/qr-encode';
import { DidResolver } from '@atproto/identity';
import type { RootStackParamList, DidDocWithHandle } from '../types/navigation';

type Navigation = NativeStackNavigationProp<RootStackParamList>;

type Status = 'idle' | 'scanning' | 'confirm' | 'processing' | 'error';

export function QrScanScreen(): React.JSX.Element {
  const app = useApp();
  const navigation = useNavigation<Navigation>();

  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);
  const [aliceHandle, setAliceHandle] = useState<string>('');
  const [qrString, setQrString] = useState<string | null>(null);

  const resolveHandle = async (did: string): Promise<string> => {
    try {
      const resolver = new DidResolver({});
      const doc = (await resolver.resolve(did)) as DidDocWithHandle | null;
      const aka = doc?.alsoKnownAs;
      if (Array.isArray(aka) && aka.length > 0) {
        return aka[0].replace(/^at:\/\//, '');
      }
    } catch (err) {
      console.error('QrScan: resolveHandle failed for', did, err);
    }
    return did;
  };

  const pickQrString = async (): Promise<string | null> => {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 1,
    });

    if (result.canceled || !result.assets[0]) {
      return null;
    }

    const asset = result.assets[0];
    const uri = asset.uri;

    // Decode image via canvas to get RGBA pixel data for jsQR
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = uri;
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('Failed to load image'));
    });

    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

    const code = jsQR(imageData.data, canvas.width, canvas.height);
    return code?.data ?? null;
  };

  const onScan = useCallback(async (): Promise<void> => {
    setStatus('scanning');
    setError(null);

    try {
      const decoded = await pickQrString();
      if (!decoded) {
        setStatus('idle');
        return;
      }

      const payload = decodeQrPayload(decoded);
      const handle = await resolveHandle(payload.aliceDid);
      setAliceHandle(handle);
      setQrString(decoded);
      setStatus('confirm');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to scan QR';
      console.error('[QrScan] scan error:', msg, err);
      setError(msg);
      setStatus('error');
    }
  }, []);

  const onAccept = useCallback(async (): Promise<void> => {
    if (!qrString) return;
    setStatus('processing');

    try {
      await app.acceptInviteQr(qrString);
      navigation.goBack();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to accept invite';
      console.error('[QrScan] accept error:', msg, err);
      setError(msg);
      setStatus('error');
    }
  }, [app, navigation, qrString]);

  return (
    <View style={styles.container}>
      <Canvas style={StyleSheet.absoluteFill}>
        <Fill color={theme.colors.background} />
      </Canvas>

      <View style={styles.content}>
        <Text style={styles.title}>Scan QR Code</Text>

        {status === 'scanning' && (
          <Text style={styles.statusText}>Opening gallery...</Text>
        )}

        {status === 'processing' && (
          <Text style={styles.statusText}>Accepting invite...</Text>
        )}

        {status === 'confirm' && (
          <>
            <Text style={styles.statusText}>
              {aliceHandle} wants to add you as a friend.
            </Text>
            <Text style={styles.subStatus}>Accept this friend request?</Text>
          </>
        )}

        {error && (
          <Text style={styles.errorText} selectable>{error}</Text>
        )}

        {status !== 'processing' && status !== 'confirm' && (
          <SkiaButton
            label={status === 'scanning' ? 'Scanning...' : 'Scan QR from Gallery'}
            onPress={onScan}
            variant="primary"
            style={styles.fullButton}
          />
        )}

        {status === 'confirm' && (
          <>
            <SkiaButton
              label="Accept"
              onPress={onAccept}
              variant="primary"
              style={styles.fullButton}
            />
            <SkiaButton
              label="Decline"
              onPress={() => {
                setQrString(null);
                setAliceHandle('');
                setStatus('idle');
              }}
              variant="secondary"
              style={styles.fullButton}
            />
          </>
        )}

        {status === 'error' && (
          <SkiaButton
            label="Try Again"
            onPress={() => setStatus('idle')}
            variant="secondary"
            style={styles.fullButton}
          />
        )}

        <SkiaButton
          label="Back"
          onPress={() => navigation.goBack()}
          variant="secondary"
          style={styles.fullButton}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  content: {
    flex: 1,
    paddingHorizontal: theme.spacing.md,
    paddingTop: theme.spacing.lg,
    gap: theme.spacing.md,
  },
  title: {
    color: theme.colors.textPrimary,
    fontSize: theme.typography.heading,
    fontWeight: '700',
    marginBottom: theme.spacing.sm,
  },
  statusText: {
    color: theme.colors.textSecondary,
    fontSize: theme.typography.body,
    lineHeight: 22,
  },
  subStatus: {
    color: theme.colors.textSecondary,
    fontSize: theme.typography.body,
    lineHeight: 22,
  },
  errorText: {
    color: theme.colors.error,
    fontSize: theme.typography.caption,
    lineHeight: 20,
  },
  fullButton: {
    width: '100%',
    height: 48,
  },
});
