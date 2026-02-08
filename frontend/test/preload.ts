import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();

// Mock window.electronAPI for all tests
window.electronAPI = {
	send: () => {
		/* noop mock */
	},
	invoke: () => Promise.resolve(undefined),
	on: () => () => {
		/* noop unsubscribe */
	},
};

declare global {
	interface Window {
		electronAPI: {
			send: (channel: string, ...args: unknown[]) => void;
			invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
			on: (channel: string, callback: (...args: unknown[]) => void) => () => void;
		};
	}
}
