import { useEffect } from "react";
import { initCatalogStore } from "@/entities/model-catalog/model/catalog-store";
import { installNativeBridge } from "@/shared/api/native-bridge-adapter";
import { useLocaleStore } from "@/shared/i18n";
import { installScrollbarAutoHide } from "@/shared/lib/scrollbar-autohide";
import { installTouchRubberBand } from "@/shared/lib/touch-rubber-band";

// Every one of the 9 window entries imports HtmlLang, so installing the
// `window.nativeBridge` → Tauri polyfill here (a module-load side-effect, before
// any view renders) guarantees the IPC seam exists in EVERY window — not just
// the main window (which also installs it via IpcProvider). Install is
// idempotent, so the double-install from main is harmless.
installNativeBridge();

// Same single-mount trick for app-wide auto-hiding scrollbars: every window
// gets the "reveal the native bar only while scrolling" listener. Idempotent.
installScrollbarAutoHide();
installTouchRubberBand();

// STT catalog consumers can be imported before a window's bridge-install side
// effect runs. Retry the catalog bootstrap here after the bridge exists so the
// first visible model chip can resolve its author logo before any picker opens.
initCatalogStore();

/** Keeps the <html lang="…"> attribute in sync with the selected locale. */
export function HtmlLang() {
	const locale = useLocaleStore((s) => s.locale);

	useEffect(() => {
		document.documentElement.lang = locale;
	}, [locale]);

	return null;
}
