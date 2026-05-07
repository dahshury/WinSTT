import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();

// Mock window.electronAPI for all tests
window.electronAPI = {
	getPathForFile: () => "",
	send: () => {
		/* noop mock */
	},
	invoke: () => Promise.resolve(undefined),
	secureInvoke: () => Promise.resolve(undefined),
	on: () => () => {
		/* noop unsubscribe */
	},
};

declare global {
	interface Window {
		electronAPI: {
			getPathForFile: (file: File) => string;
			send: (channel: string, ...args: unknown[]) => void;
			invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
			secureInvoke: (channel: string, payload?: unknown) => Promise<unknown>;
			on: (channel: string, callback: (...args: unknown[]) => void) => () => void;
		};
	}
}
