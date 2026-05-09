import { afterEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();

// @testing-library/react does not auto-cleanup under bun:test, and importing
// `cleanup` from @testing-library/react in this preload tears down the
// happy-dom global document between tests. Strip mounted React roots manually
// by removing detected react-root containers from <body>.
afterEach(() => {
	if (typeof document === "undefined") {
		return;
	}
	const body = document.body;
	if (!body) {
		return;
	}
	// Remove any nodes added by @testing-library/react's render — it appends
	// <div>s to body and never sets a unique testid on them, so just clear all
	// direct children of body. Tests that need persistent DOM should set up
	// their own host nodes inside a beforeEach.
	while (body.firstChild) {
		body.removeChild(body.firstChild);
	}
	// Reset the persisted locale store between tests so a test that sets a
	// non-default locale does not poison subsequent tests that depend on
	// translation strings (e.g. accessible-name lookups by English label).
	if (typeof window !== "undefined" && window.localStorage) {
		window.localStorage.removeItem("winstt-locale");
	}
});

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
