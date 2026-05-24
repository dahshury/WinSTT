import { defineConfig } from "tsup";

// `WINSTT_BUILD_SENTRY_DSN` is read from the host environment at build time
// (locally or as a GitHub Actions secret) and inlined into the compiled main
// process via esbuild's `--define`. The source tree itself contains no DSN
// literal; when the env var is unset, this resolves to an empty string and
// `initSentryMain` treats it as "no DSN configured" (no telemetry).
const buildDsn = process.env.WINSTT_BUILD_SENTRY_DSN ?? "";

// Shared compile-time define block — applied to every entry so any module
// that references `globalThis.__WINSTT_BUILD_SENTRY_DSN__` (currently only
// `sentry-main.ts`, but kept consistent for forward-compat) sees the same
// substituted literal.
const sharedDefine = {
	"globalThis.__WINSTT_BUILD_SENTRY_DSN__": JSON.stringify(buildDsn),
} as const;

// Externals that must NOT be bundled into the Electron main/preload:
//   * `electron` — built-in, provided by Electron's runtime. The dev-time
//     `node_modules/electron/index.js` shim, if bundled, runs at startup and
//     throws `Dynamic require of "child_process" is not supported`.
//   * `uiohook-napi`, `node-gyp-build` — native `.node` addons. Their loader
//     code uses `__dirname` to find the binary; bundling breaks that.
//   * `pngjs` — kept external for parity with the asar `files` glob.
//
// Everything else (zod, ai, ws, archiver, @openrouter/ai-sdk-provider,
// electron-log, electron-store, electron-updater, ...) must be **inlined**
// into the bundle — the packaged asar ships no other node_modules. Without
// this, `import { z } from "zod"` survives to runtime and Node bails with
// `ERR_MODULE_NOT_FOUND: Cannot find package 'zod'`.
//
// The negative-lookahead regex lets `external` win: anything matching one
// of the external names stays external; everything else is force-bundled.
//
// The banner injects a real CJS `require()` (via `node:module#createRequire`)
// onto `globalThis`, so that esbuild's `__require` polyfill (which checks
// `typeof require !== "undefined"`) routes runtime `require('electron')`
// calls from bundled CJS deps (electron-log, electron-store, ...) through
// the real Node CJS loader — which Electron intercepts and resolves to its
// built-in `electron` module. Without the banner, those bundled deps blow
// up at startup with "Dynamic require of ... is not supported".
const externalPackages = ["electron", "uiohook-napi", "node-gyp-build", "pngjs"];
const externalRegex = externalPackages.map((p) => p.replace(/[/-]/g, "\\$&")).join("|");
const noExternalRegex = new RegExp(`^(?!(?:${externalRegex})(?:$|/))`);

const runtimeRequireBanner = [
	`import { createRequire as __winsttCreateRequire } from "node:module";`,
	`if (typeof globalThis.require === "undefined") {`,
	"  globalThis.require = __winsttCreateRequire(import.meta.url);",
	"}",
].join("\n");

export default defineConfig([
	{
		entry: ["electron/main.ts"],
		format: "esm",
		outDir: "dist-electron",
		external: externalPackages,
		noExternal: [noExternalRegex],
		banner: { js: runtimeRequireBanner },
		sourcemap: true,
		define: sharedDefine,
	},
	{
		entry: ["electron/preload.ts"],
		format: "cjs",
		outDir: "dist-electron",
		external: ["electron"],
		// Preload runs in the renderer's CJS sandbox — runtime `require`
		// already exists, no banner needed. Bundle everything except electron.
		noExternal: [/^(?!electron(?:$|\/))/],
		sourcemap: true,
		define: sharedDefine,
	},
]);
