// ── Plugin / window-op dispatch ───────────────────────────────────────────────
// Plugin targets are handled by a small dispatch (callPlugin) so we don't
// statically import every plugin at module top (keeps the cold path lean). Window
// ops drive the current Tauri window. Both are dynamic-import based.
//
// Extracted from native-bridge-adapter.ts (behavior-preserving move). The thin
// route table re-uses `callPlugin` / `windowOp` and the `PluginTarget` / `WindowOp`
// unions in its `Route` discriminated union.

import { commands } from "@/bindings";
import {
	checkAndDownloadUpdate,
	installPendingUpdateAndRelaunch,
} from "./updater";

// Exhaustiveness guard for discriminated-union switches. Reaching it is a
// COMPILE error (`x: never`) when every case is handled — so adding a new
// `WindowOp` / `PluginTarget` member without a matching case fails to build
// instead of silently falling through to a `return undefined`.
function assertNever(x: never): never {
	throw new Error(`unhandled: ${JSON.stringify(x)}`);
}

export type WindowOp =
	| "minimize"
	| "maximize"
	| "close"
	| "hide"
	| "show"
	| "quit"
	| "ignore-mouse";

// Plugin targets are handled by a small dispatch (see callPlugin) so we don't
// statically import every plugin at module top (keeps the cold path lean).
export type PluginTarget =
	| "dialog:open"
	| "clipboard:operate"
	| "os:locale"
	| "opener:logs"
	| "opener:custom-models"
	| "updater:status-history"
	| "updater:clear-status-history"
	| "updater:check-now"
	| "updater:quit-and-install"
	| "autostart:set"
	| "autostart:get";

export async function callPlugin(
	target: PluginTarget,
	args: unknown,
): Promise<unknown> {
	switch (target) {
		case "dialog:open": {
			const { open } = await import("@tauri-apps/plugin-dialog");
			const a = (args ?? {}) as {
				filters?: Array<{ name: string; extensions: string[] }>;
				title?: string;
			};
			return open({
				multiple: false,
				...(a.filters ? { filters: a.filters } : {}),
				...(a.title ? { title: a.title } : {}),
			});
		}
		case "clipboard:operate": {
			const cm = await import("@tauri-apps/plugin-clipboard-manager");
			const op = (args ?? {}) as { operation: string; text?: string };
			if (op.operation === "readText") {
				return { operation: "readText", text: await cm.readText() };
			}
			if (op.operation === "writeText") {
				await cm.writeText(op.text ?? "");
				return { operation: "writeText" };
			}
			// "clear" — Tauri has no clear(); writing an empty string is equivalent.
			await cm.writeText("");
			return { operation: "clear" };
		}
		case "os:locale": {
			const os = await import("@tauri-apps/plugin-os");
			return (await os.locale()) ?? "";
		}
		case "opener:logs": {
			try {
				return await commands.diagOpenLogsFolder();
			} catch (e) {
				return { ok: false, error: String(e) };
			}
		}
		case "opener:custom-models": {
			const opener = await import("@tauri-apps/plugin-opener");
			// The backend owns the real folder path; for the polyfill we route to a
			// command if present, else fall back to a best-effort no-op success.
			try {
				const res = await commands.openCustomModelsFolder();
				if (res.status === "error") {
					return { ok: false, error: res.error };
				}
				const path = res.data;
				if (typeof path === "string" && path.length > 0) {
					await opener.openPath(path);
				}
				return { ok: true, path };
			} catch (e) {
				return { ok: false, error: String(e) };
			}
		}
		case "updater:status-history":
			return commands.winsttUpdaterGetStatusHistory();
		case "updater:clear-status-history":
			return commands.winsttUpdaterClearStatusHistory();
		case "updater:check-now":
			return checkAndDownloadUpdate(
				(args as { includePrereleaseUpdates?: boolean } | undefined)
					?.includePrereleaseUpdates,
			);
		case "updater:quit-and-install":
			return installPendingUpdateAndRelaunch();
		case "autostart:set": {
			const as = await import("@tauri-apps/plugin-autostart");
			const enabled = (args as { enabled?: boolean })?.enabled ?? false;
			let current = false;
			let readFailed = false;
			try {
				current = await as.isEnabled();
			} catch (e) {
				// A failed read must not mask a skipped write: log it, and when the
				// caller wants autostart ON, still attempt enable() below rather than
				// no-op on an unknown current state.
				readFailed = true;
				console.error("[autostart] isEnabled() read failed:", e);
				if (!enabled) {
					return;
				}
			}
			if (enabled && (readFailed || !current)) {
				await as.enable();
			} else if (!enabled && current) {
				await as.disable();
			}
			return;
		}
		case "autostart:get": {
			const as = await import("@tauri-apps/plugin-autostart");
			return as.isEnabled();
		}
		default:
			return assertNever(target);
	}
}

// ── Window ops ───────────────────────────────────────────────────────────────
export async function windowOp(op: WindowOp, args: unknown[]): Promise<void> {
	const { getCurrentWindow } = await import("@tauri-apps/api/window");
	const win = getCurrentWindow();
	switch (op) {
		case "minimize":
			await win.minimize();
			return;
		case "maximize":
			await win.toggleMaximize();
			return;
		case "hide":
			await win.hide();
			return;
		case "show":
			await win.show();
			return;
		case "close":
			await win.close();
			return;
		case "quit": {
			await commands.quitApp();
			return;
		}
		case "ignore-mouse": {
			const ignore = (args[0] as { ignore?: boolean })?.ignore ?? false;
			await win.setIgnoreCursorEvents(ignore);
			return;
		}
		default:
			assertNever(op);
	}
}
