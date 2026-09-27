/**
 * ui/Button.tsx - Pressable 按钮，原生 Text 渲染（支持中文）。
 *
 * 替代 SkiaButton 用于需要非 ASCII label 的场景。API 与 SkiaButton 完全兼容
 * （label / onPress / variant / disabled / style），可直接替换。
 */

import React from 'react';
import { Pressable, StyleSheet, Text, type ViewStyle } from 'react-native';
import { theme } from './theme';

export interface ButtonProps {
  label: string;
  onPress: () => void;
  onPressIn?: () => void;
  variant?: 'primary' | 'secondary';
  disabled?: boolean;
  style?: ViewStyle;
}

export function Button({
  label,
  onPress,
  onPressIn,
  variant = 'primary',
  disabled = false,
  style,
}: ButtonProps): React.JSX.Element {
  return (
    <Pressable
      onPress={onPress}
      onPressIn={onPressIn}
      disabled={disabled}
      style={({ pressed }) => [
        styles.base,
        variant === 'primary' ? styles.primary : styles.secondary,
        disabled && styles.disabled,
        pressed && !disabled && styles.pressed,
        style ?? { flex: 1, height: 48 },
      ]}
    >
      <Text
        style={[
          styles.label,
          disabled
            ? styles.labelDisabled
            : variant === 'primary'
              ? styles.labelPrimary
              : styles.labelSecondary,
        ]}
        numberOfLines={1}
      >
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    borderRadius: theme.borderRadius.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primary: {
    backgroundColor: theme.colors.accent,
  },
  secondary: {
    backgroundColor: theme.colors.surface,
  },
  disabled: {
    backgroundColor: theme.colors.border,
  },
  pressed: {
    opacity: 0.7,
  },
  label: {
    fontSize: theme.typography.body,
    fontWeight: '600',
  },
  labelPrimary: {
    color: theme.colors.textPrimary,
  },
  labelSecondary: {
    color: theme.colors.textPrimary,
  },
  labelDisabled: {
    color: theme.colors.placeholder,
  },
});
