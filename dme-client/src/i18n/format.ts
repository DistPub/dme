import { en, zh, type Language } from './translations';

export function t(
  lang: Language,
  key: string,
  params?: Record<string, string | number>,
): string {
  const dict = lang === 'en' ? en : zh;
  let value = dict[key] ?? zh[key] ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      value = value.split(`{${k}}`).join(String(v));
    }
  }
  return value;
}
