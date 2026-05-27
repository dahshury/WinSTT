import { beforeEach, describe, expect, mock, test } from "bun:test";
import { electronMock } from "@test/mocks/electron";

interface MockTray {
	contextMenus: unknown[];
	destroyed: boolean;
	imageCount: number;
	isDestroyed: () => boolean;
	setContextMenu: (menu: unknown) => void;
	setImage: (img: unknown) => void;
}

function noopActions(): {
	onOpenMainWindow: () => void;
	onOpenSettings: () => void;
	onQuit: () => void;
} {
	const noop = (): void => {
		// no-op for tests that don't exercise these callbacks
	};
	return { onOpenMainWindow: noop, onOpenSettings: noop, onQuit: noop };
}

function makeTray(): MockTray {
	const t: MockTray = {
		contextMenus: [],
		destroyed: false,
		imageCount: 0,
		isDestroyed() {
			return t.destroyed;
		},
		setContextMenu(menu: unknown) {
			t.contextMenus.push(menu);
		},
		setImage() {
			t.imageCount += 1;
		},
	};
	return t;
}

// Pluggable theme controller — flipped per test before calling the SUT.
const themeController = {
	shouldUseDarkColors: true,
	listeners: [] as Array<() => void>,
	platform: "win32" as NodeJS.Platform,
};

mock.module("electron", () => ({
	...electronMock(),
	nativeImage: {
		// Always non-empty so the SUT's "fallback to empty" branch isn't
		// taken — keeps test focus on state/theme logic, not file I/O.
		createFromPath: () => ({ isEmpty: () => false }),
		createEmpty: () => ({ isEmpty: () => true }),
	},
	nativeTheme: {
		get shouldUseDarkColors() {
			return themeController.shouldUseDarkColors;
		},
		on: (event: string, cb: () => void) => {
			if (event === "updated") {
				themeController.listeners.push(cb);
			}
		},
		off: (event: string, cb: () => void) => {
			if (event === "updated") {
				const idx = themeController.listeners.indexOf(cb);
				if (idx !== -1) {
					themeController.listeners.splice(idx, 1);
				}
			}
		},
	},
	Menu: {
		buildFromTemplate: (template: unknown[]) => ({ template }),
	},
}));

mock.module("node:fs", () => ({
	existsSync: () => true,
}));

const trayState = await import("./tray-state");
const {
	attachTray,
	detachTray,
	getCurrentTrayTheme,
	getTrayIconPath,
	getTrayState,
	onTrayIdle,
	onTrayRecordingStart,
	onTrayTranscriptionStart,
	setTrayHistoryProvider,
	setTrayState,
	refreshTrayHistory,
	__tray_state_test_helpers__: helpers,
} = trayState;

function setPlatform(platform: NodeJS.Platform): void {
	Object.defineProperty(process, "platform", { value: platform, configurable: true });
	themeController.platform = platform;
}

describe("getTrayIconPath", () => {
	beforeEach(() => {
		helpers.resetForTests();
	});

	test("composes path for each (theme, state) pair", () => {
		type ThemeArg = Parameters<typeof getTrayIconPath>[0];
		type StateArg = Parameters<typeof getTrayIconPath>[1];
		const matrix: [ThemeArg, StateArg][] = [
			["dark", "idle"],
			["dark", "recording"],
			["dark", "transcribing"],
			["light", "idle"],
			["light", "recording"],
			["light", "transcribing"],
			["color", "idle"],
			["color", "recording"],
			["color", "transcribing"],
		];
		const paths = matrix.map(([theme, state]) => getTrayIconPath(theme, state));
		// All 9 distinct paths
		expect(new Set(paths).size).toBe(9);
		// Filename embeds the state + theme
		for (const [theme, state] of matrix) {
			const p = getTrayIconPath(theme, state);
			expect(p).toMatch(new RegExp(`tray_${state}_${theme}\\.png$`));
		}
	});
});

describe("getCurrentTrayTheme", () => {
	beforeEach(() => {
		helpers.resetForTests();
	});

	test("Linux always returns 'color' regardless of system theme", () => {
		setPlatform("linux");
		themeController.shouldUseDarkColors = true;
		expect(getCurrentTrayTheme()).toBe("color");
		themeController.shouldUseDarkColors = false;
		expect(getCurrentTrayTheme()).toBe("color");
	});

	test("Windows light system → 'light' theme", () => {
		setPlatform("win32");
		themeController.shouldUseDarkColors = false;
		expect(getCurrentTrayTheme()).toBe("light");
	});

	test("Windows dark system → 'dark' theme", () => {
		setPlatform("win32");
		themeController.shouldUseDarkColors = true;
		expect(getCurrentTrayTheme()).toBe("dark");
	});

	test("macOS dark system → 'dark' theme", () => {
		setPlatform("darwin");
		themeController.shouldUseDarkColors = true;
		expect(getCurrentTrayTheme()).toBe("dark");
	});
});

