import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test } from "bun:test";
import { IntlProvider } from "@/app/providers/IntlProvider";
import { IPC } from "@/shared/api/ipc-channels";
import { AboutSettingsPanel } from "./AboutSettingsPanel";

interface TauriInternals {
	invoke: (cmd: string, args?: unknown, options?: unknown) => Promise<unknown>;
	transformCallback: (
		cb?: (payload: unknown) => void,
		once?: boolean,
	) => number;
}

describe("AboutSettingsPanel", () => {
	test("runs diagnostics actions from the About tab", async () => {
		const nativeInvokeCalls: Array<{ args: unknown[]; channel: string }> = [];
		const tauriInvokeCalls: Array<{ args?: unknown; cmd: string }> = [];
		const tauriWindow = window as Window & {
			__TAURI_INTERNALS__: TauriInternals;
		};
		const previousNativeBridge = window.nativeBridge;
		const previousTauriInvoke = tauriWindow.__TAURI_INTERNALS__.invoke;

		window.nativeBridge = {
			...previousNativeBridge,
			invoke: async (channel: string, ...args: unknown[]) => {
				nativeInvokeCalls.push({ channel, args });
				if (channel === IPC.DIAG_OPEN_LOGS_FOLDER) {
					return { ok: true, path: "C:\\logs" };
				}
				if (channel === IPC.DIAG_SAVE_BUNDLE) {
					return { ok: true, path: "C:\\winstt-diag.zip" };
				}
				return;
			},
		};
		tauriWindow.__TAURI_INTERNALS__.invoke = async (cmd, args) => {
			tauriInvokeCalls.push({ cmd, args });
			if (cmd === "about_get_app_info") {
				return { version: "1.2.3", copyright: "Copyright WinSTT" };
			}
			if (cmd === "diag_save_bundle") {
				return { ok: true, path: "C:\\winstt-diag.zip" };
			}
			return;
		};

		try {
			render(
				<IntlProvider>
					<AboutSettingsPanel />
				</IntlProvider>,
			);

			await act(async () => {
				fireEvent.click(
					screen.getByRole("button", { name: "Open Logs Folder" }),
				);
				await Promise.resolve();
			});
			await act(async () => {
				fireEvent.click(
					screen.getByRole("button", { name: /Save Diagnostic Bundle/ }),
				);
				await Promise.resolve();
			});

			expect(
				nativeInvokeCalls.some(
					(call) => call.channel === IPC.DIAG_OPEN_LOGS_FOLDER,
				),
			).toBe(true);
			expect(
				tauriInvokeCalls.some((call) => call.cmd === "diag_save_bundle") ||
					nativeInvokeCalls.some(
						(call) => call.channel === IPC.DIAG_SAVE_BUNDLE,
					),
			).toBe(true);
		} finally {
			window.nativeBridge = previousNativeBridge;
			tauriWindow.__TAURI_INTERNALS__.invoke = previousTauriInvoke;
		}
	});
});
