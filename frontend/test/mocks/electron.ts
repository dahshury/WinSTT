/**
 * Default in-memory shim for the `electron` module used by tests.
 *
 * `mock.module("electron", ...)` is process-global — once installed, every
 * subsequent `import {...} from "electron"` sees the shim. To keep multiple
 * test files compatible, every test that mocks electron should spread this
 * default into its override:
 *
 * ```
 * import { electronMock } from "@/test/mocks/electron";
 * mock.module("electron", () => electronMock());
 * ```
 *
 * Each call returns a FRESH object (no shared spies between files).
 */

// `@sentry/electron/main` reads `process.versions.electron` at module-load time
// to determine the host Electron version. Under `bun test` (plain Node) that
// field is `undefined`, which crashes `parseSemver` inside @sentry/core. Stub a
// plausible value so any sentry-main.ts transitive import loads cleanly. Cast
// is required because `versions` is typed as `Readonly<{...}>` in @types/node.
if (typeof process !== "undefined" && !process.versions.electron) {
	(process.versions as Record<string, string>).electron = "30.0.0";
}

type IpcHandler = (event: unknown, ...args: unknown[]) => unknown | Promise<unknown>;
type IpcListener = (event: unknown, ...args: unknown[]) => void;

export interface ElectronMockHandle {
	app: {
		getPath: (name: string) => string;
		getAppPath: () => string;
		getVersion: () => string;
		getName: () => string;
		isPackaged: boolean;
		isReady: () => boolean;
		on: (event: string, cb: (...args: unknown[]) => void) => void;
		off: (event: string, cb: (...args: unknown[]) => void) => void;
		once: (event: string, cb: (...args: unknown[]) => void) => void;
		removeListener: (event: string, cb: (...args: unknown[]) => void) => void;
		quit: () => void;
		exit: (code?: number) => void;
		whenReady: () => Promise<void>;
		setLoginItemSettings: (s: Record<string, unknown>) => void;
		getLoginItemSettings: () => Record<string, unknown>;
		getAppMetrics: () => unknown[];
		getGPUInfo: (level: string) => Promise<unknown>;
		commandLine: { appendSwitch: (...args: unknown[]) => void };
		name: string;
	};
	autoUpdater: {
		on: (event: string, cb: (...args: unknown[]) => void) => void;
		off: (event: string, cb: (...args: unknown[]) => void) => void;
	};
	BrowserWindow: {
		getAllWindows: () => unknown[];
	};
	clipboard: {
		readText: () => string;
		writeText: (text: string) => void;
		clear: () => void;
	};
	crashReporter: {
		start: (options: Record<string, unknown>) => void;
		getLastCrashReport: () => unknown;
		getUploadedReports: () => unknown[];
	};
	dialog: {
		showOpenDialogSync: () => string[] | undefined;
	};
	globalShortcut: {
		register: (accelerator: string, handler: () => void) => boolean;
		unregister: (accelerator: string) => void;
		unregisterAll: () => void;
		isRegistered: (accelerator: string) => boolean;
	};
	ipcMain: {
		handle: (channel: string, listener: IpcHandler) => void;
		removeHandler: (channel: string) => void;
		on: (channel: string, listener: IpcListener) => void;
		off: (channel: string, listener: IpcListener) => void;
		removeAllListeners: (channel?: string) => void;
		_handlers: Map<string, IpcHandler>;
		_listeners: Map<string, IpcListener[]>;
		invokeHandler: (channel: string, ...args: unknown[]) => Promise<unknown>;
		emitListener: (channel: string, ...args: unknown[]) => void;
	};
	Menu: {
		buildFromTemplate: (template: unknown[]) => { popup: () => void };
		setApplicationMenu: (menu: unknown) => void;
	};
	nativeImage: {
		createFromPath: (path: string) => { isEmpty: () => boolean };
	};
	net: {
		request: (...args: unknown[]) => unknown;
	};
	// `powerMonitor`, `autoUpdater`, `crashReporter`, `protocol`, `session`,
	// `webContents`, and `net` are not consumed by application code in tests but
	// must exist so that `@sentry/electron/main` and its sub-integrations can
	// `import { ... } from "electron"` without throwing module load errors.
	powerMonitor: {
		on: (event: string, cb: (...args: unknown[]) => void) => void;
		off: (event: string, cb: (...args: unknown[]) => void) => void;
	};
	protocol: {
		registerSchemesAsPrivileged: (schemes: unknown[]) => void;
		registerStringProtocol: (...args: unknown[]) => void;
		handle: (...args: unknown[]) => void;
	};
	safeStorage: {
		isEncryptionAvailable: () => boolean;
		encryptString: (s: string) => Buffer;
		decryptString: (b: Buffer) => string;
	};
	screen: {
		getPrimaryDisplay: () => {
			bounds: { x: number; y: number; width: number; height: number };
			scaleFactor: number;
			workAreaSize: { width: number; height: number };
		};
		getAllDisplays: () => unknown[];
	};
	session: {
		defaultSession: {
			webRequest: { onHeadersReceived: (...args: unknown[]) => void };
			clearCache: () => Promise<void>;
		};
	};
	shell: {
		openExternal: (url: string) => Promise<void>;
		showItemInFolder: (path: string) => void;
	};
	systemPreferences: {
		getMediaAccessStatus: () => string;
	};
	Tray: new (path: string) => unknown;
	webContents: {
		getAllWebContents: () => unknown[];
	};
}

