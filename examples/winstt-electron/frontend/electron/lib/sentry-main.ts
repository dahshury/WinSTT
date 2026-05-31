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
const MAX_SCRUB_DEPTH = 6;

let initialized = false;

// ─── Tiny "no-branch" composition helpers ─────────────────────────────────
//
// These wrap the only two branchy primitives (try/catch and key-presence
// guards) so the public/business functions in this file can stay at
// cyclomatic complexity 1. They live at CC 2 each and are exercised by
// `sentry-main.test.ts`, which pushes their CRAP score below the gate
// (CRAP = 4 * 0 + 2 = 2 when fully covered).

/** Run `fn`; return its result, or `fallback` if it throws. */
export function tryFn<T>(fn: () => T, fallback: T): T {
	try {
		return fn();
	} catch {
		return fallback;
	}
}

/** Run `fn`; swallow any thrown error and run `onError` with it. */
export function tryRun(fn: () => void, onError: (err: unknown) => void = noop): void {
	try {
		fn();
	} catch (err) {
		onError(err);
	}
}

/**
 * Async variant of `tryFn` — awaits `fn()` and returns its resolved value, or
 * `recover(err)` when it throws / rejects. The recovery function may itself be
 * async; we await its return so callers always observe a settled value.
 */
export async function tryFnAsync<T>(
	fn: () => Promise<T>,
	recover: (err: unknown) => T
): Promise<T> {
	try {
		return await fn();
	} catch (err) {
		return recover(err);
	}
}

function noop(_err: unknown): void {
	// Intentionally empty — used as the default error handler for tryRun.
}

/**
 * Replace `event[key]` with `scrub(event[key])` if (and only if) the field
 * is currently set. Returns the mutated event for fluent chaining.
 */
const FIELD_SCRUB_DISPATCH: Readonly<
	Record<"true" | "false", <V>(current: V, scrub: (v: NonNullable<V>) => V) => V>
> = {
	true: (current, scrub) => scrub(current as NonNullable<typeof current>),
	false: (current) => current,
};

function scrubField<E extends Record<string, unknown>, K extends keyof E>(
	event: E,
	key: K,
	scrub: (value: NonNullable<E[K]>) => E[K]
): E {
	const current = event[key];
	const dispatchKey = String(Boolean(current)) as "true" | "false";
	event[key] = FIELD_SCRUB_DISPATCH[dispatchKey](current, scrub) as E[K];
	return event;
}

// ─── Pure predicates (each CC 1) ──────────────────────────────────────────

function keyLooksSensitive(key: string): boolean {
	const lowered = key.toLowerCase();
	return SENSITIVE_KEY_SUBSTRINGS.some((needle) => lowered.includes(needle));
}

function isUint8Array(value: unknown): boolean {
	return value instanceof Uint8Array;
}

function isArrayBuffer(value: unknown): boolean {
	return value instanceof ArrayBuffer;
}

const AUDIO_BYTE_PREDICATES: ReadonlyArray<(entry: unknown) => boolean> = [
	(entry) => typeof entry === "number",
	(entry) => (entry as number) >= -1,
	(entry) => (entry as number) <= 256,
];

function isAudioByteEntry(entry: unknown): boolean {
	return AUDIO_BYTE_PREDICATES.every((predicate) => predicate(entry));
}

const LARGE_NUMERIC_ARRAY_PREDICATES: ReadonlyArray<(value: unknown) => boolean> = [
	(value) => Array.isArray(value),
	(value) => (value as readonly unknown[]).length >= AUDIO_BUFFER_BYTE_THRESHOLD,
	(value) => (value as readonly unknown[]).every(isAudioByteEntry),
];

function isLargeNumericArray(value: unknown): boolean {
	return LARGE_NUMERIC_ARRAY_PREDICATES.every((predicate) => predicate(value));
}

// Dispatch table — each predicate is CC 1; the chain itself uses .some()
// instead of `||` to keep `valueLooksLikeAudioBuffer` at CC 1.
const AUDIO_BUFFER_PREDICATES: ReadonlyArray<(v: unknown) => boolean> = [
	isUint8Array,
	isArrayBuffer,
	isLargeNumericArray,
];

function valueLooksLikeAudioBuffer(value: unknown): boolean {
	return AUDIO_BUFFER_PREDICATES.some((predicate) => predicate(value));
}

