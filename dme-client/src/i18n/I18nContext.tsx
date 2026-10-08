import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { storage } from '../storage/backend';

import { t as tRaw } from './format';
import type { Language } from './translations';

const STORAGE_KEY = 'dme:language';

interface I18nContextValue {
  language: Language;
  setLanguage: (lang: Language) => Promise<void>;
  t: (key: string, params?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [language, setLanguageState] = useState<Language>('zh');

  useEffect(() => {
    storage.getItem(STORAGE_KEY)
      .then((stored) => {
        if (stored === 'zh' || stored === 'en') {
          setLanguageState(stored);
        }
      })
      .catch((err) => {
        console.error('Failed to load language preference:', err);
      });
  }, []);

  const setLanguage = useCallback(async (lang: Language) => {
    await storage.setItem(STORAGE_KEY, lang);
    setLanguageState(lang);
  }, []);

  const t = useCallback(
    (key: string, params?: Record<string, string | number>) => tRaw(language, key, params),
    [language],
  );

  const value = useMemo(
    () => ({ language, setLanguage, t }),
    [language, setLanguage, t],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const context = useContext(I18nContext);
  if (context === null) {
    throw new Error('useI18n must be used within an I18nProvider');
  }
  return context;
}
