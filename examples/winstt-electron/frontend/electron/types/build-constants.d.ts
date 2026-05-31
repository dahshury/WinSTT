// Ambient declaration for compile-time constants injected by tsup's esbuild
// `define` option (see `frontend/tsup.config.ts`).
//
// `__WINSTT_BUILD_SENTRY_DSN__` is replaced verbatim at compile time with the
// JSON-stringified value of the `WINSTT_BUILD_SENTRY_DSN` env var read from
// the build host. When the env var is unset (local dev, CI without secret),
// it resolves to an empty string and `initSentryMain` treats that as
// "no DSN configured" — Sentry stays a no-op.
//
// IMPORTANT: this identifier is substituted at *compile* time (esbuild), not
// at runtime via `process.env`. The source tree contains no DSN literal.

declare global {
	var __WINSTT_BUILD_SENTRY_DSN__: string;
}

export {};
