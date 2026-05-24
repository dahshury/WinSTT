import os from "node:os";
import type { ErrorEvent as SentryErrorEvent } from "@sentry/electron/main";
import { app } from "electron";
import { getLogger } from "./debug-log";

// `@sentry/electron/main` is loaded LAZILY (dynamic import) and only when a
// DSN is actually configured. Static-importing it cost ~500 KB-1 MB on the
// main.js bundle even when telemetry was disabled, because Sentry drags in
// the entire `@opentelemetry/*` instrumentation tree, `@sentry/node`,
// `@sentry/browser`, `@sentry/core`, `@vercel/oidc`, etc. By gating the
// import on `getResolvedSentryDsn()` returning a truthy value we keep the
// telemetry-off binary lean. The type-only import above is erased by
// tsup, so it carries no runtime cost.
type SentryMainModule = typeof import("@sentry/electron/main");
let sentryModule: SentryMainModule | null = null;

const sentryLog = getLogger("sentry");

const SENSITIVE_KEY_SUBSTRINGS = [
	"transcript",
	"transcription",
	"audio_data",
	"audiodata",
	"pcm",
	"wav",
];
const SCRUBBED = "[scrubbed]";
const SCRUBBED_AUDIO_PREFIX = "[scrubbed audio buffer";
/** Heuristic: byte arrays larger than this look like audio buffers. */
const AUDIO_BUFFER_BYTE_THRESHOLD = 256;

let initialized = false;

function keyLooksSensitive(key: string): boolean {
	const lowered = key.toLowerCase();
	return SENSITIVE_KEY_SUBSTRINGS.some((needle) => lowered.includes(needle));
}

function valueLooksLikeAudioBuffer(value: unknown): boolean {
	if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
		return true;
	}
	if (
		Array.isArray(value) &&
		value.length >= AUDIO_BUFFER_BYTE_THRESHOLD &&
		value.every((entry) => typeof entry === "number" && entry >= -1 && entry <= 256)
	) {
		return true;
	}
	return false;
}

function describeAudioBuffer(value: unknown): string {
	if (value instanceof Uint8Array) {
		return `${SCRUBBED_AUDIO_PREFIX} ${value.byteLength} bytes]`;
	}
	if (value instanceof ArrayBuffer) {
		return `${SCRUBBED_AUDIO_PREFIX} ${value.byteLength} bytes]`;
	}
	if (Array.isArray(value)) {
		return `${SCRUBBED_AUDIO_PREFIX} ${value.length} bytes]`;
	}
	return `${SCRUBBED_AUDIO_PREFIX} ? bytes]`;
}

function getHomePathFragment(): string {
	try {
		return os.homedir();
	} catch {
		return "";
	}
}

const HOME_FRAGMENT = getHomePathFragment();

function stringHasHomePath(value: string): boolean {
	return HOME_FRAGMENT.length > 0 && value.includes(HOME_FRAGMENT);
}

function scrubString(value: string): string {
	if (stringHasHomePath(value)) {
		return value.split(HOME_FRAGMENT).join("~");
	}
	return value;
}

function scrubValue(value: unknown, depth: number): unknown {
	if (depth > 6) {
		return value;
	}
	if (value === null || value === undefined) {
		return value;
	}
	if (typeof value === "string") {
		return scrubString(value);
	}
	if (valueLooksLikeAudioBuffer(value)) {
		return describeAudioBuffer(value);
	}
	if (Array.isArray(value)) {
		return value.map((entry) => scrubValue(entry, depth + 1));
	}
	if (typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
			if (keyLooksSensitive(key)) {
				out[key] = SCRUBBED;
				continue;
			}
			out[key] = scrubValue(inner, depth + 1);
		}
		return out;
	}
	return value;
}

function scrubRecord(
	source: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
	if (!source) {
		return source;
	}
	const scrubbed = scrubValue(source, 0);
	return typeof scrubbed === "object" && scrubbed !== null
		? (scrubbed as Record<string, unknown>)
		: source;
}

