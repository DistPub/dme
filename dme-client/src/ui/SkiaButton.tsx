/**
 * ui/SkiaButton.tsx - Skia-rendered button with RNGH tap overlay.
 *
 * Each button is a self-contained Canvas wrapped in GestureDetector.
 * Supports two layout modes:
 *   - Absolute: pass x/y/w/h (backward compat)
 *   - Flex: omit x/y, pass style prop for flex container
 */

import React, { useMemo, useState } from 'react';
import {
  View,
  type ViewStyle,
} from 'react-native';
import {
  Canvas,
  RoundedRect,
  Text,
} from '@shopify/react-native-skia';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';

import { theme } from './theme';
import { useAppFont } from './FontProvider';

export interface SkiaButtonProps {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary';
  style?: ViewStyle;
  /** @deprecated Absolute positioning - prefer flex via style prop */
  x?: number;
  y?: number;
  w?: number;
  h?: number;
}

export function SkiaButton({
  label,
  onPress,
  variant = 'primary',
  style,
  x,
  y,
  w,
  h,
}: SkiaButtonProps): React.JSX.Element {
  const font = useAppFont(theme.typography.body);

  const bgColor =
    variant === 'primary' ? theme.colors.accent : theme.colors.surface;
  const textColor = theme.colors.textPrimary;

  const tap = useMemo(
    () =>
      Gesture.Tap()
        .maxDuration(250)
        .onEnd(() => {
          'worklet';
          onPress();
        }),
    [onPress],
  );

  const isAbsolute = x !== undefined && y !== undefined && w !== undefined && h !== undefined;
  const fallbackSize = 48;
  const [layout, setLayout] = useState({ w: w ?? fallbackSize, h: h ?? fallbackSize });

  const containerStyle: ViewStyle = isAbsolute
    ? { position: 'absolute', left: x, top: y, width: w, height: h }
    : (style ?? { flex: 1 });

  // measureText throws NotImplementedOnRNWeb on web; use getTextWidth instead.
  const textWidth = font ? font.getTextWidth(label) : 0;
  const textX = (layout.w - textWidth) / 2;
  const textY = layout.h / 2 + (font ? font.getSize() / 3 : 0);

  return (
    <GestureDetector gesture={tap}>
      <View
        style={containerStyle}
        onLayout={(e) => {
          if (!isAbsolute) {
            setLayout({
              w: e.nativeEvent.layout.width,
              h: e.nativeEvent.layout.height,
            });
          }
        }}
      >
        <Canvas style={{ flex: 1 }}>
          <RoundedRect
            x={0}
            y={0}
            width={layout.w}
            height={layout.h}
            r={theme.borderRadius.sm}
            color={bgColor}
          />
          {font && (
            <Text
              text={label}
              x={textX}
              y={textY}
              font={font}
              color={textColor}
            />
          )}
        </Canvas>
      </View>
    </GestureDetector>
  );
}