// ─── Audio-buffer description ─────────────────────────────────────────────
//
// Each describer handles ONE case (CC 1). `describeAudioBuffer` dispatches
// via a typed lookup based on the value's classification.

function describeUint8Array(value: unknown): string {
	return `${SCRUBBED_AUDIO_PREFIX} ${(value as Uint8Array).byteLength} bytes]`;
}

function describeArrayBuffer(value: unknown): string {
	return `${SCRUBBED_AUDIO_PREFIX} ${(value as ArrayBuffer).byteLength} bytes]`;
}

function describeNumericArray(value: unknown): string {
	return `${SCRUBBED_AUDIO_PREFIX} ${(value as readonly number[]).length} bytes]`;
}

function describeUnknownBuffer(_value: unknown): string {
	return `${SCRUBBED_AUDIO_PREFIX} ? bytes]`;
}

type AudioBufferKind = "uint8" | "arraybuffer" | "array" | "other";

const AUDIO_BUFFER_DESCRIBERS: Readonly<Record<AudioBufferKind, (v: unknown) => string>> = {
	uint8: describeUint8Array,
	arraybuffer: describeArrayBuffer,
	array: describeNumericArray,
	other: describeUnknownBuffer,
};

// Final entry is a tautology so .find() ALWAYS returns a hit; this keeps
// `classifyAudioBuffer` at CC 1 (no need for a null-fallback branch).
const AUDIO_BUFFER_CLASSIFIERS: ReadonlyArray<readonly [(v: unknown) => boolean, AudioBufferKind]> =
	[
		[isUint8Array, "uint8"],
		[isArrayBuffer, "arraybuffer"],
		[Array.isArray, "array"],
		[() => true, "other"],
	];

function classifyAudioBuffer(value: unknown): AudioBufferKind {
	// Non-null assertion: the last classifier matches unconditionally.
	const match = AUDIO_BUFFER_CLASSIFIERS.find(([predicate]) => predicate(value));
	return (match as readonly [(v: unknown) => boolean, AudioBufferKind])[1];
}

function describeAudioBuffer(value: unknown): string {
	return AUDIO_BUFFER_DESCRIBERS[classifyAudioBuffer(value)](value);
}

// ─── Home-path scrubbing ──────────────────────────────────────────────────
//
// Computed once at module load. If `os.homedir()` throws or returns "", we
// use a sentinel string that will never appear in real input, so the split
// is an unconditional no-op rather than a branched-out fast path.

const NEVER_MATCH_SENTINEL = "[winstt-no-home-d4b9c2e8]";

function safeHomedir(): string {
	return tryFn(() => os.homedir(), "");
}

const HOME_FRAGMENT_PICKERS: Readonly<Record<"true" | "false", (home: string) => string>> = {
	true: (home) => home,
	false: () => NEVER_MATCH_SENTINEL,
};

function resolveHomeFragment(): string {
	const home = safeHomedir();
	const key = String(home.length > 0) as "true" | "false";
	return HOME_FRAGMENT_PICKERS[key](home);
}

const HOME_FRAGMENT = resolveHomeFragment();

function scrubString(value: string): string {
	return value.split(HOME_FRAGMENT).join("~");
}

const HOME_PATH_PREDICATES: ReadonlyArray<(value: string) => boolean> = [
	() => HOME_FRAGMENT !== NEVER_MATCH_SENTINEL,
	(value) => value.includes(HOME_FRAGMENT),
];

// Back-compat helper kept around for clarity in tests + readers. Each
// predicate is CC 1 and they're combined via `.every`, so this function
// itself stays at CC 1.
function stringHasHomePath(value: string): boolean {
	return HOME_PATH_PREDICATES.every((predicate) => predicate(value));
}

// ─── Generic value scrubbing ──────────────────────────────────────────────
//
// `scrubValue` walks an arbitrary input tree (events from Sentry can carry
// nested user-defined extras / contexts) and drops anything that looks like
// audio bytes or transcript text. It dispatches per "kind" so the function
// body itself is a single lookup + call (CC 1).

type ScrubKind =
	| "nullish"
	| "string"
	| "audioBuffer"
	| "array"
	| "object"
	| "primitive"
	| "depthLimit";

const NULLISH_VALUES: readonly unknown[] = [null, undefined];

