import { beforeEach, describe, expect, test } from "bun:test";
import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import { commands } from "@/bindings";
import {
	DEFAULT_SETTINGS,
	useSettingsStore,
	useSettingsTabStore,
} from "@/entities/setting";
import { useSettingsHydrationStore } from "@/features/update-settings";
import { IPC } from "@/shared/api/ipc-channels";
import { SettingsPage } from "./SettingsPage";

function renderSettingsPage() {
	return render(
		<IntlProvider>
			<SettingsPage />
		</IntlProvider>,
	);
}

function settingsShell(): HTMLElement {
	const shell = document.querySelector<HTMLElement>(".settings-window-shell");
	if (!shell) {
		throw new Error("settings shell did not render");
	}
	return shell;
}

async function nextAnimationFrame(): Promise<void> {
	await act(async () => {
		await new Promise((resolve) => requestAnimationFrame(resolve));
	});
}

/** The enter replay is a double-rAF (commit closed start state, flush, open). */
async function settleOpenAnimation(): Promise<void> {
	await nextAnimationFrame();
	await nextAnimationFrame();
}

/** The initial reveal is gated on the lazy tab panel mounting, so the first
 *  open is only observable once the chunk resolves — poll for it. */
async function waitForOpen(): Promise<void> {
	await waitFor(() => {
		expect(settingsShell().className).toContain("is-open");
	});
}

type BridgeListener = (...args: unknown[]) => void;

/** Install a minimal nativeBridge stub that captures `on` subscriptions so a
 *  test can fire main→renderer events. With the bridge present, typed `send`
 *  reaches the `commands.*` bindings, so the two the page fires
 *  (settingsWindowReady on render, closeSelfWindow on close) are stubbed with
 *  counters — without a Tauri runtime they would reject. */
function installNativeBridgeStub(): {
	emit: (channel: string, ...args: unknown[]) => void;
	closeSelfCalls: () => number;
	restore: () => void;
} {
	const originalBridge = window.nativeBridge;
	const originalReady = commands.settingsWindowReady;
	const originalCloseSelf = commands.closeSelfWindow;
	let closeSelfCalls = 0;
	commands.settingsWindowReady = (async () => ({
		status: "ok",
		data: null,
	})) satisfies typeof commands.settingsWindowReady;
	commands.closeSelfWindow = (async () => {
		closeSelfCalls += 1;
		return { status: "ok", data: null };
	}) satisfies typeof commands.closeSelfWindow;
	const listeners = new Map<string, BridgeListener[]>();
	window.nativeBridge = {
		...originalBridge,
		getPathForFile: () => "",
		invoke: async () => undefined,
		on: (channel, cb) => {
			const list = listeners.get(channel) ?? [];
			list.push(cb);
			listeners.set(channel, list);
			return () => {
				listeners.set(
					channel,
					(listeners.get(channel) ?? []).filter((l) => l !== cb),
				);
			};
		},
		secureInvoke: async () => undefined,
		send: () => {
			/* no-op */
		},
	} satisfies typeof window.nativeBridge;
	return {
		emit: (channel, ...args) => {
			for (const cb of listeners.get(channel) ?? []) {
				cb(...args);
			}
		},
		closeSelfCalls: () => closeSelfCalls,
		restore: () => {
			window.nativeBridge = originalBridge;
			commands.settingsWindowReady = originalReady;
			commands.closeSelfWindow = originalCloseSelf;
		},
	};
}