describe("tray state machine", () => {
	beforeEach(() => {
		helpers.resetForTests();
		themeController.listeners.length = 0;
		themeController.shouldUseDarkColors = true;
		setPlatform("win32");
	});

	test("attaches a tray and renders idle by default (no native menu on Windows)", () => {
		const tray = makeTray();
		attachTray(tray as unknown as Electron.Tray, noopActions());
		expect(getTrayState()).toBe("idle");
		expect(tray.imageCount).toBe(1);
		// Windows/macOS use the custom BrowserWindow-based menu shown by the
		// `right-click` handler in tray.ts; setContextMenu MUST stay unset
		// or the OS-native menu preempts the custom one.
		expect(tray.contextMenus.length).toBe(0);
	});

	test("Linux gets a native context menu on attach", () => {
		setPlatform("linux");
		const tray = makeTray();
		attachTray(tray as unknown as Electron.Tray, noopActions());
		expect(tray.contextMenus.length).toBe(1);
	});

	test("setTrayState updates state but does NOT paint a static icon for recording/transcribing (the live indicator owns the icon)", () => {
		const tray = makeTray();
		attachTray(tray as unknown as Electron.Tray, noopActions());
		const baseImg = tray.imageCount;
		const baseMenu = tray.contextMenus.length;
		setTrayState("recording");
		expect(getTrayState()).toBe("recording");
		// applyTrayImage is gated on state === "idle" — recording's static PNG
		// is suppressed so it can't race the indicator's bar animation and
		// flash before the first frame paints.
		expect(tray.imageCount).toBe(baseImg);
		expect(tray.contextMenus.length).toBe(baseMenu);
	});

	test("setTrayState transitioning back to idle DOES paint the idle PNG", () => {
		const tray = makeTray();
		attachTray(tray as unknown as Electron.Tray, noopActions());
		setTrayState("recording");
		const beforeIdle = tray.imageCount;
		setTrayState("idle");
		expect(getTrayState()).toBe("idle");
		expect(tray.imageCount).toBe(beforeIdle + 1);
	});

	test("setTrayState rebuilds the native menu on Linux", () => {
		setPlatform("linux");
		const tray = makeTray();
		attachTray(tray as unknown as Electron.Tray, noopActions());
		const baseMenu = tray.contextMenus.length;
		setTrayState("recording");
		expect(tray.contextMenus.length).toBe(baseMenu + 1);
	});

	test("setTrayState is a no-op when state is unchanged", () => {
		const tray = makeTray();
		attachTray(tray as unknown as Electron.Tray, noopActions());
		setTrayState("recording");
		const after = tray.imageCount;
		setTrayState("recording");
		expect(tray.imageCount).toBe(after);
	});

	test("onTrayRecordingStart → onTrayTranscriptionStart → onTrayIdle cycle", () => {
		const tray = makeTray();
		attachTray(tray as unknown as Electron.Tray, noopActions());
		onTrayRecordingStart();
		expect(getTrayState()).toBe("recording");
		onTrayTranscriptionStart();
		expect(getTrayState()).toBe("transcribing");
		onTrayIdle();
		expect(getTrayState()).toBe("idle");
	});

	test("native theme 'updated' listener refreshes the icon", () => {
		const tray = makeTray();
		attachTray(tray as unknown as Electron.Tray, noopActions());
		expect(themeController.listeners.length).toBe(1);
		const before = tray.imageCount;
		themeController.shouldUseDarkColors = false;
		// Fire the registered listener — mirrors nativeTheme.emit("updated")
		const cb = themeController.listeners[0];
		expect(cb).toBeDefined();
		cb?.();
		expect(tray.imageCount).toBe(before + 1);
	});

	test("detachTray removes the theme listener and clears the ref", () => {
		const tray = makeTray();
		attachTray(tray as unknown as Electron.Tray, noopActions());
		detachTray();
		expect(themeController.listeners.length).toBe(0);
		const before = tray.imageCount;
		// After detach, state transitions don't touch the destroyed-ref tray
		setTrayState("recording");
		expect(tray.imageCount).toBe(before);
	});

	test("destroyed tray short-circuits image/menu writes", () => {
		const tray = makeTray();
		attachTray(tray as unknown as Electron.Tray, noopActions());
		const before = tray.imageCount;
		tray.destroyed = true;
		setTrayState("recording");
		expect(tray.imageCount).toBe(before);
	});
});

