/**
 * Webview → backend diagnostic bridge. Each secondary window is its own webview
 * whose `console` + uncaught errors never reach the Rust log, so a blank /
 * non-rendering window leaves no trace and is impossible to diagnose from the
 * outside. This installs `window.onerror` + `unhandledrejection` + a `console.error`
 * mirror that forward to the `winstt_diag` Tauri command (writes to handy.log), plus
 * `diagBeacon` for explicit lifecycle markers (entry start, React mounted). With this
 * in place, a crashing secondary-window renderer shows up as `[webview:<label>] …` in
 * the backend log. Diagnostic, but cheap + harmless to keep on.
 */
import { invoke } from "@tauri-apps/api/core";

function report(label: string, level: "info" | "warn" | "error", message: string): void {
	invoke("winstt_diag", { label, level, message }).catch(() => {
		// Swallow — if the bridge itself fails there's nowhere left to log.
	});
}

/** One-line lifecycle marker (e.g. "entry start", "react mounted"). */
export function diagBeacon(label: string, message: string): void {
	report(label, "info", message);
}

/**
 * Install the global error forwarders for a window. Call ONCE at the very top of
 * the window's entry, before any other module work, so a crash during import or
 * first render is captured.
 */
export function installWebviewDiag(label: string): void {
	report(label, "info", "entry script start");

	window.addEventListener("error", (e) => {
		const where = e.filename ? ` @ ${e.filename}:${e.lineno}:${e.colno}` : "";
		report(label, "error", `onerror: ${e.message}${where}`);
	});

	window.addEventListener("unhandledrejection", (e) => {
		const reason = (e as PromiseRejectionEvent).reason;
		const text = reason instanceof Error ? `${reason.message}\n${reason.stack ?? ""}` : String(reason);
		report(label, "error", `unhandledrejection: ${text}`);
	});

	const origError = console.error.bind(console);
	console.error = (...args: unknown[]) => {
		const text = args
			.map((a) => (a instanceof Error ? `${a.message}\n${a.stack ?? ""}` : String(a)))
			.join(" ");
		report(label, "error", `console.error: ${text}`);
		origError(...args);
	};
}
