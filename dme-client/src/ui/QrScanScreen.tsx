/**
 * ui/QrScanScreen.tsx - Scan QR from gallery and accept handshake.
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

import { theme } from './theme';
import { SkiaButton } from './SkiaButton';
import { useApp } from '../state/AppContext';
import { pickAndDecodeQR } from '../handshake/qr-decode';
import { encryptMessage } from '../crypto/envelope';
import type { HandshakePayload } from '../handshake/handshake';
import { DidResolver } from '@atproto/identity';
import type { RootStackParamList, DidDocWithHandle } from '../types/navigation';

type Navigation = NativeStackNavigationProp<RootStackParamList>;

export function QrScanScreen(): React.JSX.Element {
  const app = useApp();
  const navigation = useNavigation<Navigation>();

  const [status, setStatus] = useState<'idle' | 'scanning' | 'confirm' | 'processing' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [aliceHandle, setAliceHandle] = useState('');
  const [pendingPayload, setPendingPayload] = useState<HandshakePayload | null>(null);

  const resolveHandle = async (did: string): Promise<string> => {
    try {
      const resolver = new DidResolver({});
      const doc = (await resolver.resolve(did)) as DidDocWithHandle | null;
      const aka = doc?.alsoKnownAs;
      if (Array.isArray(aka) && aka.length > 0) {
        return aka[0].replace(/^at:\/\//, '');
      }
    } catch (err) {
      console.error('Failed to resolve handle for', did, err);
    }
    return did;
  };

  const onScan = useCallback(async (): Promise<void> => {
    setStatus('scanning');
    setError(null);

    try {
      const payload = await pickAndDecodeQR();
      if (!payload) {
        setStatus('idle');
        return;
      }

      const handle = await resolveHandle(payload.aliceDid);
      setAliceHandle(handle);
      setPendingPayload(payload);
      setStatus('confirm');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to scan QR';
      console.error('[QrScan] scan error:', msg, err);
      setError(msg);
      setStatus('error');
    }
  }, []);

  const onAccept = useCallback(async (): Promise<void> => {
    if (!pendingPayload) return;
    setStatus('processing');

    try {
      const { ratchet } = await app.acceptHandshake(pendingPayload);

      const ackEnvelope = encryptMessage(
        ratchet,
        new TextEncoder().encode('ACK'),
      );
      if (!app.pds) {
        throw new Error('PDS not initialized');
      }
      await app.pds.createEnvelope(ackEnvelope);
      await app.storage!.putRatchet(pendingPayload.aliceDid, ratchet.serialize());

      navigation.goBack();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to accept handshake';
      console.error('[QrScan] accept error:', msg, err);
      setError(msg);
      setStatus('error');
    }
  }, [app, navigation, pendingPayload]);

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
          <Text style={styles.statusText}>Accepting handshake...</Text>
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
                setPendingPayload(null);
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
