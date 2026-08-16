import { describe, expect, test } from "bun:test";
import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import { NATIVE_EVENTS } from "@/shared/api/native-events";
import { LiveDebugLogViewer } from "./LiveDebugLogViewer";

interface TauriInternals {
	invoke: (cmd: string, args?: unknown, options?: unknown) => Promise<unknown>;
	transformCallback: (
		cb?: (payload: unknown) => void,
		once?: boolean,
	) => number;
}

interface InvokeCall {
	args: unknown;
	cmd: string;
}

interface LogLinePayload {
	level: string;
	message: string;
	target: string;
	timestampMs: number;
}

/** Mirrors the component's own module constants — the cap and the batch window
 *  are not injectable, so the suite has to know them. */
const MAX_LINES = 1000;
const FLUSH_DELAY_MS = 250;

/** U+00B7, the separator inside `liveLogsStatus*`. Spelled as an escape so the
 *  expectations survive any re-encoding of this file. */
const DOT = "\u00b7";

/**
 * The viewer talks to the backend through the generated `commands.*` bindings
 * (`diag_set_log_streaming`, `diag_open_logs_folder`, `diag_save_bundle`), which
 * invoke Tauri directly instead of going through `window.nativeBridge` — so the
 * fake sits on `__TAURI_INTERNALS__`, the same seam `AboutSettingsPanel.test`
 * uses. The restore matters: the happy-dom window is shared by every test file.
 */
function installInvoke(handler: (cmd: string, args?: unknown) => unknown): {
	calls: InvokeCall[];
	restore: () => void;
} {
	const tauriWindow = window as unknown as Window & {
		__TAURI_INTERNALS__: TauriInternals;
	};
	const previous = tauriWindow.__TAURI_INTERNALS__.invoke;
	const calls: InvokeCall[] = [];
	tauriWindow.__TAURI_INTERNALS__.invoke = async (cmd, args) => {
		calls.push({ args, cmd });
		return handler(cmd, args);
	};
	return {
		calls,
		restore: () => {
			tauriWindow.__TAURI_INTERNALS__.invoke = previous;
		},
	};
}

/**
 * `native-boundary.on()` prefers `window.nativeBridge.on` over the real Tauri
 * listener, which gives the suite a synchronous, fully controlled emitter for
 * `diagnostics:log-line` — no timers and no listener-registration race.
 */
function installLogLineEmitter(): {
	emit: (payload: LogLinePayload) => void;
	restore: () => void;
} {
	const previous = window.nativeBridge;
	const listeners = new Set<(...args: unknown[]) => void>();
	window.nativeBridge = {
		...previous,
		on: (channel, callback) => {
			if (channel !== NATIVE_EVENTS.DIAGNOSTICS_LOG_LINE) {
				return previous.on(channel, callback);
			}
			listeners.add(callback);
			return () => {
				listeners.delete(callback);
			};
		},
	};
	return {
		emit: (payload) => {
			for (const listener of [...listeners]) {
				listener(payload);
			}
		},
		restore: () => {
			window.nativeBridge = previous;
		},
	};
}

function installClipboard(): { restore: () => void; writes: string[] } {
	const writes: string[] = [];
	const navigatorObject = globalThis.navigator as unknown as object;
	const previous = Object.getOwnPropertyDescriptor(
		navigatorObject,
		"clipboard",
	);
	Object.defineProperty(navigatorObject, "clipboard", {
		configurable: true,
		value: {
			writeText: (text: string) => {
				writes.push(text);
				return Promise.resolve();
			},
		},
	});
	return {
		restore: () => {
			if (previous) {
				Object.defineProperty(navigatorObject, "clipboard", previous);
			} else {
				Reflect.deleteProperty(navigatorObject, "clipboard");
			}
		},
		writes,
	};
}

/** Streaming toggles resolve the enabled flag back, which is what the component
 *  treats as "the backend agreed". */
function streamingHandler(cmd: string, args?: unknown): unknown {
	if (cmd === "diag_set_log_streaming") {
		return (args as { enabled: boolean }).enabled;
	}
	return undefined;
}

