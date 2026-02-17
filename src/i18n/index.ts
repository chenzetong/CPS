import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

type LocaleModule = { default: Record<string, unknown> };

const languageAliases: Record<string, string> = {
  'zh-CN': 'zh-cn',
  'zh-TW': 'zh-tw',
  'en-US': 'en',
  'pt-BR': 'pt-br',
  'vi-VN': 'vi',
  'vi-vn': 'vi',
};

export const supportedLanguages = [
  'en',
  'zh-cn',
  'zh-tw',
  'ja',
  'es',
  'de',
  'fr',
  'pt-br',
  'ru',
  'ko',
  'it',
  'tr',
  'pl',
  'cs',
  'vi',
  'ar',
];

const localeLoaders: Record<string, () => Promise<LocaleModule>> = {
  en: () => import('../locales/en.json'),
  'zh-cn': () => import('../locales/zh-CN.json'),
  'zh-tw': () => import('../locales/zh-tw.json'),
  ja: () => import('../locales/ja.json'),
  es: () => import('../locales/es.json'),
  de: () => import('../locales/de.json'),
  fr: () => import('../locales/fr.json'),
  'pt-br': () => import('../locales/pt-br.json'),
  ru: () => import('../locales/ru.json'),
  ko: () => import('../locales/ko.json'),
  it: () => import('../locales/it.json'),
  tr: () => import('../locales/tr.json'),
  pl: () => import('../locales/pl.json'),
  cs: () => import('../locales/cs.json'),
  vi: () => import('../locales/vi.json'),
  ar: () => import('../locales/ar.json'),
};

const loadedLanguages = new Set<string>();
let initPromise: Promise<void> | null = null;

export function normalizeLanguage(lang: string): string {
  const trimmed = lang.trim();
  if (!trimmed) {
    return 'zh-cn';
  }

  if (languageAliases[trimmed]) {
    return languageAliases[trimmed];
  }

  const lower = trimmed.toLowerCase();
  if (languageAliases[lower]) {
    return languageAliases[lower];
  }

  return lower;
}

function resolveSupportedLanguage(lang: string): string {
  const normalized = normalizeLanguage(lang);
  return supportedLanguages.includes(normalized) ? normalized : 'en';
}

async function ensureLanguageResources(lang: string): Promise<string> {
  const resolved = resolveSupportedLanguage(lang);
  if (loadedLanguages.has(resolved)) {
    return resolved;
  }

  const loader = localeLoaders[resolved] ?? localeLoaders.en;
  const module = await loader();
  i18n.addResourceBundle(resolved, 'translation', module.default, true, true);
  loadedLanguages.add(resolved);
  return resolved;
}

export async function initI18n(): Promise<void> {
  if (initPromise) {
    return initPromise;
  }

  initPromise = (async () => {
    const savedLanguage = resolveSupportedLanguage(
      localStorage.getItem('app-language') || 'en',
    );

    await i18n
      .use(initReactI18next)
      .init({
        resources: {},
        lng: 'en',
        fallbackLng: 'en',
        supportedLngs: supportedLanguages,
        lowerCaseLng: true,
        load: 'currentOnly',
        interpolation: {
          escapeValue: false, // React 已经处理了 XSS
        },
      });

    await ensureLanguageResources('en');
    if (savedLanguage !== 'en') {
      await ensureLanguageResources(savedLanguage);
    }
    await i18n.changeLanguage(savedLanguage);
  })();

  return initPromise;
}

void initI18n();

/**
 * 切换语言
 */
export async function changeLanguage(lang: string): Promise<void> {
  const resolved = await ensureLanguageResources(lang);
  await i18n.changeLanguage(resolved);
  localStorage.setItem('app-language', resolved);
}

/**
 * 获取当前语言
 */
export function getCurrentLanguage(): string {
  return normalizeLanguage(i18n.language || 'zh-CN');
}

export default i18n;
