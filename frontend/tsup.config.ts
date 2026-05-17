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

export default defineConfig([
	{
		entry: ["electron/main.ts"],
		format: "esm",
		outDir: "dist-electron",
		external: ["electron", "uiohook-napi", "pngjs"],
		sourcemap: true,
		define: sharedDefine,
	},
	{
		entry: ["electron/preload.ts"],
		format: "cjs",
		outDir: "dist-electron",
		external: ["electron"],
		sourcemap: true,
		define: sharedDefine,
	},
]);
