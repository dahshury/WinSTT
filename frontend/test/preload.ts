import { afterEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import log from "electron-log/main";

GlobalRegistrator.register();

// ── electron-log test setup ──────────────────────────────────────────
// Production code calls `dbg()` / `dbgVerbose()` (see electron/lib/debug-log.ts)
// which routes through electron-log. Under bun:test two things break by default:
//
// 1. The IPC transport (main→renderer log broadcast) calls
//    `electron.BrowserWindow.getAllWindows()` on every log line. Most tests
//    don't mock `electron` (electron-log captures whatever was resolved at its
//    own module load), so each dbg() call throws an "Unhandled electron-log
//    error" into stderr and pollutes the run.
//
// 2. The console transport calls `console.info`/`console.warn`/etc. using
//    references captured at electron-log module load time, so any test that
//    patches `console.*` after that point can never observe the calls.
//
// Fix both centrally: silence the IPC transport, and replace the console
// transport with a function transport that pushes every formatted log line
// into a globally-accessible array. Tests that need to assert on dbg() output
// read from `globalThis.__testLogLines` (or import `testLogLines` from this
// preload) and reset it in their own beforeEach.
if (log.transports.ipc) {
	log.transports.ipc.level = false;
}
export const testLogLines: string[] = [];
(globalThis as { __testLogLines?: string[] }).__testLogLines = testLogLines;
// Format each line as `(<scope>) <message>` so test assertions can check for
// the tag (matches the production electron-log console format closely enough).
log.transports.console = ((msg: { data: unknown[]; scope?: string }) => {
	const scopePrefix = msg.scope ? `(${msg.scope}) ` : "";
	testLogLines.push(scopePrefix + msg.data.map((arg) => String(arg)).join(" "));
	return msg;
}) as unknown as typeof log.transports.console;
log.transports.console.level = "verbose";

// happy-dom does not implement the Web Animations API. Base UI's ScrollArea
// viewport schedules a deferred `viewport.getAnimations({ subtree: true })`
// via a 0ms timer; that timer frequently fires AFTER the test that mounted
// the ScrollArea has finished, so the `TypeError: getAnimations is not a
// function` surfaces inside whatever unrelated test happens to be running —
// turning one ScrollArea render into a flaky failure somewhere else entirely.
// Polyfilling it to return no animations makes the deferred callback a
// harmless no-op regardless of which test it lands in.
const noAnimations = function getAnimations(): Animation[] {
	return [];
};
for (const proto of [
	typeof Element === "undefined" ? undefined : Element.prototype,
	typeof Document === "undefined" ? undefined : Document.prototype,
]) {
	if (proto && typeof (proto as { getAnimations?: unknown }).getAnimations !== "function") {
		Object.defineProperty(proto, "getAnimations", {
			configurable: true,
			writable: true,
			value: noAnimations,
		});
	}
}

// React commits deletion effects asynchronously. When a suite mounts a tree
// and the file ends (or the global afterEach brute-clears <body>) before
// React flushes those effects, the deferred `removeChild` runs during a LATER
// test against a node whose parent is already gone. happy-dom throws a hard
// `DOMException: The node to be removed is not a child of this node`, which
// bun:test reports as an "unhandled error between tests" and pins on whatever
// innocent test is running then (the flaky OverlayPage failure). Browsers
// would throw too, but React never hits this in a real DOM because it owns
// the container. Make removeChild lenient ONLY for the not-a-child case so a
// leaked async unmount degrades to a no-op instead of poisoning the next test.
if (typeof Node !== "undefined") {
	const proto = Node.prototype as unknown as {
		removeChild: <T extends Node>(child: T) => T;
	};
	const realRemoveChild = proto.removeChild;
	proto.removeChild = function leniently<T extends Node>(this: Node, child: T): T {
		if (child == null || (child as unknown as { parentNode?: Node | null }).parentNode !== this) {
			return child;
		}
		return realRemoveChild.call(this, child) as T;
	};
}

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