function scrubBreadcrumbs<T extends { data?: Record<string, unknown>; message?: string }>(
	breadcrumbs: readonly T[] | undefined
): T[] | undefined {
	if (!breadcrumbs) {
		return breadcrumbs as T[] | undefined;
	}
	return breadcrumbs.map((crumb) => ({
		...crumb,
		message: crumb.message ? scrubString(crumb.message) : crumb.message,
		data: scrubRecord(crumb.data),
	}));
}

function beforeSend(event: SentryErrorEvent): SentryErrorEvent | null {
	try {
		if (event.extra) {
			event.extra = scrubRecord(event.extra) ?? event.extra;
		}
		if (event.contexts) {
			const scrubbed = scrubRecord(event.contexts) as SentryErrorEvent["contexts"];
			if (scrubbed === undefined) {
				// biome-ignore lint/performance/noDelete: exact-optional `contexts?: Contexts` requires omission (not undefined) when removing
				delete event.contexts;
			} else {
				event.contexts = scrubbed;
			}
		}
		if (event.breadcrumbs) {
			event.breadcrumbs = scrubBreadcrumbs(event.breadcrumbs) ?? event.breadcrumbs;
		}
		if (event.user) {
			const scrubbedUser: Record<string, unknown> = {};
			for (const [key, value] of Object.entries(event.user)) {
				if (key === "ip_address" || key === "email") {
					continue;
				}
				scrubbedUser[key] = value;
			}
			if (Object.keys(scrubbedUser).length > 0) {
				event.user = scrubbedUser;
			} else {
				// biome-ignore lint/performance/noDelete: exact-optional `user?: User` requires omission (not undefined) when clearing
				delete event.user;
			}
		}
		// Scrub absolute paths in the top-level message.
		if (typeof event.message === "string") {
			event.message = scrubString(event.message);
		}
	} catch (error) {
		// A scrubber bug must not block error reporting entirely — log and pass through.
		sentryLog.warn("beforeSend scrubber failed:", String(error));
	}
	return event;
}

/**
 * Resolve the Sentry DSN with this priority:
 *
 *   1. `process.env.SENTRY_DSN`           — runtime override for dev/testing
 *   2. `globalThis.__WINSTT_BUILD_SENTRY_DSN__` — baked in at compile time by
 *                                          tsup's esbuild `define` option
 *                                          (see `frontend/tsup.config.ts`)
 *   3. otherwise `undefined`              — Sentry stays a no-op
 *
 * Empty strings are normalised to `undefined` so callers can use a single
 * truthiness check.
 */
export function getResolvedSentryDsn(): string | undefined {
	const fromEnv = process.env.SENTRY_DSN;
	if (typeof fromEnv === "string" && fromEnv.length > 0) {
		return fromEnv;
	}
	// `globalThis.__WINSTT_BUILD_SENTRY_DSN__` is substituted to a string
	// literal at compile time. If the build host didn't set
	// WINSTT_BUILD_SENTRY_DSN, the substituted value is an empty string.
	const fromBuild =
		typeof globalThis.__WINSTT_BUILD_SENTRY_DSN__ === "string"
			? globalThis.__WINSTT_BUILD_SENTRY_DSN__
			: "";
	if (fromBuild.length > 0) {
		return fromBuild;
	}
	return;
}

export interface InitSentryMainOptions {
	/** When false, skip Sentry init entirely (user opted out). Defaults to true. */
	enabled?: boolean;
}

/**
 * Initialize Sentry in the main process. Idempotent. When no DSN can be
 * resolved (see `getResolvedSentryDsn`), this is a no-op so dev/local runs
 * don't ship telemetry by accident. When `enabled` is `false`, Sentry is
 * skipped regardless of DSN configuration — used to honour the
 * `general.sendCrashReports` opt-out setting.
 *
 * Fire-and-forget: callers do NOT need to `await` this. Breadcrumb /
 * captureException calls that fire BEFORE the dynamic import resolves are
 * silently dropped (acceptable — the gap is a few hundred milliseconds on
 * cold start, and the same calls would have been no-ops if the DSN were
 * absent anyway).
 */
