import { useEffect } from "react";
import { useLocaleStore } from "@/shared/i18n";

/** Keeps the <html lang="…"> attribute in sync with the selected locale. */
export function HtmlLang() {
	const locale = useLocaleStore((s) => s.locale);

	useEffect(() => {
		document.documentElement.lang = locale;
	}, [locale]);

	return null;
}
