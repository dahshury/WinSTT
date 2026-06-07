/**
 * Webview -> backend diagnostic bridge. Secondary windows have separate webviews,
 * so their console errors do not naturally reach Rust logs. This mirrors errors
 * through the app IPC diagnostics channel.
 */
import { webviewDiagLog } from "@/shared/api/ipc-client";

function report(
	label: string,
	level: "info" | "warn" | "error",
	message: string,
): void {
	webviewDiagLog(label, level, message);
}

/** One-line lifecycle marker, e.g. "entry start" or "react mounted". */
export function diagBeacon(label: string, message: string): void {
	report(label, "info", message);
}

/**
 * Install global error forwarders for a window. Call once at the top of the
 * window entry, before other module work, so import/render failures are captured.
 */
export function installWebviewDiag(label: string): void {
	report(label, "info", "entry script start");

	window.addEventListener("error", (e) => {
		const where = e.filename ? ` @ ${e.filename}:${e.lineno}:${e.colno}` : "";
		report(label, "error", `onerror: ${e.message}${where}`);
	});

	window.addEventListener("unhandledrejection", (e) => {
		const reason = (e as PromiseRejectionEvent).reason;
		const text =
			reason instanceof Error
				? `${reason.message}\n${reason.stack ?? ""}`
				: String(reason);
		report(label, "error", `unhandledrejection: ${text}`);
	});

	const origError = console.error.bind(console);
	console.error = (...args: unknown[]) => {
		const text = args
			.map((a) =>
				a instanceof Error ? `${a.message}\n${a.stack ?? ""}` : String(a),
			)
			.join(" ");
		report(label, "error", `console.error: ${text}`);
		origError(...args);
	};
}
