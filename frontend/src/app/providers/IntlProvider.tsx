"use client";

import { NextIntlClientProvider } from "next-intl";
import { type ReactNode, useEffect } from "react";
import { getSystemLocale } from "@/shared/api/ipc-client";
import { messages, pickLocaleFromSystem, useLocaleStore } from "@/shared/i18n";

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

	return (
		<NextIntlClientProvider
			locale={locale}
			messages={messages[locale]}
			timeZone={Intl.DateTimeFormat().resolvedOptions().timeZone}
		>
			{children}
		</NextIntlClientProvider>
	);
}