describe("SettingsPage", () => {
	beforeEach(() => {
		useSettingsStore.setState({ settings: DEFAULT_SETTINGS, isLoaded: false });
		useSettingsHydrationStore.getState().reset();
		useSettingsTabStore.setState({ activeTab: "recording" });
	});

	test("renders without crashing", () => {
		const { container } = renderSettingsPage();
		expect(container).not.toBeNull();
	});

	test("keeps the settings shell visible while backend settings hydrate", () => {
		useSettingsHydrationStore.setState({ error: null, status: "loading" });

		renderSettingsPage();

		expect(screen.getByRole("tab", { name: /recording/i })).toBeDefined();
		expect(
			screen
				.getAllByRole("status")
				.some((status) => status.textContent?.includes("Loading")),
		).toBe(true);
		expect(screen.queryByText("Recording Mode")).toBeNull();
	});

	test("renders settings content when backend settings are unavailable in browser mode", async () => {
		useSettingsStore.setState({ settings: DEFAULT_SETTINGS, isLoaded: true });
		useSettingsHydrationStore.setState({ error: null, status: "unavailable" });

		renderSettingsPage();

		expect(await screen.findByText("Recording Mode")).toBeDefined();
	});

	test("renders settings transfer controls in the About tab", async () => {
		useSettingsStore.setState({ settings: DEFAULT_SETTINGS, isLoaded: true });
		useSettingsHydrationStore.setState({ error: null, status: "unavailable" });
		renderSettingsPage();

		expect(screen.queryByTestId("settings-export-button")).toBeNull();
		expect(screen.queryByTestId("settings-import-button")).toBeNull();
		fireEvent.click(screen.getByRole("tab", { name: /about/i }));

		expect(
			await screen.findByRole("button", { name: "Export settings" }),
		).toBeDefined();
		expect(
			await screen.findByRole("button", { name: "Import settings" }),
		).toBeDefined();
		expect(screen.queryByTestId("settings-update-button")).toBeNull();
	});

	test("requires confirmation before importing settings", async () => {
		useSettingsStore.setState({ settings: DEFAULT_SETTINGS, isLoaded: true });
		useSettingsHydrationStore.setState({ error: null, status: "unavailable" });
		renderSettingsPage();

		fireEvent.click(screen.getByRole("tab", { name: /about/i }));
		fireEvent.click(
			await screen.findByRole("button", { name: "Import settings" }),
		);

		expect(screen.getByText("Restore settings?")).toBeDefined();
		expect(screen.getByText("Restore")).toBeDefined();
	});

	test("surfaces backend hydration errors instead of mounting default-backed panels", () => {
		useSettingsHydrationStore.setState({
			error: "settings backend failed",
			status: "error",
		});

		renderSettingsPage();

		expect(screen.getByRole("alert").textContent).toContain(
			"settings backend failed",
		);
		expect(screen.queryByText("Recording Mode")).toBeNull();
	});

	test("replays the modal open animation after the kept-alive window closes", async () => {
		useSettingsStore.setState({ settings: DEFAULT_SETTINGS, isLoaded: true });
		useSettingsHydrationStore.setState({ error: null, status: "unavailable" });
		document.documentElement.style.setProperty("--modal-close-dur", "1ms");

		try {
			renderSettingsPage();
			await waitForOpen();

			expect(settingsShell().className).toContain("t-modal");
			expect(settingsShell().className).toContain("is-open");

			fireEvent.click(screen.getByRole("button", { name: "Close" }));

			expect(settingsShell().className).toContain("is-closing");

			await act(async () => {
				await new Promise((resolve) => setTimeout(resolve, 5));
			});

			expect(settingsShell().className).not.toContain("is-open");
			expect(settingsShell().className).not.toContain("is-closing");

			act(() => {
				window.dispatchEvent(new FocusEvent("focus"));
			});
			await settleOpenAnimation();

			expect(settingsShell().className).toContain("is-open");
		} finally {
			document.documentElement.style.removeProperty("--modal-close-dur");
		}
	});

	test("replays the enter animation on the backend shown event even when the renderer never saw the close", async () => {
		useSettingsStore.setState({ settings: DEFAULT_SETTINGS, isLoaded: true });
		useSettingsHydrationStore.setState({ error: null, status: "unavailable" });
		const bridge = installNativeBridgeStub();

		try {
			renderSettingsPage();
			await waitForOpen();
			expect(settingsShell().className).toContain("is-open");

			// Age the enter past the freshness window — this models a genuinely
			// STALE `is-open` (a native-only Alt+F4 close the renderer never saw,
			// reopened later), not an enter that just played at show time.
			await act(async () => {
				await new Promise((resolve) => setTimeout(resolve, 650));
			});

			// The backend shown event on the next open must snap back to the
			// start state...
			act(() => {
				bridge.emit(IPC.SETTINGS_WINDOW_SHOWN);
			});
			expect(settingsShell().className).not.toContain("is-open");

			// ...and then replay the enter transition.
			await settleOpenAnimation();
			expect(settingsShell().className).toContain("is-open");
		} finally {
			bridge.restore();
		}
	});

	test("does not double-play the enter animation when the shown event lands right after the enter started (first open)", async () => {
		useSettingsStore.setState({ settings: DEFAULT_SETTINGS, isLoaded: true });
		useSettingsHydrationStore.setState({ error: null, status: "unavailable" });
		const bridge = installNativeBridgeStub();

		try {
			renderSettingsPage();
			// The prewarm reveal's rAF chain just played (in the real app it thaws
			// exactly at show). The shown event arrives a few ms later — it must
			// YIELD to the in-flight/fresh enter instead of restarting it, or the
			// half-faded card snaps invisible and fades in again (the first-open
			// double-animation flicker).
			await waitForOpen();
			act(() => {
				bridge.emit(IPC.SETTINGS_WINDOW_SHOWN, false);
			});
			// No restart: the class never leaves "is-open", not even for a frame.
			expect(settingsShell().className).toContain("is-open");
			await settleOpenAnimation();
			expect(settingsShell().className).toContain("is-open");
		} finally {
			bridge.restore();
		}
	});

	test("does not restart the animation when open is re-invoked on an already-open window", async () => {
		useSettingsStore.setState({ settings: DEFAULT_SETTINGS, isLoaded: true });
		useSettingsHydrationStore.setState({ error: null, status: "unavailable" });
		const bridge = installNativeBridgeStub();

		try {
			renderSettingsPage();
			await waitForOpen();
			expect(settingsShell().className).toContain("is-open");

			// wasVisible=true + steady open (tray click while open) → no replay:
			// the class must never leave "is-open", not even for a frame.
			act(() => {
				bridge.emit(IPC.SETTINGS_WINDOW_SHOWN, true);
			});
			expect(settingsShell().className).toContain("is-open");
			await settleOpenAnimation();
			expect(settingsShell().className).toContain("is-open");
		} finally {
			bridge.restore();
		}
	});

	test("re-opening mid-close-fade cancels the pending hide and repairs to open", async () => {
		useSettingsStore.setState({ settings: DEFAULT_SETTINGS, isLoaded: true });
		useSettingsHydrationStore.setState({ error: null, status: "unavailable" });
		document.documentElement.style.setProperty("--modal-close-dur", "100ms");
		const bridge = installNativeBridgeStub();

		try {
			renderSettingsPage();
			await waitForOpen();

			fireEvent.click(screen.getByRole("button", { name: "Close" }));
			expect(settingsShell().className).toContain("is-closing");

			// The user re-opens while the fade is running: Rust re-shows the
			// still-visible window and emits wasVisible=true. The pending hide
			// timer MUST be cancelled — otherwise it fires right after and hides
			// the window the user just asked for.
			act(() => {
				bridge.emit(IPC.SETTINGS_WINDOW_SHOWN, true);
			});
			await settleOpenAnimation();
			expect(settingsShell().className).toContain("is-open");

			await act(async () => {
				await new Promise((resolve) => setTimeout(resolve, 120));
			});
			expect(bridge.closeSelfCalls()).toBe(0);
			expect(settingsShell().className).toContain("is-open");
		} finally {
			bridge.restore();
			document.documentElement.style.removeProperty("--modal-close-dur");
		}
	});

	test("requests the native hide before the close fade fully completes", async () => {
		useSettingsStore.setState({ settings: DEFAULT_SETTINGS, isLoaded: true });
		useSettingsHydrationStore.setState({ error: null, status: "unavailable" });
		document.documentElement.style.setProperty("--modal-close-dur", "100ms");
		const bridge = installNativeBridgeStub();

		try {
			renderSettingsPage();
			await waitForOpen();

			fireEvent.click(screen.getByRole("button", { name: "Close" }));
			expect(settingsShell().className).toContain("is-closing");
			expect(bridge.closeSelfCalls()).toBe(0);

			// The hide is scheduled ~40ms BEFORE the 100ms fade ends so the IPC +
			// OS hide latency overlaps the (already ~transparent) fade tail
			// instead of holding a fully-faded dark window on screen.
			await act(async () => {
				await new Promise((resolve) => setTimeout(resolve, 90));
			});
			expect(bridge.closeSelfCalls()).toBe(1);
			expect(settingsShell().className).not.toContain("is-closing");
		} finally {
			bridge.restore();
			document.documentElement.style.removeProperty("--modal-close-dur");
		}
	});

	test("holds the reveal until settings content is ready, then plays the enter animation", async () => {
		// Backend still hydrating: the shown event arrives but the (transparent)
		// window must NOT reveal an empty shell.
		useSettingsStore.setState({ settings: DEFAULT_SETTINGS, isLoaded: false });
		useSettingsHydrationStore.setState({ error: null, status: "loading" });
		const bridge = installNativeBridgeStub();

		try {
			renderSettingsPage();
			act(() => {
				bridge.emit(IPC.SETTINGS_WINDOW_SHOWN);
			});
			await settleOpenAnimation();
			await settleOpenAnimation();
			expect(settingsShell().className).not.toContain("is-open");

			// Content becomes ready (settings loaded + panel chunk mounts) → the
			// deferred reveal fires on its own, no further event needed.
			act(() => {
				useSettingsStore.setState({
					settings: DEFAULT_SETTINGS,
					isLoaded: true,
				});
				useSettingsHydrationStore.setState({
					error: null,
					status: "unavailable",
				});
			});
			await waitForOpen();
		} finally {
			bridge.restore();
		}
	});
});