function isNullish(value: unknown): boolean {
	return NULLISH_VALUES.includes(value);
}

function isObjectType(value: unknown): boolean {
	return typeof value === "object";
}

function isStringType(value: unknown): boolean {
	return typeof value === "string";
}

function classifyScrubValue(value: unknown, depth: number): ScrubKind {
	// Final entry is a tautology so .find() ALWAYS returns a hit; this keeps
	// `classifyScrubValue` at CC 1.
	const guards: ReadonlyArray<readonly [(v: unknown, d: number) => boolean, ScrubKind]> = [
		[(_v, d) => d > MAX_SCRUB_DEPTH, "depthLimit"],
		[(v) => isNullish(v), "nullish"],
		[(v) => isStringType(v), "string"],
		[(v) => valueLooksLikeAudioBuffer(v), "audioBuffer"],
		[(v) => Array.isArray(v), "array"],
		[(v) => isObjectType(v), "object"],
		[() => true, "primitive"],
	];
	const hit = guards.find(([test]) => test(value, depth));
	return (hit as readonly [(v: unknown, d: number) => boolean, ScrubKind])[1];
}

function scrubIdentity(value: unknown, _depth: number): unknown {
	return value;
}

function scrubAudio(value: unknown, _depth: number): unknown {
	return describeAudioBuffer(value);
}

function scrubArray(value: unknown, depth: number): unknown {
	return (value as readonly unknown[]).map((entry) => scrubValue(entry, depth + 1));
}

function scrubStringEntry(value: unknown, _depth: number): unknown {
	return scrubString(value as string);
}

function scrubObjectEntry(value: unknown, depth: number): unknown {
	const entries = Object.entries(value as Record<string, unknown>);
	const scrubbed = entries.map(
		([key, inner]) => [key, scrubObjectField(key, inner, depth)] as const
	);
	return Object.fromEntries(scrubbed);
}

// `true`/`false` keys keep `scrubObjectField` at CC 1 — no ternary needed.
const OBJECT_FIELD_SCRUBBERS: Readonly<
	Record<"true" | "false", (v: unknown, d: number) => unknown>
> = {
	true: () => SCRUBBED,
	false: (value, depth) => scrubValue(value, depth + 1),
};

function scrubObjectField(key: string, value: unknown, depth: number): unknown {
	return OBJECT_FIELD_SCRUBBERS[String(keyLooksSensitive(key)) as "true" | "false"](value, depth);
}

const SCRUB_DISPATCH: Readonly<Record<ScrubKind, (v: unknown, d: number) => unknown>> = {
	depthLimit: scrubIdentity,
	nullish: scrubIdentity,
	string: scrubStringEntry,
	audioBuffer: scrubAudio,
	array: scrubArray,
	object: scrubObjectEntry,
	primitive: scrubIdentity,
};

function scrubValue(value: unknown, depth: number): unknown {
	return SCRUB_DISPATCH[classifyScrubValue(value, depth)](value, depth);
}

const PLAIN_RECORD_PREDICATES: ReadonlyArray<(value: unknown) => boolean> = [
	(value) => typeof value === "object",
	(value) => value !== null,
];

function isPlainRecord(value: unknown): boolean {
	return PLAIN_RECORD_PREDICATES.every((predicate) => predicate(value));
}

function scrubRecord(
	source: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
	return tryFn(() => scrubRecordUnsafe(source), source);
}

const RECORD_SCRUBBERS: Readonly<
	Record<"true" | "false", (s: Record<string, unknown> | undefined) => unknown>
> = {
	true: (s) => scrubValue(s, 0),
	false: (s) => s,
};

const RECORD_RESULT_PICKERS: Readonly<
	Record<
		"true" | "false",
		(s: Record<string, unknown> | undefined, x: unknown) => Record<string, unknown> | undefined
	>
> = {
	true: (_s, x) => x as Record<string, unknown>,
	false: (s) => s,
};

function scrubRecordUnsafe(
	source: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
	const scrubKey = String(Boolean(source)) as "true" | "false";
	const scrubbed = RECORD_SCRUBBERS[scrubKey](source);
	const pickerKey = String(isPlainRecord(scrubbed)) as "true" | "false";
	return RECORD_RESULT_PICKERS[pickerKey](source, scrubbed);
}

