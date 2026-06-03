import { type ReactNode, useEffect, useState } from "react";
import { IntlProvider as UseIntlProvider } from "use-intl/react";
import { getSystemLocale } from "@/shared/api/ipc-client";
import { loadMessages, pickLocaleFromSystem, useLocaleStore } from "@/shared/i18n";

const LOCALE_STORAGE_KEY = "winstt-locale";

export function IntlProvider({ children }: { children: ReactNode }) {
	const locale = useLocaleStore((s) => s.locale);
	const setLocale = useLocaleStore((s) => s.setLocale);

	// Messages are loaded lazily per-locale (one code-split chunk each) so a
	// window only bundles the locale it renders. We hold the active locale's
	// bundle in state and re-fetch on locale change. `bundle` stays null until
	// the first load resolves; children render only once messages are ready so
	// no string flashes the raw key.
	const [bundle, setBundle] = useState<{
		locale: string;
		messages: Record<string, unknown>;
	} | null>(null);

	useEffect(() => {
		let cancelled = false;
		loadMessages(locale)
			.then((loaded) => {
				if (!cancelled) {
					setBundle({ locale, messages: loaded });
				}
			})
			.catch(() => {
				// loadMessages already falls back to the default locale; a reject
				// here means even that failed. Render with an empty bundle so the
				// app still mounts (use-intl tolerates missing messages).
				if (!cancelled) {
					setBundle({ locale, messages: {} });
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

	// Render nothing until the active locale's bundle is ready. The outer
	// Suspense fallback (per-window entry) already gates first paint on `null`,
	// so this is consistent with the existing loading convention. Guard against
	// a stale bundle from a previous locale during a switch.
	if (bundle === null || bundle.locale !== locale) {
		return null;
	}

	return (
		<UseIntlProvider
			locale={locale}
			messages={bundle.messages}
			timeZone={Intl.DateTimeFormat().resolvedOptions().timeZone}
		>
			{children}
		</UseIntlProvider>
	);
}
