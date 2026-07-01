/**
 * True when the renderer is running inside a real Tauri webview (the
 * `__TAURI_INTERNALS__` global is injected by the runtime). Used to gate the
 * native-bridge install, the dev settings-bridge fallback, and webview→backend
 * diagnostic forwarding so they no-op cleanly under plain Vite / happy-dom.
 */
export function hasTauriRuntime(): boolean {
	if (typeof window === "undefined") {
		return false;
	}
	const maybeWindow = window as Window & {
		__TAURI_INTERNALS__?: unknown;
	};
	return maybeWindow.__TAURI_INTERNALS__ != null;
}
