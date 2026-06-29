import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { DEFAULT_LOCALE, type Locale } from './locale';
import { makeT, type TFunction } from './t';

// Locale context fed from the ROOT LOADER (see root.tsx), never derived on the client — so the value
// is identical across SSR and hydration and React never warns about a mismatch.

type LocaleValue = { locale: Locale; t: TFunction };

const LocaleContext = createContext<LocaleValue>({
  locale: DEFAULT_LOCALE,
  t: makeT(DEFAULT_LOCALE),
});

export function LocaleProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
  const value = useMemo<LocaleValue>(() => ({ locale, t: makeT(locale) }), [locale]);
  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale(): Locale {
  return useContext(LocaleContext).locale;
}

export function useTranslation(): TFunction {
  return useContext(LocaleContext).t;
}