export function electronMock(): ElectronMockHandle {
	const handlers = new Map<string, IpcHandler>();
	const listeners = new Map<string, IpcListener[]>();

	const ipcMain = {
		handle: (channel: string, listener: IpcHandler) => {
			handlers.set(channel, listener);
		},
		removeHandler: (channel: string) => {
			handlers.delete(channel);
		},
		on: (channel: string, listener: IpcListener) => {
			const list = listeners.get(channel) ?? [];
			list.push(listener);
			listeners.set(channel, list);
		},
		off: (channel: string, listener: IpcListener) => {
			const list = listeners.get(channel) ?? [];
			listeners.set(
				channel,
				list.filter((x) => x !== listener)
			);
		},
		removeAllListeners: (channel?: string) => {
			if (channel === undefined) {
				listeners.clear();
				return;
			}
			listeners.delete(channel);
		},
		_handlers: handlers,
		_listeners: listeners,
		invokeHandler: async (channel: string, ...args: unknown[]) => {
			const h = handlers.get(channel);
			if (!h) {
				throw new Error(`No handler for ${channel}`);
			}
			return h(undefined, ...args);
		},
		emitListener: (channel: string, ...args: unknown[]) => {
			for (const l of listeners.get(channel) ?? []) {
				l(undefined, ...args);
			}
		},
	};

	return {
		app: {
			getPath: (name: string) => `/mock/${name}`,
			getAppPath: () => "/mock/app",
			getVersion: () => "0.0.0-test",
			getName: () => "winstt-test",
			isPackaged: false,
			// Return `false` so `electron-log`'s `onAppReady` defers the
			// synchronous `initializePreload` path. That path tries to write
			// a preload file under `userData` (which doesn't exist in tests)
			// AND calls `session.getPreloads()` (not in our mock surface),
			// resulting in `logger.warn(err)` calls that pollute test
			// expectations spying on `console.log` for `dbg()` output.
			isReady: () => false,
			on: () => undefined,
			off: () => undefined,
			once: () => undefined,
			removeListener: () => undefined,
			quit: () => undefined,
			exit: () => undefined,
			whenReady: () => Promise.resolve(),
			setLoginItemSettings: () => undefined,
			getLoginItemSettings: () => ({ openAtLogin: false }),
			getAppMetrics: () => [],
			getGPUInfo: () => Promise.resolve({}),
			commandLine: { appendSwitch: () => undefined },
			name: "winstt-test",
		},
		BrowserWindow: {
			getAllWindows: () => [],
		},
		clipboard: {
			readText: () => "",
			writeText: () => undefined,
			clear: () => undefined,
		},
		dialog: {
			showOpenDialogSync: () => undefined,
		},
		ipcMain,
		globalShortcut: {
			register: () => true,
			unregister: () => undefined,
			unregisterAll: () => undefined,
			isRegistered: () => false,
		},
		Menu: {
			buildFromTemplate: () => ({ popup: () => undefined }),
			setApplicationMenu: () => undefined,
		},
		nativeImage: {
			createFromPath: () => ({ isEmpty: () => false }),
		},
		powerMonitor: {
			on: () => undefined,
			off: () => undefined,
		},
		autoUpdater: {
			on: () => undefined,
			off: () => undefined,
		},
		crashReporter: {
			start: () => undefined,
			getLastCrashReport: () => null,
			getUploadedReports: () => [],
		},
		protocol: {
			registerSchemesAsPrivileged: () => undefined,
			registerStringProtocol: () => undefined,
			handle: () => undefined,
		},
		session: {
			defaultSession: {
				webRequest: { onHeadersReceived: () => undefined },
				clearCache: () => Promise.resolve(),
			},
		},
		webContents: {
			getAllWebContents: () => [],
		},
		net: {
			request: () => undefined,
		},
		screen: {
			getPrimaryDisplay: () => ({
				workAreaSize: { width: 1920, height: 1080 },
				bounds: { x: 0, y: 0, width: 1920, height: 1080 },
				scaleFactor: 1,
			}),
			getAllDisplays: () => [],
		},
		shell: {
			openExternal: () => Promise.resolve(),
			showItemInFolder: () => undefined,
		},
		Tray: class {} as unknown as ElectronMockHandle["Tray"],
		safeStorage: {
			isEncryptionAvailable: () => true,
			encryptString: (s: string) => Buffer.from(s, "utf-8"),
			decryptString: (b: Buffer) => b.toString("utf-8"),
		},
		systemPreferences: {
			getMediaAccessStatus: () => "granted",
		},
	};
}
