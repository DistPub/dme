/**
 * ui/FontProvider.tsx - 全应用共享的 Skia 字体加载。
 *
 * 一次性加载 Roboto-Regular.ttf 的 typeface,所有组件通过 useAppFont(size)
 * 获取对应尺寸的 SkFont,避免同一字体文件被重复 fetch(之前 3 个组件各 fetch 一次)。
 *
 * 提供 useFontProvider() 用于 ParagraphBuilder.Make()（Web 上必填 typefaceProvider）。
 */
import React, { createContext, useContext, useMemo } from 'react';
import { Skia, useTypeface } from '@shopify/react-native-skia';
import type { SkFont, SkTypeface, SkTypefaceFontProvider } from '@shopify/react-native-skia';
import { Platform } from 'react-native';

const FONT_SOURCE =
  Platform.OS === 'web'
    ? '/fonts/Roboto-Regular.ttf'
    : require('../assets/fonts/Roboto-Regular.ttf');

const FONT_FAMILY = 'Roboto';

interface FontContextValue {
  typeface: SkTypeface | null;
  fontProvider: SkTypefaceFontProvider | null;
}

const FontContext = createContext<FontContextValue>({ typeface: null, fontProvider: null });

export function FontProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const typeface = useTypeface(FONT_SOURCE);

  const fontProvider = useMemo(() => {
    if (!typeface) return null;
    const mgr = Skia.TypefaceFontProvider.Make();
    mgr.registerFont(typeface, FONT_FAMILY);
    return mgr;
  }, [typeface]);

  const value = useMemo<FontContextValue>(() => ({ typeface, fontProvider }), [typeface, fontProvider]);

  return <FontContext.Provider value={value}>{children}</FontContext.Provider>;
}

export function useAppFont(size: number): SkFont | null {
  const { typeface } = useContext(FontContext);

  return useMemo(() => {
    if (typeface) {
      return Skia.Font(typeface, size);
    }
    return null;
  }, [typeface, size]);
}

export function useFontProvider(): SkTypefaceFontProvider | null {
  const { fontProvider } = useContext(FontContext);
  return fontProvider;
}
