import { useEffect } from "react";
import { initializeNativeRuntime } from "@/shared/api/native-runtime";
import { useLocaleStore } from "@/shared/i18n/locale-store";
import { installScrollbarAutoHide } from "@/shared/lib/scrollbar-autohide";
import { hasTauriRuntime } from "@/shared/lib/tauri-runtime";
import { installTouchRubberBand } from "@/shared/lib/touch-rubber-band";

// Register shared native side effects before any window subtree mounts. Domain
// events subscribe directly through Tauri and no longer depend on a global
// bridge being installed first.
initializeNativeRuntime();

if (hasTauriRuntime()) {
	// The STT model-catalog bootstrap pulls a large data chunk and is NOT on the
	// load-time subscription path, so it stays lazy — skipped entirely in browser
	// preview and fetched + retried in a Tauri window.
	void import("@/entities/model-catalog").then(({ initCatalogStore }) => {
		initCatalogStore();
	});
}

// Shared window interaction shims are tiny and idempotent.
installScrollbarAutoHide();
installTouchRubberBand();

/** Keeps the <html lang="..."> attribute in sync with the selected locale. */
export function HtmlLang() {
	const locale = useLocaleStore((s) => s.locale);

	useEffect(() => {
		document.documentElement.lang = locale;
	}, [locale]);

	return null;
}
