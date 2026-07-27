import React, { useState } from 'react';
import { StyleSheet, Text, View, TextInput } from 'react-native';
import { Canvas, Fill } from '@shopify/react-native-skia';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';

import { theme } from './theme';
import { SkiaButton } from './SkiaButton';
import { useApp } from '../state/AppContext';
import type { RootStackParamList } from '../types/navigation';

interface Props {
  navigation: NativeStackNavigationProp<RootStackParamList, 'Settings'>;
}

export function SettingsScreen({ navigation }: Props): React.JSX.Element {
  const app = useApp();
  const [draft, setDraft] = useState(String(app.pollBatchSize));
  const [saved, setSaved] = useState(false);

  const handleSave = async (): Promise<void> => {
    const n = parseInt(draft, 10);
    if (!Number.isFinite(n) || n < 1 || n > 20) return;
    await app.setPollBatchSize(n);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <View style={styles.container}>
      <Canvas style={StyleSheet.absoluteFill}>
        <Fill color={theme.colors.background} />
      </Canvas>

      <View style={styles.content}>
        <Text style={styles.title}>Settings</Text>

        <Text style={styles.label}>Poll Batch Size</Text>
        <Text style={styles.hint}>
          How many future messages to check per poll cycle (1-20).
        </Text>
        <TextInput
          style={styles.input}
          value={draft}
          onChangeText={setDraft}
          keyboardType="numeric"
          placeholder="3"
          placeholderTextColor={theme.colors.textSecondary}
        />

        <SkiaButton
          label={saved ? 'Saved!' : 'Save'}
          onPress={handleSave}
          variant="primary"
          style={styles.fullButton}
        />

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
    paddingHorizontal: theme.spacing.lg,
    paddingTop: theme.spacing.xl,
    gap: theme.spacing.md,
  },
  title: {
    color: theme.colors.textPrimary,
    fontSize: theme.typography.heading,
    fontWeight: '700',
    marginBottom: theme.spacing.sm,
  },
  label: {
    color: theme.colors.textPrimary,
    fontSize: theme.typography.body,
    fontWeight: '600',
  },
  hint: {
    color: theme.colors.textSecondary,
    fontSize: theme.typography.caption,
  },
  input: {
    width: '100%',
    height: 48,
    backgroundColor: theme.colors.inputBackground,
    borderRadius: theme.borderRadius.sm,
    borderWidth: 1,
    borderColor: theme.colors.border,
    color: theme.colors.textPrimary,
    fontSize: theme.typography.body,
    paddingHorizontal: theme.spacing.md,
  },
  fullButton: {
    width: '100%',
    height: 48,
  },
});