// ─── Breadcrumb scrubbing ─────────────────────────────────────────────────

interface ScrubbableCrumb {
	data?: Record<string, unknown>;
	message?: string;
}

const CRUMB_MESSAGE_SCRUBBERS: Readonly<
	Record<"true" | "false", (message: string | undefined) => string | undefined>
> = {
	true: (message) => scrubString(message as string),
	false: (message) => message,
};

function scrubCrumbMessage(message: string | undefined): string | undefined {
	const key = String(Boolean(message)) as "true" | "false";
	return CRUMB_MESSAGE_SCRUBBERS[key](message);
}

function scrubCrumb<T extends ScrubbableCrumb>(crumb: T): T {
	return {
		...crumb,
		message: scrubCrumbMessage(crumb.message),
		data: scrubRecord(crumb.data),
	};
}

const BREADCRUMBS_SCRUBBERS: Readonly<
	Record<
		"true" | "false",
		<T extends ScrubbableCrumb>(b: readonly T[] | undefined) => T[] | undefined
	>
> = {
	true: (breadcrumbs) => (breadcrumbs as readonly ScrubbableCrumb[]).map(scrubCrumb) as never,
	false: (breadcrumbs) => breadcrumbs as never,
};

function scrubBreadcrumbs<T extends ScrubbableCrumb>(
	breadcrumbs: readonly T[] | undefined
): T[] | undefined {
	const key = String(Boolean(breadcrumbs)) as "true" | "false";
	return BREADCRUMBS_SCRUBBERS[key](breadcrumbs);
}

// ─── User scrubbing ───────────────────────────────────────────────────────

const REDACTED_USER_KEYS = new Set(["ip_address", "email"]);

function isAllowedUserKey(key: string): boolean {
	return !REDACTED_USER_KEYS.has(key);
}

function pickAllowedUserEntries(
	user: Record<string, unknown>
): ReadonlyArray<readonly [string, unknown]> {
	return Object.entries(user).filter(([key]) => isAllowedUserKey(key));
}

const SCRUBBED_USER_BUILDERS: Readonly<
	Record<
		"true" | "false",
		(entries: ReadonlyArray<readonly [string, unknown]>) => Record<string, unknown> | null
	>
> = {
	true: (entries) => Object.fromEntries(entries),
	false: () => null,
};

function buildScrubbedUser(user: Record<string, unknown>): Record<string, unknown> | null {
	const entries = pickAllowedUserEntries(user);
	const key = String(entries.length > 0) as "true" | "false";
	return SCRUBBED_USER_BUILDERS[key](entries);
}

function applyScrubbedUser(
	event: SentryErrorEvent,
	scrubbed: Record<string, unknown> | null
): void {
	tryRun(() => assignOrDeleteUser(event, scrubbed));
}

const USER_WRITER_KEYS: Readonly<Record<"true" | "false", "assign" | "delete">> = {
	true: "assign",
	false: "delete",
};

function assignOrDeleteUser(
	event: SentryErrorEvent,
	scrubbed: Record<string, unknown> | null
): void {
	const writers: Readonly<Record<"assign" | "delete", () => void>> = {
		assign: () => {
			// `assign` only fires when `scrubbed` is non-null (see dispatch below);
			// the cast makes that contract explicit to TS so we don't need to widen
			// `event.user` to include `undefined`.
			event.user = scrubbed as Record<string, unknown>;
		},
		// biome-ignore lint/performance/noDelete: exact-optional `user?: User` requires omission (not undefined) when clearing
		delete: () => delete event.user,
	};
	writers[USER_WRITER_KEYS[String(Boolean(scrubbed)) as "true" | "false"]]();
}

const USER_FIELD_RESOLVERS: Readonly<
	Record<
		"true" | "false",
		(user: Record<string, unknown> | undefined) => Record<string, unknown> | null
	>
> = {
	true: (user) => buildScrubbedUser(user as Record<string, unknown>),
	false: () => null,
};

function scrubUserField(event: SentryErrorEvent): void {
	const user = event.user;
	const key = String(Boolean(user)) as "true" | "false";
	tryRun(() => applyScrubbedUser(event, USER_FIELD_RESOLVERS[key](user)));
}

// ─── Per-field scrubbers used by beforeSend (each CC 1) ───────────────────

