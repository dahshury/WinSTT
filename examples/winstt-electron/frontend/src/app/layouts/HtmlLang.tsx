import { useEffect } from "react";
import { useLocaleStore } from "@/shared/i18n";
import { installScrollbarAutoHide } from "@/shared/lib/scrollbar-autohide";

// Every window entry renders HtmlLang, so this module-load side-effect installs
// the app-wide "reveal the native scrollbar only while scrolling" listener in
// every webview. Idempotent.
installScrollbarAutoHide();

/** Keeps the <html lang="…"> attribute in sync with the selected locale. */
export function HtmlLang() {
	const locale = useLocaleStore((s) => s.locale);

	useEffect(() => {
		document.documentElement.lang = locale;
	}, [locale]);

	return null;
}
