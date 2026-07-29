/**
 * ui/EmojiPicker.tsx - Floating emoji reaction picker anchored near trigger button.
 */

import React, { useState } from 'react';
import { Dimensions, Modal, Pressable, StyleSheet, Text } from 'react-native';

import { theme } from './theme';

const PRESET_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🎉', '🔥', '👏', '🙏', '💯'];

export interface EmojiPickerProps {
  visible: boolean;
  layout: { x: number; y: number; width: number; height: number } | null;
  onSelect: (emoji: string) => void;
  onClose: () => void;
}

export function EmojiPicker({ visible, layout, onSelect, onClose }: EmojiPickerProps): React.JSX.Element {
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
  const left = Math.max(
    GAP,
    Math.min(layout.x, screen.width - panelSize.width - GAP),
  );

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
          {PRESET_EMOJIS.map((emoji) => (
            <Pressable
              key={emoji}
              onPress={() => { onSelect(emoji); onClose(); }}
              style={styles.emojiBtn}
            >
              <Text style={styles.emoji}>{emoji}</Text>
            </Pressable>
          ))}
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
    flexDirection: 'row',
    flexWrap: 'wrap',
    maxWidth: Dimensions.get('window').width - 16,
    backgroundColor: theme.colors.surface,
    borderRadius: theme.borderRadius.md,
    padding: theme.spacing.xs,
    elevation: 5,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 4,
  },
  emojiBtn: {
    padding: theme.spacing.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emoji: {
    fontSize: 22,
  },
});