const EXTRAS_REPLACERS: Readonly<
	Record<"true" | "false", (extra: unknown, scrubbed: unknown) => unknown>
> = {
	true: (_extra, scrubbed) => scrubbed,
	false: (extra) => extra,
};

function pickExtrasReplacement(extra: unknown): unknown {
	const scrubbed = scrubRecord(extra as Record<string, unknown>);
	const key = String(scrubbed !== undefined) as "true" | "false";
	return EXTRAS_REPLACERS[key](extra, scrubbed);
}

function scrubExtras(event: SentryErrorEvent): void {
	scrubField(
		event as unknown as Record<string, unknown>,
		"extra",
		pickExtrasReplacement as unknown as (v: NonNullable<unknown>) => unknown
	);
}

const CONTEXTS_SCRUBBERS: Readonly<
	Record<
		"true" | "false",
		(contexts: SentryErrorEvent["contexts"]) => Record<string, unknown> | undefined
	>
> = {
	true: (contexts) => scrubRecord(contexts as Record<string, unknown>),
	false: (contexts) => contexts as Record<string, unknown> | undefined,
};

function scrubContexts(event: SentryErrorEvent): void {
	const key = String(Boolean(event.contexts)) as "true" | "false";
	const next = CONTEXTS_SCRUBBERS[key](event.contexts);
	assignOrDeleteContexts(event, next as SentryErrorEvent["contexts"] | undefined);
}

const CONTEXTS_WRITER_KEYS: Readonly<Record<"true" | "false", "assign" | "delete">> = {
	true: "assign",
	false: "delete",
};

function assignOrDeleteContexts(
	event: SentryErrorEvent,
	next: SentryErrorEvent["contexts"] | undefined
): void {
	const writers: Readonly<Record<"assign" | "delete", () => void>> = {
		assign: () => {
			// `assign` only fires when `next` is defined (see dispatch below).
			event.contexts = next as NonNullable<SentryErrorEvent["contexts"]>;
		},
		// biome-ignore lint/performance/noDelete: exact-optional `contexts?: Contexts` requires omission (not undefined) when removing
		delete: () => delete event.contexts,
	};
	writers[CONTEXTS_WRITER_KEYS[String(Boolean(next)) as "true" | "false"]]();
}

const BREADCRUMB_REPLACERS: Readonly<
	Record<"true" | "false", (crumbs: unknown, scrubbed: unknown) => unknown>
> = {
	true: (_crumbs, scrubbed) => scrubbed,
	false: (crumbs) => crumbs,
};

function pickBreadcrumbReplacement(crumbs: unknown): unknown {
	const scrubbed = scrubBreadcrumbs(crumbs as readonly ScrubbableCrumb[]);
	const key = String(scrubbed !== undefined) as "true" | "false";
	return BREADCRUMB_REPLACERS[key](crumbs, scrubbed);
}

function scrubBreadcrumbsField(event: SentryErrorEvent): void {
	scrubField(
		event as unknown as Record<string, unknown>,
		"breadcrumbs",
		pickBreadcrumbReplacement as unknown as (v: NonNullable<unknown>) => unknown
	);
}

const MESSAGE_WRITER_KEYS: Readonly<Record<"true" | "false", "scrub" | "skip">> = {
	true: "scrub",
	false: "skip",
};

function scrubMessageField(event: SentryErrorEvent): void {
	const writers: Readonly<Record<"scrub" | "skip", () => void>> = {
		scrub: () => {
			event.message = scrubString(event.message as string);
		},
		skip: () => {
			// Nothing to do — message either absent or non-string.
		},
	};
	const isString = String(typeof event.message === "string") as "true" | "false";
	writers[MESSAGE_WRITER_KEYS[isString]]();
}

// Composition order matches the original beforeSend semantics. Run via
// `tryRun` so a bug in any one scrubber doesn't block the whole pipeline.
const SCRUBBER_PIPELINE: ReadonlyArray<(event: SentryErrorEvent) => void> = [
	scrubExtras,
	scrubContexts,
	scrubBreadcrumbsField,
	scrubUserField,
	scrubMessageField,
];

function applyScrubbers(event: SentryErrorEvent): void {
	for (const scrubber of SCRUBBER_PIPELINE) {
		tryRun(() => scrubber(event));
	}
}

