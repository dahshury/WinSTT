# Sentry crash reporting

WinSTT optionally reports unhandled exceptions and crashes to Sentry via
`@sentry/electron`. The DSN that identifies our Sentry project is **never**
committed to source — it is injected at compile time from the build host's
environment.

## Enabling Sentry in installers

Set `WINSTT_BUILD_SENTRY_DSN` in the build environment before running
`bun electron:build` (or any of the `electron:build:cpu` / `electron:build:gpu`
variants):

```bash
# locally
export WINSTT_BUILD_SENTRY_DSN="https://<key>@<org>.ingest.sentry.io/<project>"
bun electron:build:cpu

# CI (GitHub Actions): add as a repository secret of the same name and
# reference it from .github/workflows/electron-release.yml as
#   env:
#     WINSTT_BUILD_SENTRY_DSN: ${{ secrets.WINSTT_BUILD_SENTRY_DSN }}
```

`tsup` reads the env var in `frontend/tsup.config.ts` and forwards it to
esbuild's `define` option, which substitutes `globalThis.__WINSTT_BUILD_SENTRY_DSN__`
in `electron/lib/sentry-main.ts` with the JSON-stringified literal at compile
time. When the env var is unset, the substituted value is an empty string and
`initSentryMain` becomes a no-op — the resulting build contains no DSN literal
and ships no telemetry.

## Runtime DSN resolution order

`getResolvedSentryDsn()` (in `electron/lib/sentry-main.ts`) resolves the DSN with
this priority:

1. `process.env.SENTRY_DSN` — runtime override (useful for dev / smoke tests).
2. `globalThis.__WINSTT_BUILD_SENTRY_DSN__` — baked in at compile time.
3. Otherwise `undefined` — Sentry stays a no-op.

## Scope

Only the **main process** initialises Sentry (via `@sentry/electron/main`).
The renderer SDK was dropped to shrink the renderer bundle — React errors are
caught locally by `ErrorBoundary.tsx` and written to `console.error` (which
flows through the `webContents#console-message` listener in main.ts → debug.log
→ main-process Sentry). If you need a renderer-originated error to reach
Sentry directly, forward it over IPC and call `captureMainException` from the
main process.

## User opt-out

`general.sendCrashReports` (default: `true`) is a user-facing toggle in
**Settings → General → Startup**. When `false`:

- The main-process `initSentryMain({ enabled: false })` skips Sentry init.
- The Python child spawn (`electron/ipc/stt-process.ts`) strips `SENTRY_DSN`
  from its env so the server-side Sentry SDK also stays disabled.

The setting is checked once at startup. Toggling it requires an app restart —
Sentry's `init()` cannot be cleanly reversed at runtime. The UI tooltip says so.
