/**
 * Side-effect-only portable-mode bootstrap.
 *
 * MUST be imported as the FIRST statement in ``electron/main.ts`` — before
 * any other module that touches ``app.getPath("userData")`` (electron-store,
 * electron-log, sentry-electron, our ``lib/store.ts`` and ``lib/debug-log.ts``).
 *
 * Why a separate file: ESM imports are evaluated top-down, and downstream
 * modules like ``electron-store`` resolve the userData path EAGERLY in their
 * constructors (not lazily per call). So calling ``app.setPath("userData", …)``
 * inside main.ts AFTER the imports finishes is too late — the store has
 * already cached the wrong directory. Pulling this side effect into its
 * own module gives us an import that is guaranteed to run before any
 * other path-sensitive module is initialised.
 *
 * The detection / override logic itself lives in ``lib/portable.ts``; this
 * file is just the wiring + a debug log of the outcome via electron-log
 * (which itself uses a lazy ``resolvePathFn`` and so survives the early
 * call site).
 */

import { app } from "electron";
import log from "electron-log/main";
import { initPortableMode } from "./lib/portable";

// Build a tiny logger shim that funnels through electron-log's ``portable``
// scope so portable-mode bootstrap events end up in the same ``debug.log``
// the rest of the app writes to. The scope is created lazily so this works
// even when called before electron-log's transports are fully configured.
const portableLogger = {
	info: (message: string): void => {
		try {
			log.scope("portable").info(message);
		} catch {
			// electron-log is intentionally allowed to fail silently here —
			// tests with partial mocks may not provide a ``scope`` accessor.
		}
	},
};

/** State exported so main.ts can log + thread the data dir into other modules. */
export const portableState = initPortableMode(app, portableLogger);