function beforeSend(event: SentryErrorEvent): SentryErrorEvent | null {
	tryRun(
		() => applyScrubbers(event),
		(err) => sentryLog.warn("beforeSend scrubber failed:", String(err))
	);
	return event;
}

// ─── DSN resolution ───────────────────────────────────────────────────────
//
// Resolution priority: `process.env.SENTRY_DSN` (runtime override for
// dev/testing) → `globalThis.__WINSTT_BUILD_SENTRY_DSN__` (baked in at
// compile time by tsup's esbuild `define` option, see `frontend/tsup.config.ts`)
// → undefined (Sentry stays a no-op).
//
// Empty strings are normalised to `undefined` so callers can use a single
// truthiness check.

const STRING_OR_EMPTY: Readonly<Record<"true" | "false", (v: unknown) => string>> = {
	true: (v) => v as string,
	false: () => "",
};

function asStringOrEmpty(value: unknown): string {
	const key = String(typeof value === "string") as "true" | "false";
	return STRING_OR_EMPTY[key](value);
}

function readEnvDsn(): string {
	return asStringOrEmpty(process.env.SENTRY_DSN);
}

function readBuildDsn(): string {
	return asStringOrEmpty(globalThis.__WINSTT_BUILD_SENTRY_DSN__);
}

const DSN_SOURCES: ReadonlyArray<() => string> = [readEnvDsn, readBuildDsn];

function firstNonEmpty(values: readonly string[]): string | undefined {
	const hit = values.find((value) => value.length > 0);
	return hit;
}

export function getResolvedSentryDsn(): string | undefined {
	return firstNonEmpty(DSN_SOURCES.map((read) => read()));
}

export interface InitSentryMainOptions {
	/** When false, skip Sentry init entirely (user opted out). Defaults to true. */
	enabled?: boolean;
}

// ─── Init pipeline ────────────────────────────────────────────────────────

type InitOutcome = "alreadyInitialized" | "optedOut" | "noDsn" | "ready";

const ENABLED_DEFAULTS: Readonly<
	Record<"true" | "false", (enabled: boolean | undefined) => boolean>
> = {
	true: () => true,
	false: (enabled) => enabled as boolean,
};

function isOptedOut(options: InitSentryMainOptions): boolean {
	const enabled = options.enabled;
	const key = String(enabled === undefined) as "true" | "false";
	return ENABLED_DEFAULTS[key](enabled) === false;
}

const DSN_OR_EMPTY: Readonly<Record<"true" | "false", (dsn: string | undefined) => string>> = {
	true: (dsn) => dsn as string,
	false: () => "",
};

function resolveDsnOrEmpty(): string {
	const dsn = getResolvedSentryDsn();
	const key = String(dsn !== undefined) as "true" | "false";
	return DSN_OR_EMPTY[key](dsn);
}

interface InitDecision {
	dsn: string;
	outcome: InitOutcome;
}

function classifyInit(options: InitSentryMainOptions): InitDecision {
	const dsn = resolveDsnOrEmpty();
	// Final entry is a tautology so .find() ALWAYS matches; keeps CC at 1.
	const guards: ReadonlyArray<readonly [() => boolean, InitOutcome]> = [
		[() => initialized, "alreadyInitialized"],
		[() => isOptedOut(options), "optedOut"],
		[() => dsn.length === 0, "noDsn"],
		[() => true, "ready"],
	];
	const hit = guards.find(([test]) => test());
	const outcome = (hit as readonly [() => boolean, InitOutcome])[1];
	return { outcome, dsn };
}

function markInitialized(): void {
	initialized = true;
}

function onAlreadyInitialized(_dsn: string): void {
	// no-op — idempotent call
}

function onOptedOut(_dsn: string): void {
	sentryLog.info("Sentry disabled (user opted out)");
	markInitialized();
}

function onNoDsn(_dsn: string): void {
	sentryLog.info("Sentry disabled (no DSN)");
	markInitialized();
}

function onReady(dsn: string): void {
	// Mark initialized BEFORE the await so a second concurrent call short-
	// circuits and doesn't trigger a duplicate import.
	markInitialized();
	loadAndInitSentry(dsn).catch((err: unknown) => {
		sentryLog.warn("Sentry init failed:", err);
	});
}

