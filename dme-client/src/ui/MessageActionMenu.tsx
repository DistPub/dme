/**
 * ui/MessageActionMenu.tsx - Floating action menu for message bubble long-press / right-click.
 *
 * Shows Copy / Forward / Delete actions anchored near the tapped bubble.
 * Positioning logic mirrors EmojiPicker: above-first, clamp to screen bounds.
 */

import React, { useState } from 'react';
import { Dimensions, Modal, Pressable, StyleSheet, Text, View } from 'react-native';

import { theme } from './theme';
import { useI18n } from '../i18n/I18nContext';

export interface MessageActionMenuProps {
  visible: boolean;
  layout: { x: number; y: number; width: number; height: number } | null;
  isOutgoing: boolean;
  showCopy?: boolean;
  onCopy: () => void;
  onForward: () => void;
  onDelete: () => void;
  onClose: () => void;
}

export function MessageActionMenu({
  visible,
  layout,
  isOutgoing,
  showCopy = true,
  onCopy,
  onForward,
  onDelete,
  onClose,
}: MessageActionMenuProps): React.JSX.Element {
  const { t } = useI18n();
  const [panelSize, setPanelSize] = useState({ width: 0, height: 0 });
  const screen = Dimensions.get('window');

  if (!visible || !layout) {
    return <></>;
  }

  const GAP = 8;
  const showAbove = layout.y > panelSize.height + GAP + 16;
  const top = showAbove
    ? Math.max(0, layout.y - panelSize.height - GAP)
    : layout.y + layout.height + GAP;
  // Outgoing bubbles are right-aligned; anchor menu to the right edge of the bubble.
  // Incoming bubbles are left-aligned; anchor to the left edge.
  const left = isOutgoing
    ? Math.max(GAP, Math.min(layout.x + layout.width - panelSize.width, screen.width - panelSize.width - GAP))
    : Math.max(GAP, Math.min(layout.x, screen.width - panelSize.width - GAP));

  const handlePress = (action: () => void): void => {
    action();
    onClose();
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="none"
      onRequestClose={onClose}
    >
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable
          style={[styles.panel, { top, left }]}
          onLayout={(e) => {
            const { width, height } = e.nativeEvent.layout;
            setPanelSize({ width, height });
          }}
          onPress={(e) => e.stopPropagation()}
        >
          {showCopy ? (
            <>
              <Pressable style={styles.item} onPress={() => handlePress(onCopy)}>
                <Text style={styles.itemText}>{t('menu.copy')}</Text>
              </Pressable>
              <View style={styles.divider} />
            </>
          ) : null}
          <Pressable style={styles.item} onPress={() => handlePress(onForward)}>
            <Text style={styles.itemText}>{t('menu.forward')}</Text>
          </Pressable>
          <View style={styles.divider} />
          <Pressable style={styles.item} onPress={() => handlePress(onDelete)}>
            <Text style={[styles.itemText, styles.deleteText]}>{t('menu.delete')}</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
  },
  panel: {
    position: 'absolute',
    minWidth: 120,
    backgroundColor: theme.colors.surface,
    borderRadius: theme.borderRadius.md,
    paddingVertical: 4,
    elevation: 5,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 4,
  },
  item: {
    paddingHorizontal: theme.spacing.md,
    paddingVertical: 10,
  },
  itemText: {
    color: theme.colors.textPrimary,
    fontSize: theme.typography.body,
  },
  deleteText: {
    color: theme.colors.error,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: theme.colors.border,
    marginHorizontal: theme.spacing.sm,
  },
});
