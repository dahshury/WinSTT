import { afterEach, mock } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Register a happy-dom global document/window so @testing-library/react can mount.
GlobalRegistrator.register();

// Replace the production `IntlProvider` (which lazy-loads its message bundle via
// `import.meta.glob` and renders `null` until the async load resolves — empty
// under `bun test`) with a synchronous test double that serves the real English
// bundle immediately, so component tests that `render(<IntlProvider>…)` and
// assert synchronously see their translated children. See
// `test/mocks/intl-provider.tsx`.
mock.module("@/app/providers/IntlProvider", () => require("./mocks/intl-provider"));

// happy-dom does not implement the Web Animations API. Base UI's ScrollArea
// viewport schedules a deferred `viewport.getAnimations({ subtree: true })` via a
// 0ms timer that frequently fires AFTER the test that mounted the ScrollArea has
// finished, surfacing `TypeError: getAnimations is not a function` inside an
// unrelated later test. Polyfilling it to return no animations makes the deferred
// callback a harmless no-op regardless of which test it lands in.
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

// React commits deletion effects asynchronously. When a suite mounts a tree and
// the file ends (or the global afterEach brute-clears <body>) before React flushes
// those effects, the deferred `removeChild` runs during a LATER test against a node
// whose parent is already gone — happy-dom throws a hard `DOMException` that bun:test
// pins on whatever innocent test is running then. Make removeChild lenient ONLY for
// the not-a-child case so a leaked async unmount degrades to a no-op.
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

// happy-dom does not implement the HTML spec rule (§4.10.4) that a <label>'s implicit
// activation is a NO-OP for clicks targeted at interactive content inside it. happy-dom
// forwards EVERY non-control click to the control, surfacing as phantom double
// onChange/onToggle calls that never happen in a real browser. Suppress the forwarding
// when the click landed on interactive content.
if (typeof HTMLLabelElement !== "undefined") {
	const INTERACTIVE_SELECTOR =
		"a[href],button,input,select,textarea,[role='button'],[role='checkbox'],[role='switch'],[role='radio'],[role='menuitemcheckbox'],[role='menuitemradio'],[contenteditable='true']";
	const labelProto = HTMLLabelElement.prototype;
	const forwardingDispatch = labelProto.dispatchEvent;
	const baseDispatch = Object.getPrototypeOf(labelProto).dispatchEvent as (
		this: EventTarget,
		event: Event
	) => boolean;
	labelProto.dispatchEvent = function specCompliantLabelDispatch(event: Event): boolean {
		const target = event.target as Element | null;
		if (
			event.type === "click" &&
			target &&
			typeof target.closest === "function" &&
			target.closest(INTERACTIVE_SELECTOR)
		) {
			return baseDispatch.call(this, event);
		}
		return forwardingDispatch.call(this, event);
	};
}

// Default global stubs, installed at load AND re-installed after every test.
//
// `window.nativeBridge` is the renderer's native bridge surface; `__TAURI_INTERNALS__`
// is what `@tauri-apps/api/core` invoke reads (hooks/stores that call Tauri commands
// DIRECTLY via the typed `commands.*` bindings reach it, bypassing nativeBridge).
// Both default to resolving `undefined`. Suites that need specific responses REPLACE
// these per-suite; because the happy-dom `window` is shared across every test file in
// the one bun process, a suite that replaces them and forgets to restore would poison
// later files — so the afterEach below re-installs the defaults to keep files isolated.
let tauriCallbackId = 0;

function installDefaultNativeBridge(): void {
	window.nativeBridge = {
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
}

function installDefaultTauriInternals(): void {
	(
		window as unknown as {
			__TAURI_INTERNALS__: {
				invoke: (cmd: string, args?: unknown, options?: unknown) => Promise<unknown>;
				transformCallback: (cb?: (payload: unknown) => void, once?: boolean) => number;
			};
		}
	).__TAURI_INTERNALS__ = {
		invoke: () => Promise.resolve(undefined),
		transformCallback: () => {
			tauriCallbackId += 1;
			return tauriCallbackId;
		},
	};
}

installDefaultNativeBridge();
installDefaultTauriInternals();

// @testing-library/react does not auto-cleanup under bun:test, and importing
// `cleanup` here would tear down the happy-dom global document between tests.
// Strip mounted React roots manually + reset the shared per-window globals
// (localStorage, the native bridge, the Tauri internals) so a suite that mutates
// any of them can't poison a later file in the same process.
afterEach(() => {
	if (typeof window !== "undefined") {
		if (window.localStorage) {
			window.localStorage.clear();
		}
		installDefaultNativeBridge();
		installDefaultTauriInternals();
	}
	if (typeof document === "undefined") {
		return;
	}
	const body = document.body;
	if (body) {
		while (body.firstChild) {
			body.removeChild(body.firstChild);
		}
	}
});

declare global {
	interface Window {
		nativeBridge: {
			getPathForFile: (file: File) => string;
			send: (channel: string, ...args: unknown[]) => void;
			invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
			secureInvoke: (channel: string, payload?: unknown) => Promise<unknown>;
			on: (channel: string, callback: (...args: unknown[]) => void) => () => void;
		};
	}
}