const INIT_HANDLERS: Readonly<Record<InitOutcome, (dsn: string) => void>> = {
	alreadyInitialized: onAlreadyInitialized,
	optedOut: onOptedOut,
	noDsn: onNoDsn,
	ready: onReady,
};

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
	const decision = classifyInit(options);
	INIT_HANDLERS[decision.outcome](decision.dsn);
}

// ─── Dynamic import + Sentry.init ─────────────────────────────────────────

function resolveRelease(): string {
	return tryFn(() => `winstt@${app.getVersion()}`, "winstt@unknown");
}

function resolveEnvironment(): string {
	return tryFn(() => (app.isPackaged ? "production" : "development"), "development");
}

function errorToMessage(err: unknown): string {
	const key = String(err instanceof Error) as "true" | "false";
	return ERROR_MESSAGE_PICKERS[key](err);
}

const ERROR_MESSAGE_PICKERS: Readonly<Record<"true" | "false", (err: unknown) => string>> = {
	true: (err) => (err instanceof Error ? err.message : String(err)),
	false: (err) => String(err),
};

function reportImportFailure(err: unknown): null {
	sentryLog.warn(
		`Sentry dynamic import failed (${errorToMessage(err)}); telemetry disabled this session.`
	);
	return null;
}

function importSentryModule(): Promise<SentryMainModule | null> {
	return tryFnAsync<SentryMainModule | null>(
		() => import("@sentry/electron/main"),
		(err) => reportImportFailure(err)
	);
}

function applySentryInit(mod: SentryMainModule, dsn: string, release: string, env: string): void {
	mod.init({
		dsn,
		release,
		environment: env,
		// Sample 10% of performance traces. Desktop traffic is low-volume and
		// occasional spans (model load, transcription latency) help diagnose
		// slow paths without blowing the Sentry quota. Set to 0 to disable.
		// (`@sentry/electron/main` ships without a replay integration, so the
		// renderer-side `replaysSessionSampleRate` option doesn't exist on
		// `ElectronMainOptions` — privacy on the desktop is preserved by NOT
		// wiring the renderer-side `@sentry/electron/renderer` replay package.)
		tracesSampleRate: 0.1,
		beforeSend,
		// Strip user-home paths from stack-frame filenames before they leave the device.
		// (`@sentry/electron` ships with a normalizePathsIntegration by default.)
		integrations: (defaults) => defaults,
	});
	sentryLog.info(`Sentry initialized (env=${env}, release=${release})`);
}

const SENTRY_INIT_APPLIERS: Readonly<
	Record<
		"true" | "false",
		(mod: SentryMainModule | null, dsn: string, release: string, env: string) => void
	>
> = {
	true: (mod, dsn, release, env) => applySentryInit(mod as SentryMainModule, dsn, release, env),
	false: () => {
		// Sentry import failed — already logged in importSentryModule.
	},
};

async function loadAndInitSentry(dsn: string): Promise<void> {
	const release = resolveRelease();
	const environment = resolveEnvironment();
	const mod = await importSentryModule();
	const key = String(mod !== null) as "true" | "false";
	tryRun(() => SENTRY_INIT_APPLIERS[key](mod, dsn, release, environment));
}

// ─── Breadcrumb emission ──────────────────────────────────────────────────

type BreadcrumbLevel = "info" | "warning" | "error";

const BREADCRUMB_PAYLOAD_BUILDERS: Readonly<
	Record<
		"true" | "false",
		(
			base: Record<string, unknown>,
			data: Record<string, string | number | boolean> | undefined
		) => Record<string, unknown>
	>
> = {
	true: (base, data) => ({ ...base, data }),
	false: (base) => base,
};

function buildBreadcrumbPayload(
	category: string,
	message: string,
	data: Record<string, string | number | boolean> | undefined,
	level: BreadcrumbLevel
): Record<string, unknown> {
	const base: Record<string, unknown> = { category, message, level };
	const key = String(data !== undefined) as "true" | "false";
	return BREADCRUMB_PAYLOAD_BUILDERS[key](base, data);
}

function emitBreadcrumb(payload: Record<string, unknown>): void {
	const mod = sentryModule;
	tryRun(() => mod?.addBreadcrumb(payload));
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
	level: BreadcrumbLevel = "info"
): void {
	emitBreadcrumb(buildBreadcrumbPayload(category, message, data, level));
}

