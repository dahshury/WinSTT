import { formatErrorForLog } from "./errors";

/**
 * Centralized "fire-and-forget" promise sink.
 *
 * Many IPC / side-effect calls are deliberately not awaited (e.g. kicking off a
 * model scan, telling the backend to pause a download). Their rejections must
 * not surface as unhandled-promise warnings, but silently swallowing them with
 * a bare `.catch(() => {})` at each call site means a failing IPC is completely
 * invisible during development.
 *
 * Routing those calls through `fireAndForget` keeps the production behavior
 * identical (the rejection is swallowed) while making every swallowed failure
 * observable in one place: in dev builds the error is logged with an optional
 * context label so the cause is discoverable.
 *
 * @param promise - The promise to detach from the current control flow.
 * @param context - Optional label identifying the call site in dev logs.
 */
export function fireAndForget(
	promise: Promise<unknown>,
	context?: string,
): void {
	void promise.catch((error: unknown) => {
		if (import.meta.env.DEV) {
			const prefix = context ? `fireAndForget(${context})` : "fireAndForget";
			console.warn(formatErrorForLog(error, prefix));
		}
	});
}