function logLine(message: string, level = "info"): LogLinePayload {
	return { level, message, target: "winstt::test", timestampMs: 0 };
}

function renderViewer() {
	return render(
		<IntlProvider>
			<LiveDebugLogViewer />
		</IntlProvider>,
	);
}

function toolbarButton(name: string): HTMLElement {
	return screen.getByRole("button", { name });
}

function logRegion(): HTMLElement {
	return screen.getByRole("log", { name: "Live debug log output" });
}

/** Click a control and let the component's awaited backend round-trip settle. */
async function click(name: string): Promise<void> {
	await act(async () => {
		fireEvent.click(toolbarButton(name));
		await Promise.resolve();
		await Promise.resolve();
	});
}

/**
 * Let the pending-line batch land. The component's flush timer is armed BEFORE
 * this one and fires after FLUSH_DELAY_MS, so a single slightly longer wait is
 * deterministic — no polling, and no reliance on how many lines are queued.
 */
async function flushBatch(): Promise<void> {
	await act(async () => {
		await new Promise((resolve) => {
			setTimeout(resolve, FLUSH_DELAY_MS + 60);
		});
	});
}

function streamingToggles(calls: InvokeCall[]): boolean[] {
	return calls
		.filter((call) => call.cmd === "diag_set_log_streaming")
		.map((call) => (call.args as { enabled: boolean }).enabled);
}

