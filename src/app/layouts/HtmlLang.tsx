import { useEffect } from "react";
import { installElectronTauriAdapter } from "@/shared/api/electron-tauri-adapter";
import { useLocaleStore } from "@/shared/i18n";

// Every one of the 9 window entries imports HtmlLang, so installing the
// `window.electronAPI` → Tauri polyfill here (a module-load side-effect, before
// any view renders) guarantees the IPC seam exists in EVERY window — not just
// the main window (which also installs it via IpcProvider). Install is
// idempotent, so the double-install from main is harmless.
installElectronTauriAdapter();

/** Keeps the <html lang="…"> attribute in sync with the selected locale. */
export function HtmlLang() {
	const locale = useLocaleStore((s) => s.locale);

	useEffect(() => {
		document.documentElement.lang = locale;
	}, [locale]);

	return null;
}