export function initSentryMain(options: InitSentryMainOptions = {}): void {
	if (initialized) {
		return;
	}
	const enabled = options.enabled ?? true;
	if (!enabled) {
		sentryLog.info("Sentry disabled (user opted out)");
		initialized = true;
		return;
	}
	const dsn = getResolvedSentryDsn();
	if (!dsn) {
		sentryLog.info("Sentry disabled (no DSN)");
		initialized = true;
		return;
	}
	// Mark initialized BEFORE the await so a second concurrent call short-
	// circuits and doesn't trigger a duplicate import.
	initialized = true;
	loadAndInitSentry(dsn).catch((error: unknown) => {
		sentryLog.warn("Sentry init failed:", error);
	});
}

async function loadAndInitSentry(dsn: string): Promise<void> {
	let release: string;
	try {
		release = `winstt@${app.getVersion()}`;
	} catch {
		release = "winstt@unknown";
	}

	let environment: string;
	try {
		environment = app.isPackaged ? "production" : "development";
	} catch {
		environment = "development";
	}

	try {
		sentryModule = await import("@sentry/electron/main");
	} catch (error) {
		sentryLog.warn(
			`Sentry dynamic import failed (${error instanceof Error ? error.message : String(error)}); telemetry disabled this session.`
		);
		return;
	}

	sentryModule.init({
		dsn,
		release,
		environment,
		tracesSampleRate: 0,
		beforeSend,
		// Strip user-home paths from stack-frame filenames before they leave the device.
		// (`@sentry/electron` ships with a normalizePathsIntegration by default.)
		integrations: (defaults) => defaults,
	});
	sentryLog.info(`Sentry initialized (env=${environment}, release=${release})`);
}

/**
 * Drop a Sentry breadcrumb on the main-process scope. Safe to call when Sentry
 * is uninitialized — `addBreadcrumb` is a no-op without a configured DSN, so
 * call sites don't need to guard. Data payloads must be scrubbed by the caller:
 * NEVER include transcript text, audio bytes, file paths, or raw error stacks.
 */
export function breadcrumb(
	category: string,
	message: string,
	data?: Record<string, string | number | boolean>,
	level: "info" | "warning" | "error" = "info"
): void {
	if (!sentryModule) {
		// Sentry not initialized OR still importing; drop the breadcrumb. This
		// matches the previous behavior (`addBreadcrumb` was already a no-op
		// before `sentryInit` ran) and avoids re-implementing Sentry's queue.
		return;
	}
	try {
		sentryModule.addBreadcrumb(
			data === undefined ? { category, message, level } : { category, message, data, level }
		);
	} catch {
		// Breadcrumb emission must never crash callers.
	}
}

/**
 * Send an error to Sentry from the main process. Safe to call before / after
 * `initSentryMain` regardless of telemetry state — when Sentry isn't loaded
 * (DSN absent OR dynamic import still pending) this is a silent no-op.
 */
export function captureMainException(error: unknown, context?: Record<string, unknown>): void {
	if (!sentryModule) {
		// Sentry not initialized OR still importing. Drop the event — there's
		// no in-memory queue we can flush later, but the cost of one missed
		// exception during the ~200 ms dynamic-import window is acceptable
		// versus carrying ~1 MB of always-loaded telemetry deps.
		return;
	}
	try {
		if (context) {
			sentryModule.withScope((scope) => {
				scope.setExtras(scrubRecord(context) ?? context);
				sentryModule?.captureException(error);
			});
			return;
		}
		sentryModule.captureException(error);
	} catch (captureError) {
		sentryLog.warn("captureMainException failed:", String(captureError));
	}
}