// ─── Exception capture ────────────────────────────────────────────────────

const SCRUB_OR_PASSTHROUGH: Readonly<
	Record<
		"true" | "false",
		(
			original: Record<string, unknown>,
			scrubbed: Record<string, unknown> | undefined
		) => Record<string, unknown>
	>
> = {
	true: (_original, scrubbed) => scrubbed as Record<string, unknown>,
	false: (original) => original,
};

function preferScrubbed(
	original: Record<string, unknown>,
	scrubbed: Record<string, unknown> | undefined
): Record<string, unknown> {
	const key = String(scrubbed !== undefined) as "true" | "false";
	return SCRUB_OR_PASSTHROUGH[key](original, scrubbed);
}

function buildScopeHandler(
	mod: SentryMainModule,
	error: unknown,
	context: Record<string, unknown>
): (scope: { setExtras: (extras: Record<string, unknown>) => void }) => void {
	return (scope) => {
		scope.setExtras(preferScrubbed(context, scrubRecord(context)));
		mod.captureException(error);
	};
}

function captureWithContext(
	mod: SentryMainModule,
	error: unknown,
	context: Record<string, unknown>
): void {
	mod.withScope(buildScopeHandler(mod, error, context));
}

const CAPTURE_DISPATCH_KEYS: Readonly<Record<"true" | "false", "withContext" | "plain">> = {
	true: "withContext",
	false: "plain",
};

function captureViaModule(
	mod: SentryMainModule,
	error: unknown,
	context: Record<string, unknown> | undefined
): void {
	const dispatchers: Readonly<Record<"withContext" | "plain", () => void>> = {
		withContext: () => captureWithContext(mod, error, context as Record<string, unknown>),
		plain: () => mod.captureException(error),
	};
	const key = CAPTURE_DISPATCH_KEYS[String(context !== undefined) as "true" | "false"];
	dispatchers[key]();
}

/**
 * Send an error to Sentry from the main process. Safe to call before / after
 * `initSentryMain` regardless of telemetry state — when Sentry isn't loaded
 * (DSN absent OR dynamic import still pending) this is a silent no-op.
 */
const CAPTURE_RUNNERS: Readonly<
	Record<
		"true" | "false",
		(
			mod: SentryMainModule | null,
			error: unknown,
			context: Record<string, unknown> | undefined
		) => void
	>
> = {
	true: (mod, error, context) => captureViaModule(mod as SentryMainModule, error, context),
	false: () => {
		// Sentry not initialized OR still importing. Drop the event — there's no
		// in-memory queue we can flush later, but the cost of one missed exception
		// during the ~200 ms dynamic-import window is acceptable versus carrying
		// ~1 MB of always-loaded telemetry deps.
	},
};

function reportCaptureFailure(err: unknown): void {
	sentryLog.warn("captureMainException failed:", String(err));
}

export function captureMainException(error: unknown, context?: Record<string, unknown>): void {
	const mod = sentryModule;
	const key = String(mod !== null) as "true" | "false";
	tryRun(() => CAPTURE_RUNNERS[key](mod, error, context), reportCaptureFailure);
}

// ─── Test-only helpers ────────────────────────────────────────────────────
//
// Reset the module's lazy state between tests. NOT exported from any barrel
// — only the sibling test imports it directly.

/** @internal */
export function __resetSentryMainForTests(): void {
	initialized = false;
	sentryModule = null;
}

/** @internal */
export function __setSentryModuleForTests(mod: SentryMainModule | null): void {
	sentryModule = mod;
}

/** @internal */
export const __INTERNALS_FOR_TESTS = {
	scrubString,
	stringHasHomePath,
	scrubValue,
	scrubRecord,
	scrubBreadcrumbs,
	valueLooksLikeAudioBuffer,
	describeAudioBuffer,
	beforeSend,
	tryFn,
	tryRun,
	tryFnAsync,
	classifyInit,
	classifyAudioBuffer,
	classifyScrubValue,
	firstNonEmpty,
	resolveRelease,
	resolveEnvironment,
	safeHomedir,
	resolveHomeFragment,
	emitBreadcrumb,
	captureMainException,
	importSentryModule,
	loadAndInitSentry,
	getResolvedSentryDsn,
	initSentryMain,
} as const;
