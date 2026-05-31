import { type ReactNode, useEffect } from "react";
import { IntlProvider as UseIntlProvider } from "use-intl/react";
import { getSystemLocale } from "@/shared/api/ipc-client";
import { messages, pickLocaleFromSystem, useLocaleStore } from "@/shared/i18n";
import { RTL_LOCALES } from "@/shared/i18n/config";

const LOCALE_STORAGE_KEY = "winstt-locale";

export function IntlProvider({ children }: { children: ReactNode }) {
	const locale = useLocaleStore((s) => s.locale);
	const setLocale = useLocaleStore((s) => s.setLocale);

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

	// Apply <html dir="rtl"> when the active locale is right-to-left so
	// flex / margin / icon-position CSS flips automatically. Reverts to
	// "ltr" on cleanup so a locale switch back to LTR also takes effect.
	// Guarded on `typeof document` so Bun's SSR-ish test envs (where
	// `document` may be missing) stay no-op.
	useEffect(() => {
		if (typeof document === "undefined") {
			return;
		}
		const dir = RTL_LOCALES.has(locale) ? "rtl" : "ltr";
		document.documentElement.setAttribute("dir", dir);
		document.documentElement.setAttribute("lang", locale);
	}, [locale]);

	return (
		<UseIntlProvider
			locale={locale}
			messages={messages[locale]}
			timeZone={Intl.DateTimeFormat().resolvedOptions().timeZone}
		>
			{children}
		</UseIntlProvider>
	);
}
