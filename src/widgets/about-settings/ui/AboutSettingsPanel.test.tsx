import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
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
	test("auto-checks updates once when the About tab has no updater history", async () => {
		const nativeInvokeCalls: Array<{ args: unknown[]; channel: string }> = [];
		const secureInvokeCalls: Array<{ channel: string; payload: unknown }> = [];
		const tauriWindow = window as unknown as Window & {
			__TAURI_INTERNALS__: TauriInternals;
		};
		const previousNativeBridge = window.nativeBridge;
		const previousTauriInvoke = tauriWindow.__TAURI_INTERNALS__.invoke;

		window.nativeBridge = {
			...previousNativeBridge,
			invoke: async (channel: string, ...args: unknown[]) => {
				nativeInvokeCalls.push({ channel, args });
				if (channel === IPC.UPDATER_CHECK_NOW) {
					return { triggered: false };
				}
				return;
			},
			secureInvoke: async (channel: string, payload?: unknown) => {
				secureInvokeCalls.push({ channel, payload });
				if (channel === IPC.UPDATER_GET_STATUS_HISTORY) {
					return [];
				}
				return;
			},
		};
		tauriWindow.__TAURI_INTERNALS__.invoke = async (cmd) => {
			if (cmd === "about_get_app_info") {
				return { version: "1.2.3", copyright: "Copyright WinSTT" };
			}
			return;
		};

		try {
			render(
				<IntlProvider>
					<AboutSettingsPanel />
				</IntlProvider>,
			);

			const updateToolbar = await screen.findByRole("toolbar", {
				name: "Updates",
			});
			expect(updateToolbar.textContent).toContain("Version");
			await waitFor(() => {
				expect(updateToolbar.textContent).toContain("1.2.3");
			});
			expect(
				within(updateToolbar).getByRole("button", { name: "Check now" }),
			).toBeDefined();
			expect(within(updateToolbar).getAllByRole("button")).toHaveLength(1);

			await waitFor(() => {
				expect(
					secureInvokeCalls.filter(
						(call) => call.channel === IPC.UPDATER_GET_STATUS_HISTORY,
					),
				).toHaveLength(1);
				expect(
					nativeInvokeCalls.filter(
						(call) => call.channel === IPC.UPDATER_CHECK_NOW,
					),
				).toHaveLength(1);
			});
			await act(async () => {
				await Promise.resolve();
				await Promise.resolve();
			});
			expect(
				nativeInvokeCalls.filter(
					(call) => call.channel === IPC.UPDATER_CHECK_NOW,
				),
			).toHaveLength(1);

			const startupHeading = screen.getByText("Startup");
			const diagnosticsHeading = screen.getByText("Diagnostics");
			expect(
				Boolean(
					startupHeading.compareDocumentPosition(diagnosticsHeading) &
					Node.DOCUMENT_POSITION_FOLLOWING,
				),
			).toBe(true);
		} finally {
			window.nativeBridge = previousNativeBridge;
			tauriWindow.__TAURI_INTERNALS__.invoke = previousTauriInvoke;
		}
	});

	test("renders the latest-version status beside a single refresh button", async () => {
		const nativeInvokeCalls: Array<{ args: unknown[]; channel: string }> = [];
		const tauriWindow = window as unknown as Window & {
			__TAURI_INTERNALS__: TauriInternals;
		};
		const previousNativeBridge = window.nativeBridge;
		const previousTauriInvoke = tauriWindow.__TAURI_INTERNALS__.invoke;

		window.nativeBridge = {
			...previousNativeBridge,
			invoke: async (channel: string, ...args: unknown[]) => {
				nativeInvokeCalls.push({ channel, args });
				return;
			},
			secureInvoke: async (channel: string) => {
				if (channel === IPC.UPDATER_GET_STATUS_HISTORY) {
					return [{ status: "not-available", timestamp: 1 }];
				}
				return;
			},
		};
		tauriWindow.__TAURI_INTERNALS__.invoke = async (cmd) => {
			if (cmd === "about_get_app_info") {
				return { version: "1.2.3", copyright: "Copyright WinSTT" };
			}
			return;
		};

		try {
			render(
				<IntlProvider>
					<AboutSettingsPanel />
				</IntlProvider>,
			);

			const updateToolbar = await screen.findByRole("toolbar", {
				name: "Updates",
			});
			// The up-to-date status now reads as plain text; the only control is a
			// single refresh icon-button labelled "Check now".
			await waitFor(() => {
				expect(updateToolbar.textContent).toContain(
					"You're on the latest version.",
				);
			});
			expect(
				within(updateToolbar).getByRole("button", { name: "Check now" }),
			).toBeDefined();
			expect(within(updateToolbar).getAllByRole("button")).toHaveLength(1);
			expect(
				nativeInvokeCalls.filter(
					(call) => call.channel === IPC.UPDATER_CHECK_NOW,
				),
			).toHaveLength(0);
		} finally {
			window.nativeBridge = previousNativeBridge;
			tauriWindow.__TAURI_INTERNALS__.invoke = previousTauriInvoke;
		}
	});

	test("runs the open-logs action from the About tab", async () => {
		const nativeInvokeCalls: Array<{ args: unknown[]; channel: string }> = [];
		const tauriWindow = window as unknown as Window & {
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
				return;
			},
		};
		tauriWindow.__TAURI_INTERNALS__.invoke = async (cmd) => {
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
			expect(
				nativeInvokeCalls.some(
					(call) => call.channel === IPC.DIAG_OPEN_LOGS_FOLDER,
				),
			).toBe(true);
		} finally {
			window.nativeBridge = previousNativeBridge;
			tauriWindow.__TAURI_INTERNALS__.invoke = previousTauriInvoke;
		}
	});

	test("renders settings import and export actions in the About tab", async () => {
		const tauriWindow = window as unknown as Window & {
			__TAURI_INTERNALS__: TauriInternals;
		};
		const previousNativeBridge = window.nativeBridge;
		const previousTauriInvoke = tauriWindow.__TAURI_INTERNALS__.invoke;

		window.nativeBridge = {
			...previousNativeBridge,
			invoke: async () => undefined,
			secureInvoke: async (channel: string) => {
				if (channel === IPC.UPDATER_GET_STATUS_HISTORY) {
					return [{ status: "not-available", timestamp: 1 }];
				}
				return;
			},
		};
		tauriWindow.__TAURI_INTERNALS__.invoke = async (cmd) => {
			if (cmd === "about_get_app_info") {
				return { version: "1.2.3", copyright: "Copyright WinSTT" };
			}
			return;
		};

		try {
			render(
				<IntlProvider>
					<AboutSettingsPanel />
				</IntlProvider>,
			);

			expect(
				await screen.findByRole("button", { name: "Export settings" }),
			).toBeDefined();
			expect(
				screen.getByRole("button", { name: "Import settings" }),
			).toBeDefined();
		} finally {
			window.nativeBridge = previousNativeBridge;
			tauriWindow.__TAURI_INTERNALS__.invoke = previousTauriInvoke;
		}
	});
});
