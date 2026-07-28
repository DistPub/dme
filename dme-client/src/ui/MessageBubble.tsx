/**
 * ui/MessageBubble.tsx - RN native message bubble.
 */

import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { theme } from './theme';

export interface MessageBubbleProps {
  text: string;
  isOutgoing: boolean;
  senderName?: string;
}

const BUBBLE_PADDING = 12;
const BUBBLE_MARGIN = 16;
const BUBBLE_MAX_WIDTH_RATIO = 0.75;

export function MessageBubble({
  text,
  isOutgoing,
  senderName,
}: MessageBubbleProps): React.JSX.Element {
  return (
    <View style={styles.container}>
      {senderName && !isOutgoing && (
        <Text style={styles.senderName} numberOfLines={1}>{senderName}</Text>
      )}
      <View
        style={[
          styles.bubble,
          isOutgoing ? styles.outgoing : styles.incoming,
        ]}
      >
        <Text style={styles.text}>{text}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginHorizontal: BUBBLE_MARGIN,
    marginVertical: BUBBLE_MARGIN / 2,
  },
  senderName: {
    color: theme.colors.textSecondary,
    fontSize: 12,
    marginLeft: 4,
    marginBottom: 2,
  },
  bubble: {
    maxWidth: `${BUBBLE_MAX_WIDTH_RATIO * 100}%`,
    paddingVertical: BUBBLE_PADDING,
    paddingHorizontal: BUBBLE_PADDING,
    borderRadius: theme.borderRadius.md,
  },
  outgoing: {
    alignSelf: 'flex-end',
    backgroundColor: theme.colors.outgoingBubble,
  },
  incoming: {
    alignSelf: 'flex-start',
    backgroundColor: theme.colors.incomingBubble,
  },
  text: {
    color: theme.colors.textPrimary,
    fontSize: theme.typography.body,
  },
});
