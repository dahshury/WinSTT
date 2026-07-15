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
import { IPC } from "@test/mocks/legacy-ipc";
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
		const tauriCalls: string[] = [];
		const tauriWindow = window as unknown as Window & {
			__TAURI_INTERNALS__: TauriInternals;
		};
		const previousNativeBridge = window.nativeBridge;
		const previousTauriInvoke = tauriWindow.__TAURI_INTERNALS__.invoke;

		tauriWindow.__TAURI_INTERNALS__.invoke = async (cmd) => {
			tauriCalls.push(cmd);
			if (cmd === "about_get_app_info") {
				return { version: "1.2.3", copyright: "Copyright WinSTT" };
			}
			if (cmd === "winstt_updater_get_status_history") {
				return [];
			}
			if (cmd === "winstt_updater_check_and_download") {
				return { triggered: false };
			}
			return undefined;
		};
		window.nativeBridge = {
			...previousNativeBridge,
			invoke: async (channel) => {
				tauriCalls.push(channel);
				if (channel === IPC.UPDATER_CHECK_NOW) {
					return { triggered: false };
				}
				return undefined;
			},
			secureInvoke: async (channel) => {
				tauriCalls.push(channel);
				if (channel === IPC.UPDATER_GET_STATUS_HISTORY) {
					return [];
				}
				return undefined;
			},
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
					tauriCalls.filter(
						(command) =>
							command === "winstt_updater_get_status_history" ||
							command === IPC.UPDATER_GET_STATUS_HISTORY,
					),
				).toHaveLength(1);
				expect(
					tauriCalls.filter(
						(command) =>
							command === "winstt_updater_check_and_download" ||
							command === IPC.UPDATER_CHECK_NOW,
					),
				).toHaveLength(1);
			});
			await act(async () => {
				await Promise.resolve();
				await Promise.resolve();
			});
			expect(
				tauriCalls.filter(
					(command) =>
						command === "winstt_updater_check_and_download" ||
						command === IPC.UPDATER_CHECK_NOW,
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
		const tauriCalls: string[] = [];
		const tauriWindow = window as unknown as Window & {
			__TAURI_INTERNALS__: TauriInternals;
		};
		const previousNativeBridge = window.nativeBridge;
		const previousTauriInvoke = tauriWindow.__TAURI_INTERNALS__.invoke;

		tauriWindow.__TAURI_INTERNALS__.invoke = async (cmd) => {
			tauriCalls.push(cmd);
			if (cmd === "about_get_app_info") {
				return { version: "1.2.3", copyright: "Copyright WinSTT" };
			}
			if (cmd === "winstt_updater_get_status_history") {
				return [{ status: "not-available", timestamp: 1 }];
			}
			return undefined;
		};
		window.nativeBridge = {
			...previousNativeBridge,
			secureInvoke: async (channel) => {
				tauriCalls.push(channel);
				if (channel === IPC.UPDATER_GET_STATUS_HISTORY) {
					return [{ status: "not-available", timestamp: 1 }];
				}
				return undefined;
			},
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
				tauriCalls.filter(
					(command) => command === "winstt_updater_check_and_download",
				),
			).toHaveLength(0);
		} finally {
			window.nativeBridge = previousNativeBridge;
			tauriWindow.__TAURI_INTERNALS__.invoke = previousTauriInvoke;
		}
	});

	test("runs the open-logs action from the About tab", async () => {
		const tauriCalls: string[] = [];
		const tauriWindow = window as unknown as Window & {
			__TAURI_INTERNALS__: TauriInternals;
		};
		const previousNativeBridge = window.nativeBridge;
		const previousTauriInvoke = tauriWindow.__TAURI_INTERNALS__.invoke;

		tauriWindow.__TAURI_INTERNALS__.invoke = async (cmd) => {
			tauriCalls.push(cmd);
			if (cmd === "about_get_app_info") {
				return { version: "1.2.3", copyright: "Copyright WinSTT" };
			}
			if (cmd === "diag_open_logs_folder") {
				return { ok: true, path: "C:\\logs" };
			}
			if (cmd === "diag_save_bundle") {
				return { ok: true, path: "C:\\winstt-diag.zip" };
			}
			return undefined;
		};
		window.nativeBridge = {
			...previousNativeBridge,
			invoke: async (channel) => {
				tauriCalls.push(channel);
				if (channel === IPC.DIAG_OPEN_LOGS_FOLDER) {
					return { ok: true, path: "C:\\logs" };
				}
				return undefined;
			},
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
				tauriCalls.some(
					(command) =>
						command === "diag_open_logs_folder" ||
						command === IPC.DIAG_OPEN_LOGS_FOLDER,
				),
			).toBe(true);
		} finally {
			window.nativeBridge = previousNativeBridge;
			tauriWindow.__TAURI_INTERNALS__.invoke = previousTauriInvoke;
		}
	});

	test("collapses long operational issue details until the user expands them", async () => {
		const tauriWindow = window as unknown as Window & {
			__TAURI_INTERNALS__: TauriInternals;
		};
		const previousNativeBridge = window.nativeBridge;
		const previousTauriInvoke = tauriWindow.__TAURI_INTERNALS__.invoke;
		const longDetail = Array.from(
			{ length: 8 },
			(_, index) => `stack-frame-${index}`,
		).join("\n");

		window.nativeBridge = {
			...previousNativeBridge,
			invoke: async () => undefined,
			secureInvoke: async (channel: string) => {
				if (channel === IPC.UPDATER_GET_STATUS_HISTORY) {
					return [{ status: "not-available", timestamp: 1 }];
				}
				return undefined;
			},
		};
		tauriWindow.__TAURI_INTERNALS__.invoke = async (cmd) => {
			if (cmd === "about_get_app_info") {
				return { version: "1.2.3", copyright: "Copyright WinSTT" };
			}
			if (cmd === "diag_observability_timeline") {
				return [
					{
						area: "renderer",
						context: {},
						detail: longDetail,
						id: 10,
						kind: "webview",
						operation: "error",
						severity: "error",
						summary: "Renderer reported a webview error",
						timestampMs: 10,
						userVisible: false,
					},
				];
			}
			return undefined;
		};

		try {
			render(
				<IntlProvider>
					<AboutSettingsPanel />
				</IntlProvider>,
			);

			await screen.findByText("Renderer reported a webview error");
			const issueActions = screen.getByRole("toolbar", {
				name: "Operational issue actions",
			});
			expect(
				issueActions.querySelector(
					'[data-slot="observability-action-separator"]',
				),
			).not.toBeNull();

			const detail = await screen.findByText(
				(_, node) => node?.textContent === longDetail,
			);
			expect(detail.getAttribute("class")).toContain("line-clamp-4");

			fireEvent.click(screen.getByRole("button", { name: "Show more" }));

			expect(detail.getAttribute("class")).not.toContain("line-clamp-4");
			expect(screen.getByRole("button", { name: "Show less" })).toBeDefined();
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
				return undefined;
			},
		};
		tauriWindow.__TAURI_INTERNALS__.invoke = async (cmd) => {
			if (cmd === "about_get_app_info") {
				return { version: "1.2.3", copyright: "Copyright WinSTT" };
			}
			return undefined;
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
