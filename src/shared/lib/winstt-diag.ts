/**
 * Webview -> backend diagnostic bridge. Secondary windows have separate webviews,
 * so their console errors do not naturally reach Rust logs. This mirrors errors
 * through the app IPC diagnostics channel.
 */
import { webviewDiagLog } from "@/shared/api/ipc-client";

const BENIGN_ERROR_MESSAGES = new Set([
	"ResizeObserver loop completed with undelivered notifications.",
	"ResizeObserver loop limit exceeded",
]);

export function isBenignWebviewErrorMessage(message: string): boolean {
	const withoutPrefix = message.trim().startsWith("onerror: ")
		? message.trim().slice("onerror: ".length)
		: message.trim();
	const locationIndex = withoutPrefix.indexOf(" @ ");
	const bareMessage =
		locationIndex === -1 ? withoutPrefix : withoutPrefix.slice(0, locationIndex);
	return BENIGN_ERROR_MESSAGES.has(bareMessage);
}

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
		if (isBenignWebviewErrorMessage(e.message)) {
			e.preventDefault();
			return;
		}
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
