import { type ReactNode, useEffect, useState } from "react";
import { IntlProvider as UseIntlProvider } from "use-intl/react";
import defaultMessages from "../../../messages/en.json";
import { getSystemLocale } from "@/shared/api/ipc-client";
import {
  DEFAULT_LOCALE,
  loadMessages,
  pickLocaleFromSystem,
  useLocaleStore,
} from "@/shared/i18n";

const LOCALE_STORAGE_KEY = "winstt-locale";
const DEFAULT_MESSAGE_BUNDLE = defaultMessages as Record<string, unknown>;

export function IntlProvider({ children }: { children: ReactNode }) {
  const locale = useLocaleStore((s) => s.locale);
  const setLocale = useLocaleStore((s) => s.setLocale);

  // Messages are still loaded lazily per-locale, but the first frame uses the
  // synchronous English bundle. That keeps the Tauri webview mounted even if a
  // Vite dev-server chunk request stalls during startup.
  const [bundle, setBundle] = useState<{
    locale: string;
    messages: Record<string, unknown>;
  }>({
    locale: DEFAULT_LOCALE,
    messages: DEFAULT_MESSAGE_BUNDLE,
  });

  useEffect(() => {
    if (locale === DEFAULT_LOCALE) {
      setBundle({ locale, messages: DEFAULT_MESSAGE_BUNDLE });
      return;
    }
    let cancelled = false;
    loadMessages(locale)
      .then((loaded) => {
        if (!cancelled) {
          setBundle({ locale, messages: loaded });
        }
      })
      .catch(() => {
        // Keep the renderer mounted with the synchronous English bundle if a
        // dev-server chunk load stalls or fails during first boot.
        if (!cancelled) {
          setBundle({ locale, messages: DEFAULT_MESSAGE_BUNDLE });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [locale]);

  useEffect(() => {
    // First-launch only: if the user has already chosen a locale,
    // the Zustand persist middleware will have written this key.
    if (typeof window === "undefined") {
      return;
    }
    if (window.localStorage.getItem(LOCALE_STORAGE_KEY) !== null) {
      return;
    }
    let cancelled = false;
    getSystemLocale()
      .then((systemLocale) => {
        if (cancelled) {
          return;
        }
        if (window.localStorage.getItem(LOCALE_STORAGE_KEY) !== null) {
          return;
        }
        setLocale(pickLocaleFromSystem(systemLocale));
      })
      .catch(() => {
        // Fall back silently to DEFAULT_LOCALE; user can still pick manually.
      });
    return () => {
      cancelled = true;
    };
  }, [setLocale]);

  // The UI layout stays LEFT-TO-RIGHT for every locale by design — RTL
  // languages (Arabic, Hebrew) are translated in place but must NOT mirror
  // the interface. We still set `lang` for accessibility / hyphenation, but
  // `dir` is pinned to "ltr". Guarded on `typeof document` so Bun's SSR-ish
  // test envs (where `document` may be missing) stay no-op.
  useEffect(() => {
    if (typeof document === "undefined") {
      return;
    }
    document.documentElement.setAttribute("dir", "ltr");
    document.documentElement.setAttribute("lang", locale);
  }, [locale]);

  const messages =
    bundle.locale === locale ? bundle.messages : DEFAULT_MESSAGE_BUNDLE;

  return (
    <UseIntlProvider
      locale={locale}
      messages={messages}
      timeZone={Intl.DateTimeFormat().resolvedOptions().timeZone}
    >
      {children}
    </UseIntlProvider>
  );
}
