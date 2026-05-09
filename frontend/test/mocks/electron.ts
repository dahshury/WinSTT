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

type IpcHandler = (event: unknown, ...args: unknown[]) => unknown | Promise<unknown>;
type IpcListener = (event: unknown, ...args: unknown[]) => void;

export interface ElectronMockHandle {
	app: {
		getPath: (name: string) => string;
		isPackaged: boolean;
		on: (event: string, cb: (...args: unknown[]) => void) => void;
		off: (event: string, cb: (...args: unknown[]) => void) => void;
		quit: () => void;
		whenReady: () => Promise<void>;
		setLoginItemSettings: (s: Record<string, unknown>) => void;
		getLoginItemSettings: () => Record<string, unknown>;
	};
	BrowserWindow: {
		getAllWindows: () => unknown[];
	};
	clipboard: {
		readText: () => string;
		writeText: (text: string) => void;
		clear: () => void;
	};
	dialog: {
		showOpenDialogSync: () => string[] | undefined;
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
	shell: {
		openExternal: (url: string) => Promise<void>;
		showItemInFolder: (path: string) => void;
	};
	systemPreferences: {
		getMediaAccessStatus: () => string;
	};
	Tray: new (path: string) => unknown;
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
			isPackaged: false,
			on: () => undefined,
			off: () => undefined,
			quit: () => undefined,
			whenReady: () => Promise.resolve(),
			setLoginItemSettings: () => undefined,
			getLoginItemSettings: () => ({ openAtLogin: false }),
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
		Menu: {
			buildFromTemplate: () => ({ popup: () => undefined }),
			setApplicationMenu: () => undefined,
		},
		nativeImage: {
			createFromPath: () => ({ isEmpty: () => false }),
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
