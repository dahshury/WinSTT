import { useEffect } from "react";
import { installNativeBridge } from "@/shared/api/native-bridge-adapter";
import { useLocaleStore } from "@/shared/i18n/locale-store";
import { installScrollbarAutoHide } from "@/shared/lib/scrollbar-autohide";
import { hasTauriRuntime } from "@/shared/lib/tauri-runtime";
import { installTouchRubberBand } from "@/shared/lib/touch-rubber-band";

// Install the native bridge SYNCHRONOUSLY as a module-load side effect. This MUST
// stay synchronous (no top-level `await` / dynamic `import()` ahead of it): every
// window entry imports HtmlLang before the view subtree, so a synchronous install
// guarantees `window.nativeBridge` exists before any sibling module evaluates.
// Some stores register their main→renderer push listeners at MODULE-LOAD time
// (e.g. `llm-catalog-store`'s `onOllamaPullProgress`); an async install lets those
// modules evaluate first — while `window.nativeBridge` is still null — so their
// `on()` calls silently no-op. That was the bug behind "Ollama download stuck at
// 0% / the combobox never shows the downloading state". `installNativeBridge`
// self-guards on `hasTauriRuntime()`, so this is a clean no-op in browser preview.
installNativeBridge();

if (hasTauriRuntime()) {
	// The STT model-catalog bootstrap pulls a large data chunk and is NOT on the
	// load-time subscription path, so it stays lazy — skipped entirely in browser
	// preview, fetched + retried after the (already-installed) bridge in a Tauri
	// window. Keep `initCatalogStore();` after `installNativeBridge();` so the
	// catalog hydrate runs against a live bridge.
	void import("@/entities/model-catalog/model/catalog-store").then(
		({ initCatalogStore }) => {
			initCatalogStore();
		},
	);
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