describe("history submenu integration point", () => {
	beforeEach(() => {
		helpers.resetForTests();
		themeController.listeners.length = 0;
	});

	test("menu omits 'Recent transcriptions' when no provider is installed", () => {
		const template = helpers.buildMenuTemplate();
		const labels = template
			.map((item) => ("label" in item ? item.label : null))
			.filter((l): l is string => typeof l === "string");
		expect(labels).not.toContain("Recent transcriptions");
	});

	test("menu includes submenu placeholder once a provider is registered", () => {
		setTrayHistoryProvider(() => []);
		const template = helpers.buildMenuTemplate();
		const recents = template.find(
			(item) => "label" in item && item.label === "Recent transcriptions"
		);
		expect(recents).toBeDefined();
	});

	test("provider entries appear in the submenu after refresh", async () => {
		setTrayHistoryProvider(() => [{ text: "Hello world" }, { text: "Another transcript" }]);
		// Allow the post-set Promise.resolve micro-task to complete.
		await Promise.resolve();
		const template = helpers.buildMenuTemplate();
		const recents = template.find(
			(item) => "label" in item && item.label === "Recent transcriptions"
		);
		expect(recents).toBeDefined();
		const submenu = (recents as { submenu?: { label: string }[] } | undefined)?.submenu ?? [];
		expect(submenu.length).toBe(2);
		expect(submenu[0]?.label).toBe("Hello world");
	});

	test("clearing the provider hides the submenu", () => {
		setTrayHistoryProvider(() => [{ text: "x" }]);
		setTrayHistoryProvider(null);
		const template = helpers.buildMenuTemplate();
		const recents = template.find(
			(item) => "label" in item && item.label === "Recent transcriptions"
		);
		expect(recents).toBeUndefined();
	});

	test("refreshTrayHistory is a no-op without a provider", () => {
		expect(() => refreshTrayHistory()).not.toThrow();
	});
});

describe("menu items", () => {
	beforeEach(() => {
		helpers.resetForTests();
	});

	test("idle state label and quit action wire to the registered callbacks", () => {
		let quitCount = 0;
		let openCount = 0;
		let settingsCount = 0;
		const tray = makeTray();
		attachTray(tray as unknown as Electron.Tray, {
			onOpenMainWindow: () => {
				openCount += 1;
			},
			onOpenSettings: () => {
				settingsCount += 1;
			},
			onQuit: () => {
				quitCount += 1;
			},
		});
		const template = helpers.buildMenuTemplate();
		const [stateItem] = template;
		expect(stateItem?.label).toBe("Idle");
		const open = template.find((i) => "label" in i && i.label === "Open WinSTT") as {
			click?: () => void;
		};
		open?.click?.();
		expect(openCount).toBe(1);
		const settings = template.find((i) => "label" in i && i.label === "Settings") as {
			click?: () => void;
		};
		settings?.click?.();
		expect(settingsCount).toBe(1);
		const quit = template.find((i) => "label" in i && i.label === "Quit") as {
			click?: () => void;
		};
		quit?.click?.();
		expect(quitCount).toBe(1);
	});

	test("recording state label is 'Recording…'", () => {
		setTrayState("recording");
		const template = helpers.buildMenuTemplate();
		expect(template[0]?.label).toBe("Recording…");
	});

	test("transcribing state label is 'Transcribing…'", () => {
		setTrayState("transcribing");
		const template = helpers.buildMenuTemplate();
		expect(template[0]?.label).toBe("Transcribing…");
	});
});

describe("clipTranscript", () => {
	test("returns text untouched when within the limit", () => {
		expect(helpers.clipTranscript("short", 60)).toBe("short");
	});

	test("collapses runs of whitespace", () => {
		expect(helpers.clipTranscript("  hello   world  ", 60)).toBe("hello world");
	});

	test("clips with an ellipsis once the limit is exceeded", () => {
		const input = "a".repeat(80);
		const out = helpers.clipTranscript(input, 10);
		expect(out.length).toBe(10);
		expect(out.endsWith("…")).toBe(true);
	});
});
