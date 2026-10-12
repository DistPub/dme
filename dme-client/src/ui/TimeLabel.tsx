/**
 * ui/TimeLabel.tsx - 聊天时间展示组件。
 *
 * - ChatDayDivider：跨天时的居中日期胶囊（今天 / 昨天 / 日期）。
 * - TimeOutside：气泡外侧贴的小号时间（发出在右、收到在左），由气泡组件定位。
 */

import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { theme } from './theme';

export function ChatDayDivider({ label }: { label: string }): React.JSX.Element {
  return (
    <View style={styles.dividerWrap}>
      <Text style={styles.dividerText}>{label}</Text>
    </View>
  );
}

export function TimeOutside({ text }: { text: string }): React.JSX.Element {
  return <Text style={styles.timeOutside}>{text}</Text>;
}

const styles = StyleSheet.create({
  dividerWrap: {
    alignItems: 'center',
    marginVertical: theme.spacing.sm,
  },
  dividerText: {
    fontSize: theme.typography.small,
    color: theme.colors.textSecondary,
    backgroundColor: theme.colors.surface,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: 2,
    borderRadius: theme.borderRadius.full,
    overflow: 'hidden',
    includeFontPadding: false,
  },
  timeOutside: {
    fontSize: 11,
    color: theme.colors.textSecondary,
    marginHorizontal: 4,
    includeFontPadding: false,
  },
});
