"use client";

import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { messages, useLocaleStore } from "@/shared/i18n";

export function IntlProvider({ children }: { children: ReactNode }) {
	const locale = useLocaleStore((s) => s.locale);

	console.log("[IntlProvider] Rendering, locale=", locale, "has messages:", !!messages[locale]);

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
