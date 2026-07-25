/**
 * ui/theme.ts - Dark theme design tokens for DME chat app.
 *
 * All visual constants live here. No hardcoded colors/spacing in components.
 */

export const theme = {
  colors: {
    background: '#0a0a0a',
    surface: '#1C1C1E',
    textPrimary: '#e0e0e0',
    textSecondary: '#8E8E93',
    accent: '#007AFF',
    accentPressed: '#0056CC',
    incomingBubble: '#1C1C1E',
    outgoingBubble: '#007AFF',
    error: '#FF3B30',
    success: '#34C759',
    border: '#2C2C2E',
    inputBackground: '#1C1C1E',
    placeholder: '#8E8E93',
  },
  spacing: {
    xs: 4,
    sm: 8,
    md: 16,
    lg: 24,
    xl: 32,
  },
  borderRadius: {
    sm: 8,
    md: 12,
    lg: 16,
    full: 9999,
  },
  typography: {
    title: 32,
    heading: 24,
    body: 16,
    caption: 14,
    small: 12,
  },
} as const;
