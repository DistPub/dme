/**
 * ui/TextInputOverlay.tsx - RN TextInput overlay for Skia Canvas.
 *
 * Supports two layout modes:
 *   - Absolute: pass x/y/width/height (backward compat)
 *   - Flex: omit x/y, pass style prop for flex container
 */

import React from 'react';
import {
  StyleSheet,
  TextInput,
  View,
  type ViewStyle,
} from 'react-native';

import { theme } from './theme';

export interface TextInputOverlayProps {
  value: string;
  onChangeText: (text: string) => void;
  placeholder?: string;
  onSubmit?: () => void;
  secureTextEntry?: boolean;
  editable?: boolean;
  style?: ViewStyle;
  /** @deprecated Absolute positioning - prefer flex via style prop */
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

export function TextInputOverlay({
  value,
  onChangeText,
  placeholder,
  onSubmit,
  secureTextEntry = false,
  editable = true,
  style,
  x,
  y,
  width,
  height,
}: TextInputOverlayProps): React.JSX.Element {
  const isAbsolute = x !== undefined || y !== undefined;

  const containerStyle: ViewStyle[] = [
    styles.container,
    isAbsolute
      ? { position: 'absolute', left: x ?? 0, top: y ?? 0, width: width ?? 300, height: height ?? 48 }
      : (style ?? { flex: 1 }),
  ];

  return (
    <View style={containerStyle}>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={theme.colors.placeholder}
        secureTextEntry={secureTextEntry}
        editable={editable}
        onSubmitEditing={onSubmit}
        returnKeyType={onSubmit ? 'send' : 'default'}
        style={styles.input}
        autoCapitalize="none"
        autoCorrect={false}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: theme.colors.inputBackground,
    borderRadius: theme.borderRadius.sm,
    borderWidth: 1,
    borderColor: theme.colors.border,
    justifyContent: 'center',
    paddingHorizontal: theme.spacing.md,
  },
  input: {
    color: theme.colors.textPrimary,
    fontSize: theme.typography.body,
    height: '100%',
  },
});