describe("LiveDebugLogViewer", () => {
	test("exposes one toolbar holding stream, buffer and file actions", async () => {
		const { restore } = installInvoke(streamingHandler);
		try {
			renderViewer();

			const toolbar = screen.getByRole("toolbar", { name: "Log actions" });
			expect(
				toolbar.querySelector('[data-slot="log-toolbar-separator"]'),
			).not.toBeNull();
			expect(
				Array.from(toolbar.querySelectorAll("button")).map(
					(button) => button.textContent,
				),
			).toEqual(["Start", "Copy", "Clear", "Open folder", "Save Bundle"]);
			await waitFor(() => {
				expect(screen.getByText(`Off ${DOT} 0 lines`)).toBeDefined();
			});
		} finally {
			restore();
		}
	});

	test("Start enables backend streaming and reports the live status", async () => {
		const { calls, restore } = installInvoke(streamingHandler);
		try {
			renderViewer();

			await click("Start");

			expect(streamingToggles(calls)).toEqual([true]);
			expect(screen.getByText(`Live ${DOT} 0 lines`)).toBeDefined();
			// Start is replaced by the pause/stop pair once the stream is live.
			expect(screen.queryByRole("button", { name: "Start" })).toBeNull();
			expect(toolbarButton("Pause")).toBeDefined();
			expect(toolbarButton("Stop")).toBeDefined();
		} finally {
			restore();
		}
	});

	test("Pause and Resume toggle the backend gate and the status label", async () => {
		const { calls, restore } = installInvoke(streamingHandler);
		try {
			renderViewer();

			await click("Start");
			await click("Pause");

			expect(streamingToggles(calls)).toEqual([true, false]);
			expect(screen.getByText(`Paused ${DOT} 0 lines`)).toBeDefined();
			expect(toolbarButton("Resume")).toBeDefined();

			await click("Resume");

			expect(streamingToggles(calls)).toEqual([true, false, true]);
			expect(screen.getByText(`Live ${DOT} 0 lines`)).toBeDefined();
			expect(toolbarButton("Pause")).toBeDefined();
		} finally {
			restore();
		}
	});

	test("Stop disables streaming and returns the toolbar to Start", async () => {
		const { calls, restore } = installInvoke(streamingHandler);
		try {
			renderViewer();

			await click("Start");
			await click("Stop");

			expect(streamingToggles(calls)).toEqual([true, false]);
			expect(screen.getByText(`Off ${DOT} 0 lines`)).toBeDefined();
			expect(toolbarButton("Start")).toBeDefined();
			expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
		} finally {
			restore();
		}
	});

	test("renders incoming diagnostics:log-line events into the log region", async () => {
		const { restore } = installInvoke(streamingHandler);
		const emitter = installLogLineEmitter();
		try {
			renderViewer();
			await click("Start");

			expect(logRegion().textContent).toContain(
				"Start streaming to see new diagnostic lines.",
			);

			act(() => {
				emitter.emit(logLine("first captured line"));
				emitter.emit(logLine("second captured line", "warn"));
			});
			await flushBatch();

			const region = logRegion();
			expect(region.textContent).toContain("first captured line");
			expect(region.textContent).toContain("second captured line");
			expect(region.textContent).toContain("[winstt::test]");
			expect(screen.getByText(`Live ${DOT} 2 lines`)).toBeDefined();
		} finally {
			emitter.restore();
			restore();
		}
	});

	test("caps the rendered buffer at MAX_LINES across batches", async () => {
		const { restore } = installInvoke(streamingHandler);
		const emitter = installLogLineEmitter();
		try {
			renderViewer();
			await click("Start");

			// Fill the buffer exactly to the cap first, so the NEXT batch is what
			// forces the eviction (this is the `appendCapped` path).
			act(() => {
				emitter.emit(logLine("OLDEST-LINE"));
				for (let index = 0; index < MAX_LINES - 1; index += 1) {
					emitter.emit(logLine(`filler-${index}`));
				}
			});
			await flushBatch();
			expect(logRegion().querySelectorAll(":scope > div")).toHaveLength(
				MAX_LINES,
			);
			expect(logRegion().textContent).toContain("OLDEST-LINE");

			act(() => {
				emitter.emit(logLine("NEWEST-LINE"));
			});
			await flushBatch();

			const region = logRegion();
			expect(region.querySelectorAll(":scope > div")).toHaveLength(MAX_LINES);
			expect(region.textContent).toContain("NEWEST-LINE");
			expect(region.textContent).not.toContain("OLDEST-LINE");
		} finally {
			emitter.restore();
			restore();
		}
	});

	test("caps a single oversized batch at MAX_LINES", async () => {
		const { restore } = installInvoke(streamingHandler);
		const emitter = installLogLineEmitter();
		try {
			renderViewer();
			await click("Start");

			// One burst larger than the cap: the pending queue trims itself before
			// it is ever committed, so the surplus never reaches the DOM.
			act(() => {
				emitter.emit(logLine("OLDEST-LINE"));
				for (let index = 0; index < MAX_LINES - 1; index += 1) {
					emitter.emit(logLine(`filler-${index}`));
				}
				emitter.emit(logLine("NEWEST-LINE"));
			});
			await flushBatch();

			const region = logRegion();
			expect(region.querySelectorAll(":scope > div")).toHaveLength(MAX_LINES);
			expect(region.textContent).toContain("NEWEST-LINE");
			expect(region.textContent).not.toContain("OLDEST-LINE");
		} finally {
			emitter.restore();
			restore();
		}
	});

	test("Copy is inert until there are lines, then writes them to the clipboard", async () => {
		const { restore } = installInvoke(streamingHandler);
		const emitter = installLogLineEmitter();
		const clipboard = installClipboard();
		try {
			renderViewer();
			await click("Start");

			expect((toolbarButton("Copy") as HTMLButtonElement).disabled).toBe(true);
			fireEvent.click(toolbarButton("Copy"));
			expect(clipboard.writes).toHaveLength(0);

			act(() => {
				emitter.emit(logLine("copy me", "error"));
			});
			await flushBatch();

			expect((toolbarButton("Copy") as HTMLButtonElement).disabled).toBe(false);
			await act(async () => {
				fireEvent.click(toolbarButton("Copy"));
				await Promise.resolve();
			});

			expect(clipboard.writes).toHaveLength(1);
			expect(clipboard.writes[0]).toContain("ERROR [winstt::test] copy me");
			expect(toolbarButton("Copied")).toBeDefined();
		} finally {
			clipboard.restore();
			emitter.restore();
			restore();
		}
	});

	test("Clear empties the output and then disables itself", async () => {
		const { restore } = installInvoke(streamingHandler);
		const emitter = installLogLineEmitter();
		try {
			renderViewer();
			await click("Start");

			act(() => {
				emitter.emit(logLine("about to be cleared"));
			});
			await flushBatch();
			expect(logRegion().textContent).toContain("about to be cleared");

			await act(async () => {
				fireEvent.click(toolbarButton("Clear"));
			});

			const region = logRegion();
			expect(region.textContent).not.toContain("about to be cleared");
			expect(region.textContent).toContain(
				"Start streaming to see new diagnostic lines.",
			);
			expect((toolbarButton("Clear") as HTMLButtonElement).disabled).toBe(true);
			expect(screen.getByText(`Live ${DOT} 0 lines`)).toBeDefined();
		} finally {
			emitter.restore();
			restore();
		}
	});

	test("Open folder and Save Bundle each invoke their own command", async () => {
		const { calls, restore } = installInvoke((cmd) => {
			if (cmd === "diag_open_logs_folder") {
				return { ok: true, path: "C:\\logs" };
			}
			if (cmd === "diag_save_bundle") {
				return { ok: true, path: "C:\\winstt-diag.zip" };
			}
			return streamingHandler(cmd);
		});
		try {
			renderViewer();

			await click("Open folder");
			expect(calls.some((call) => call.cmd === "diag_open_logs_folder")).toBe(
				true,
			);
			expect(calls.some((call) => call.cmd === "diag_save_bundle")).toBe(false);

			await click("Save Bundle");
			expect(calls.some((call) => call.cmd === "diag_save_bundle")).toBe(true);

			await waitFor(() => {
				expect(screen.queryByRole("alert")).toBeNull();
			});
		} finally {
			restore();
		}
	});

	test("a cancelled save-bundle dialog is not an error", async () => {
		const { restore } = installInvoke((cmd) => {
			if (cmd === "diag_save_bundle") {
				// The user dismissed the OS save dialog: ok:false, but cancelled.
				return { cancelled: true, ok: false };
			}
			return streamingHandler(cmd);
		});
		try {
			renderViewer();

			await click("Save Bundle");
			await waitFor(() => {
				expect(
					(toolbarButton("Save Bundle") as HTMLButtonElement).disabled,
				).toBe(false);
			});

			expect(screen.queryByRole("alert")).toBeNull();
		} finally {
			restore();
		}
	});

	test("a failed file action surfaces an accessible alert", async () => {
		const { restore } = installInvoke((cmd) => {
			if (cmd === "diag_open_logs_folder") {
				return { error: "log directory is unreachable", ok: false };
			}
			return streamingHandler(cmd);
		});
		try {
			renderViewer();

			await click("Open folder");

			const alert = await screen.findByRole("alert");
			expect(alert.textContent).toBe("log directory is unreachable");
			// The failing button frees itself again; its sibling was never blocked.
			expect((toolbarButton("Open folder") as HTMLButtonElement).disabled).toBe(
				false,
			);
			expect((toolbarButton("Save Bundle") as HTMLButtonElement).disabled).toBe(
				false,
			);
		} finally {
			restore();
		}
	});

	test("unmounting while live disables backend streaming", async () => {
		const { calls, restore } = installInvoke(streamingHandler);
		try {
			const view = renderViewer();
			await click("Start");
			expect(streamingToggles(calls)).toEqual([true]);

			await act(async () => {
				view.unmount();
				await Promise.resolve();
			});

			expect(streamingToggles(calls)).toEqual([true, false]);
		} finally {
			restore();
		}
	});

	test("unmounting while stopped does not touch the backend gate again", async () => {
		const { calls, restore } = installInvoke(streamingHandler);
		try {
			const view = renderViewer();
			await click("Start");
			await click("Stop");
			expect(streamingToggles(calls)).toEqual([true, false]);

			await act(async () => {
				view.unmount();
				await Promise.resolve();
			});

			expect(streamingToggles(calls)).toEqual([true, false]);
		} finally {
			restore();
		}
	});
});
