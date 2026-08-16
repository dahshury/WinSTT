import { z } from "zod";
import { create } from "zustand";
import {
	makeScanErrorState,
	makeScanSuccessState,
} from "@/entities/openrouter-catalog/@x/llm-catalog";
import {
	cancelOllamaModelPull,
	deleteOllamaModel,
	fetchOllamaModels,
	type OllamaModel,
	type OllamaPullProgress,
	onLlmCatalog,
	onOllamaPullProgress,
	pullOllamaModel,
} from "@/shared/api/ipc-client";
import { hasNativeRuntime } from "@/shared/api/native-boundary";
import { OllamaPullProgressStatusSchema } from "@/shared/api/schema.zod";
import { isSameOllamaTag } from "@/shared/lib/ollama-tag";
import { hasTauriRuntime } from "@/shared/lib/tauri-runtime";

export type { OllamaModel };

interface PullState {
	progress: OllamaPullProgress;
	startedAt: number;
}

/**
 * A pull that the user stopped before completion. Ollama keeps the partial
 * blob files on disk; calling {@link LlmCatalogState.resumePull} re-issues
 * /api/pull, which picks up from the existing blobs (or starts fresh if
 * Ollama GC'd them — either way the user ends up with the model).
 *
 * Persisted to localStorage (renderer only) so a paused download still reads as
 * "partial / resume" after the settings window closes — otherwise the partial
 * blobs sit on disk but the UI shows "not installed", which users read as a bug.
 * Stale entries self-correct: a model that actually finished shows as installed
 * (cached wins over partial), and a re-pull resumes from disk either way.
 */
export interface PausedPullState {
	pausedAt: number;
	/** Last known progress before the cancel landed — used to render the
	 *  dimmed progress bar so the user can see "I was at 60% before stopping". */
	progress: OllamaPullProgress;
	/** True when the pull was NOT stopped by the user: the process died
	 *  mid-download (app quit, crash, dev rebuild) or the stream errored
	 *  (daemon restart, network drop). Unlike a user Stop, there is no
	 *  cancelled stream whose straggler frames could resurrect the entry —
	 *  so ANY incoming frame may revive it (see {@link applyActiveProgress}),
	 *  which heals the case where the pull actually survived a webview reload. */
	interrupted?: boolean;
}

const PAUSED_PULLS_STORAGE_KEY = "winstt:ollama-paused-pulls";
/** Mirror of the ACTIVE pull map (model → last progress). A pull that dies
 *  with the process never emits a cancelled/error frame, so without this
 *  mirror it would leave no trace: the next session shows the quant as "not
 *  installed" while gigabytes of resumable partial blobs sit in Ollama's
 *  store. On hydrate, entries fold into `pausedPulls` as `interrupted`. */
const ACTIVE_PULLS_STORAGE_KEY = "winstt:ollama-active-pulls";

// Validate the persisted blob on hydrate — localStorage is user-writable and
// can be left over from an older schema, so a raw `as` cast could smuggle
// malformed entries into the store. Mirrors the `OllamaPullProgress` shape
// (spec/generated/ts/schema.d.ts): required model + status, the rest optional.
const ollamaPullProgressSchema = z.object({
	model: z.string(),
	status: OllamaPullProgressStatusSchema,
	statusText: z.string().optional(),
	digest: z.string().optional(),
	completed: z.number().optional(),
	total: z.number().optional(),
	percent: z.number().optional(),
	error: z.string().optional(),
});

const pausedPullStateSchema = z.object({
	pausedAt: z.number(),
	progress: ollamaPullProgressSchema,
	interrupted: z.boolean().optional(),
});

const pausedPullsSchema = z.record(z.string(), pausedPullStateSchema);

const activePullsSchema = z.record(z.string(), ollamaPullProgressSchema);

/** Gate for all persistence reads/writes: `hasTauriRuntime()` (the synchronously
 *  injected `__TAURI_INTERNALS__`, present from the first renderer module) keeps
 *  module-load reads deterministic and remains false under plain Vite or a
 *  browser preview, so those environments start clean. */
function canUseLocalStorage(): boolean {
	return (
		hasTauriRuntime() && typeof window !== "undefined" && !!window.localStorage
	);
}

function readPersistedRecord<S extends z.ZodTypeAny>(
	key: string,
	schema: S,
): z.infer<S> | undefined {
	if (!canUseLocalStorage()) {
		return undefined;
	}
	try {
		const raw = window.localStorage.getItem(key);
		const parsed = schema.safeParse(raw ? JSON.parse(raw) : null);
		return parsed.success ? parsed.data : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Load the paused-pull map for a fresh renderer, folding in pulls that were
 * ACTIVE when the previous session ended. The process that ran them is gone
 * (app quit, crash, or a dev rebuild) and the daemon stops downloading the
 * moment its client stream drops — so their last persisted progress re-enters
 * the UI as an `interrupted` paused entry: the quant renders "partial N% /
 * Resume" instead of silently reverting to "not installed" while resumable
 * partial blobs sit in Ollama's store.
 *
 * After folding, both keys are rewritten: the merged map becomes the only
 * source of truth under the paused key and the active key is cleared, so a
 * later Discard can't be resurrected by stale active-pull leftovers.
 */
function loadInitialPausedPulls(): Record<string, PausedPullState> {
	// `progress` widens to `OllamaPullProgress` (status is the same enum) — the
	// cast crosses the generated-type ↔ zod boundary, not unchecked input.
	const paused = (readPersistedRecord(
		PAUSED_PULLS_STORAGE_KEY,
		pausedPullsSchema,
	) ?? {}) as Record<string, PausedPullState>;
	const active = (readPersistedRecord(
		ACTIVE_PULLS_STORAGE_KEY,
		activePullsSchema,
	) ?? {}) as Record<string, OllamaPullProgress>;
	const merged = foldInterruptedActivePulls(paused, active);
	if (Object.keys(active).length > 0) {
		persistPausedPulls(merged);
		persistActivePullProgress({});
	}
	return merged;
}

/**
 * Fold last-known ACTIVE pull progress from a dead session into the paused map
 * as `interrupted` entries. An artifact that already has an explicit paused
 * snapshot (any alias spelling) keeps it — the user's Stop carries the real
 * `pausedAt` and its snapshot was taken at the moment the cancel landed.
 */
export function foldInterruptedActivePulls(
	paused: Readonly<Record<string, PausedPullState>>,
	active: Readonly<Record<string, OllamaPullProgress>>,
): Record<string, PausedPullState> {
	const merged: Record<string, PausedPullState> = { ...paused };
	for (const [model, progress] of Object.entries(active)) {
		if (aliasKeys(merged, model).length > 0) {
			continue;
		}
		merged[model] = { pausedAt: Date.now(), progress, interrupted: true };
	}
	return merged;
}

function persistPausedPulls(
	pausedPulls: Record<string, PausedPullState>,
): void {
	if (!canUseLocalStorage()) {
		return;
	}
	try {
		window.localStorage.setItem(
			PAUSED_PULLS_STORAGE_KEY,
			JSON.stringify(pausedPulls),
		);
	} catch {
		// Best-effort hint — ignore quota / serialization failures.
	}
}

function persistActivePullProgress(
	pulls: Readonly<Record<string, { progress: OllamaPullProgress }>>,
): void {
	if (!canUseLocalStorage()) {
		return;
	}
	try {
		const compact: Record<string, OllamaPullProgress> = {};
		for (const [model, entry] of Object.entries(pulls)) {
			compact[model] = entry.progress;
		}
		window.localStorage.setItem(
			ACTIVE_PULLS_STORAGE_KEY,
			JSON.stringify(compact),
		);
	} catch {
		// Best-effort hint — ignore quota / serialization failures.
	}
}

interface LlmCatalogState {
	cancelPull: (model: string) => Promise<void>;
	deleteModel: (
		model: string,
	) => Promise<{ success: boolean; error?: string | undefined }>;
	/** Forget a paused pull from the UI. Doesn't touch disk — the partial
	 *  blobs stay until the next pull either consumes them or Ollama GCs. */
	discardPausedPull: (model: string) => void;
	error: string | null;
	isLoaded: boolean;
	isReachable: boolean;
	isScanning: boolean;
	models: OllamaModel[];
	pausedPulls: Record<string, PausedPullState>;
	pullModel: (
		model: string,
	) => Promise<{ success: boolean; error?: string | undefined }>;
	pulls: Record<string, PullState>;
	resumePull: (
		model: string,
	) => Promise<{ success: boolean; error?: string | undefined }>;
	scanModels: (opts?: { force?: boolean }) => Promise<void>;
	setError: (error: string | null) => void;
	setModels: (models: OllamaModel[]) => void;
	setPullProgress: (progress: OllamaPullProgress) => void;
	setScanning: (scanning: boolean) => void;
}

let pendingScan: Promise<void> | null = null;
let queuedForcedScan = false;

const isTerminalStatus = (status: OllamaPullProgress["status"]): boolean =>
	status === "success" || status === "error" || status === "cancelled";

/** The integer percent the UI actually renders (the badge + the trigger both do
 *  `Math.round(percent)`), or -1 when the frame carries no percent. Used to drop
 *  frames that wouldn't change anything on screen. */
function displayedPullPercent(percent: number | undefined): number {
	if (percent === undefined) {
		return -1;
	}
	return Math.round(Math.max(0, Math.min(100, percent)));
}

/**
 * True when a progress frame would not change anything the UI shows, so the store
 * can drop it WITHOUT notifying subscribers (no re-render).
 *
 * Why this matters: Ollama's `/api/pull` streams many NDJSON frames per second
 * (one per chunk), and the INLINE model-picker re-renders its whole model list on
 * every `pulls` change. Applying every frame pegged the main thread so the
 * maker-rail tabs stopped responding to clicks mid-download. The picker only ever
 * displays a pull's status + its rounded percent, so a same-status frame whose
 * rounded percent is unchanged is a visual no-op. The first frame for a model,
 * any status change, and every terminal frame are NEVER redundant — they always
 * apply — so this collapses a download to ≤~100 re-renders (one per integer
 * percent) instead of thousands, with no timers and no loss of displayed fidelity.
 */
function isRedundantProgressFrame(
	previous: OllamaPullProgress | undefined,
	next: OllamaPullProgress,
): boolean {
	if (
		!previous ||
		isTerminalStatus(next.status) ||
		previous.status !== next.status
	) {
		return false;
	}
	return (
		displayedPullPercent(previous.percent) ===
		displayedPullPercent(next.percent)
	);
}

interface PullSlices {
	pausedPulls: Record<string, PausedPullState>;
	pulls: Record<string, PullState>;
}

/** Drop an entry from a record without mutating the original. */
function withoutKey<V>(
	record: Record<string, V>,
	key: string,
): Record<string, V> {
	const next = { ...record };
	delete next[key];
	return next;
}

/**
 * Every key in `record` that names the same Ollama artifact as `model`.
 * A model can be pulled under several tag spellings at once (`smollm2` vs
 * `smollm2:latest`, or a digest-alias like `gemma4:e2b` vs
 * `gemma4:e2b-it-q4_K_M`) — the daemon runs ONE download but the app tracks
 * one entry (and one streaming request) per spelling. Pause/guard logic must
 * act on the whole identity group, not one exact string, or cancelling one
 * spelling leaves the sibling stream downloading and the badge stuck on
 * "downloading" — the pause button appears to do nothing.
 */
function aliasKeys<V>(record: Record<string, V>, model: string): string[] {
	return Object.keys(record).filter((key) => isSameOllamaTag(key, model));
}

/** Drop every alias of `model` from a record without mutating the original. */
function withoutAliases<V>(
	record: Record<string, V>,
	model: string,
): Record<string, V> {
	const keys = aliasKeys(record, model);
	if (keys.length === 0) {
		return record;
	}
	const next = { ...record };
	for (const key of keys) {
		delete next[key];
	}
	return next;
}

/** Build the next paused-pulls map when a pull stops — snapshot the last known
 *  active progress so the UI can render "I was at 60% before stopping".
 *  `interrupted` marks a stop the user did NOT ask for (stream error, dead
 *  invoke) — those entries may be revived by any later frame. */
function recordPausedSnapshot(
	pausedPulls: Record<string, PausedPullState>,
	model: string,
	progress: OllamaPullProgress,
	interrupted = false,
): Record<string, PausedPullState> {
	const entry: PausedPullState = { progress, pausedAt: Date.now() };
	if (interrupted) {
		entry.interrupted = true;
	}
	return {
		...pausedPulls,
		[model]: entry,
	};
}

function maxOptionalNumber(
	previous: number | undefined,
	next: number | undefined,
): number | undefined {
	if (previous === undefined) {
		return next;
	}
	if (next === undefined) {
		return previous;
	}
	return Math.max(previous, next);
}

function mergePullProgress(
	previous: OllamaPullProgress | undefined,
	next: OllamaPullProgress,
): OllamaPullProgress {
	const merged: OllamaPullProgress = { ...next };
	const percent = maxOptionalNumber(previous?.percent, next.percent);
	const completed = maxOptionalNumber(previous?.completed, next.completed);
	const total = maxOptionalNumber(previous?.total, next.total);
	if (percent !== undefined) {
		merged.percent = percent;
	}
	if (completed !== undefined) {
		merged.completed = completed;
	}
	if (total !== undefined) {
		merged.total = total;
	}
	return merged;
}

function applyStopped(
	slices: PullSlices,
	progress: OllamaPullProgress,
	interrupted: boolean,
): Partial<PullSlices> {
	const existing = slices.pulls[progress.model];
	const nextPulls = withoutKey(slices.pulls, progress.model);
	if (!existing) {
		return { pulls: nextPulls };
	}
	return {
		pulls: nextPulls,
		pausedPulls: recordPausedSnapshot(
			slices.pausedPulls,
			progress.model,
			existing.progress,
			interrupted,
		),
	};
}

/** State transition for terminal success/error — clear the active pull and
 *  any paused state for the same model (partial bytes are consumed or moot).
 *  Alias-wide: a success frame under `smollm2` must also clear a paused
 *  `smollm2:latest` snapshot — same artifact, now fully on disk. */
function applyTerminalClear(
	slices: PullSlices,
	model: string,
): Partial<PullSlices> {
	return {
		pulls: withoutAliases(slices.pulls, model),
		pausedPulls: withoutAliases(slices.pausedPulls, model),
	};
}

/**
 * True for the backend's LEADING pull frame — `ollama_pull` (llm.rs) emits
 * `{status:"pulling", statusText:"starting"}` exactly once when an invoke
 * begins streaming. It is the one frame that can distinguish "a NEW/RESUMED
 * pull just started (possibly in another window)" from "a straggler frame of
 * the stream the user just paused" (stragglers are `downloading` / per-digest
 * `pulling <sha>` frames, never the leading one).
 */
function isLeadingPullFrame(progress: OllamaPullProgress): boolean {
	return progress.status === "pulling" && progress.statusText === "starting";
}

/** State transition for any non-terminal progress — upsert the active pull
 *  entry only when the pull is active or resume-seeded; late frames after Stop
 *  stay visually paused. */
function applyActiveProgress(
	slices: PullSlices,
	progress: OllamaPullProgress,
): Partial<PullSlices> {
	const existing = slices.pulls[progress.model];
	const pausedAliasKeys = aliasKeys(slices.pausedPulls, progress.model);
	// Alias-wide paused check: a late frame from a sibling stream of the same
	// artifact (`smollm2` vs `smollm2:latest`) must not resurrect a pull the
	// user just paused. The LEADING frame is exempt: it announces a fresh
	// invoke, so a resume clicked in the detached picker revives the paused
	// entry in EVERY window — otherwise the settings trigger kept showing the
	// model as paused and never rendered the re-download's progress.
	// `interrupted` snapshots are also revivable by ANY frame: they were
	// created by hydration or a stream error, not by a user Stop, so no
	// cancelled stream exists whose stragglers could resurrect them — a frame
	// arriving means a pull is genuinely streaming (e.g. it survived a webview
	// hot-reload while this window's store started fresh).
	const everyPausedAliasInterrupted = pausedAliasKeys.every(
		(key) => slices.pausedPulls[key]?.interrupted === true,
	);
	if (
		!existing &&
		pausedAliasKeys.length > 0 &&
		!everyPausedAliasInterrupted &&
		!isLeadingPullFrame(progress)
	) {
		return {};
	}
	// Seed a revived pull from the paused snapshot (via mergePullProgress's
	// max) so the badge/trigger resumes at the paused percent instead of
	// flashing 0% until the first byte-carrying frame arrives.
	const pausedKey = pausedAliasKeys[0];
	const revivedFrom =
		!existing && pausedKey
			? slices.pausedPulls[pausedKey]?.progress
			: undefined;
	const nextPulls = {
		...slices.pulls,
		[progress.model]: {
			progress: mergePullProgress(existing?.progress ?? revivedFrom, progress),
			startedAt: existing?.startedAt ?? Date.now(),
		},
	};
	if (pausedAliasKeys.length === 0) {
		return { pulls: nextPulls };
	}
	return {
		pulls: nextPulls,
		pausedPulls: withoutAliases(slices.pausedPulls, progress.model),
	};
}

/** Pick the right state transition for a given progress frame. */
function nextPullSlices(
	slices: PullSlices,
	progress: OllamaPullProgress,
): Partial<PullSlices> {
	if (!isTerminalStatus(progress.status)) {
		return applyActiveProgress(slices, progress);
	}
	if (progress.status === "success") {
		return applyTerminalClear(slices, progress.model);
	}
	// cancelled = user Stop; error = the stream died on its own (daemon
	// restart, network drop, dev rebuild racing the pull). Both keep a
	// resumable snapshot — error used to terminal-clear pausedPulls too, so a
	// mid-download failure silently reverted the quant to "not installed"
	// while its partial blobs stayed resumable on disk.
	return applyStopped(slices, progress, progress.status === "error");
}

/** Build the seed progress for a fresh or resumed pull — when resuming from
 *  a paused entry, preserve the last known percent so the bar doesn't flash
 *  back to 0% before the server's first progress frame arrives. */
function seedPullProgress(
	model: string,
	paused: PausedPullState | undefined,
): OllamaPullProgress {
	if (paused) {
		// `model` overrides the snapshot's spelling — a resume can be issued
		// under a different alias than the one that paused.
		return {
			...paused.progress,
			model,
			status: "pulling",
			statusText: "resuming",
		};
	}
	return { model, status: "pulling", statusText: "starting" };
}

/** State delta to apply when starting a pull — installs the seeded entry in
 *  `pulls` and clears any paused entry being resumed. */
function buildStartPullState(
	slices: PullSlices,
	model: string,
): Partial<PullSlices> {
	// Resume may name a different spelling than the one that paused
	// (`smollm2:latest` paused, resume issued as `smollm2`) — seed from any
	// aliasing snapshot and clear the whole identity group.
	const pausedKey =
		slices.pausedPulls[model] === undefined
			? aliasKeys(slices.pausedPulls, model)[0]
			: model;
	const paused = pausedKey ? slices.pausedPulls[pausedKey] : undefined;
	const seededProgress = seedPullProgress(model, paused);
	const nextPulls = {
		...slices.pulls,
		[model]: { progress: seededProgress, startedAt: Date.now() },
	};
	if (!paused) {
		return { pulls: nextPulls };
	}
	return {
		pulls: nextPulls,
		pausedPulls: withoutAliases(slices.pausedPulls, model),
	};
}

export const useLlmCatalogStore = create<LlmCatalogState>()((set, get) => ({
	// Stryker disable next-line ArrayDeclaration: equivalent — `setModels` (the
	// only public mutation) overwrites this initial array, and tests reset state
	// via `setState({ models: [] })` before reading it.
	models: [],
	// Stryker disable next-line BooleanLiteral: equivalent — `setModels` and
	// `setError` (the only public mutation paths) both override `isLoaded` to
	// true on first call, so the initial value is overwritten before any test
	// reads it through observed behavior.
	isLoaded: false,
	isScanning: false,
	// Stryker disable next-line BooleanLiteral: equivalent — every scanModels()
	// path overwrites `isReachable` based on the IPC result before any test
	// observes it, so the initial value is unobservable.
	isReachable: false,
	error: null,
	pulls: {},
	pausedPulls: loadInitialPausedPulls(),
	setModels: (models) => set({ models, isLoaded: true, error: null }),
	setScanning: (scanning) => set({ isScanning: scanning }),
	setError: (error) => set({ error, isLoaded: true }),
	setPullProgress: (progress) => {
		const { pulls, pausedPulls } = get();
		// Drop frames that wouldn't change anything on screen so a high-frequency
		// pull doesn't re-render the full picker list on every NDJSON chunk (which
		// froze the maker-rail tabs mid-download).
		if (isRedundantProgressFrame(pulls[progress.model]?.progress, progress)) {
			return;
		}
		set(nextPullSlices({ pulls, pausedPulls }, progress));
	},
	scanModels: async (opts) => {
		if (pendingScan) {
			if (opts?.force) {
				queuedForcedScan = true;
			}
			await pendingScan;
			return;
		}
		if (get().isScanning) {
			return;
		}
		const runNextQueuedScan = (): Promise<void> => {
			queuedForcedScan = false;
			set({ isScanning: true, error: null });
			return fetchOllamaModels()
				.then((result) => {
					set(makeScanSuccessState(result));
				})
				.catch((err: unknown) => {
					set(makeScanErrorState(err));
				})
				.then(() => {
					if (queuedForcedScan) {
						return runNextQueuedScan();
					}
					return undefined;
				});
		};
		pendingScan = runNextQueuedScan().finally(() => {
			pendingScan = null;
		});
		await pendingScan;
	},
	pullModel: async (model) => {
		const { pulls, pausedPulls } = get();
		// Alias-wide guard: `smollm2` and `smollm2:latest` are one download at
		// the daemon — starting both gives two streaming requests the pause
		// button can only stop one of (the badge keeps showing the survivor).
		if (aliasKeys(pulls, model).length > 0) {
			return { success: false, error: "Already pulling" };
		}
		set(buildStartPullState({ pulls, pausedPulls }, model));
		const result = await pullOllamaModel(model);
		if (result.success) {
			await get().scanModels();
		} else {
			// The invoke can fail WITHOUT a terminal frame (llm.rs returns early on
			// window-authorization / name-validation rejects) — without this the
			// seeded entry would spin as "starting" forever. When an error frame
			// already moved the entry to pausedPulls this is a no-op. Progress made
			// before the failure stays resumable as an interrupted snapshot.
			const current = get();
			const entry = current.pulls[model];
			if (entry) {
				const cleanup: Partial<PullSlices> = {
					pulls: withoutKey(current.pulls, model),
				};
				if (entry.progress.percent !== undefined) {
					cleanup.pausedPulls = recordPausedSnapshot(
						current.pausedPulls,
						model,
						entry.progress,
						true,
					);
				}
				set(cleanup);
			}
		}
		return { success: result.success, error: result.error };
	},
	cancelPull: async (model) => {
		// Optimistically move the active pull into pausedPulls so the badge flips to
		// "partial" immediately. Ollama doesn't reliably emit a trailing "cancelled"
		// progress frame on abort, so we can't depend on `applyCancelled` firing.
		//
		// Alias-wide: the same artifact can have several streaming pulls under
		// different spellings (`smollm2` + `smollm2:latest`). Each backend loop
		// polls the cancel flag under ITS exact invoked name, so every alias key
		// must be cancelled — stopping only one leaves the sibling stream (and
		// the daemon download) running while the badge stays on "downloading".
		const { pulls, pausedPulls } = get();
		const keys = aliasKeys(pulls, model);
		if (keys.length > 0) {
			let nextPulls = pulls;
			let nextPaused = pausedPulls;
			for (const key of keys) {
				const existing = nextPulls[key];
				if (existing) {
					nextPulls = withoutKey(nextPulls, key);
					nextPaused = recordPausedSnapshot(nextPaused, key, existing.progress);
				}
			}
			set({ pulls: nextPulls, pausedPulls: nextPaused });
		}
		const cancelNames = keys.length > 0 ? keys : [model];
		await Promise.all(cancelNames.map((name) => cancelOllamaModelPull(name)));
	},
	/**
	 * Resume a previously-paused pull. Semantically distinct from `pullModel`
	 * (we display a "Resume" button instead of "Install"), but functionally
	 * just re-issues /api/pull — Ollama handles continuity with on-disk
	 * partial blobs automatically. The paused state is cleared as soon as
	 * the first non-terminal progress arrives (see `setPullProgress`).
	 */
	resumePull: async (model) => get().pullModel(model),
	discardPausedPull: (model) => {
		const { pausedPulls } = get();
		if (!pausedPulls[model]) {
			return;
		}
		set({ pausedPulls: withoutKey(pausedPulls, model) });
	},
	deleteModel: async (model) => {
		const result = await deleteOllamaModel(model);
		if (result.success) {
			await get().scanModels({ force: true });
		}
		return { success: result.success, error: result.error };
	},
}));

// Native-runtime guard — under bun:test, the runtime is mocked and remains
// unavailable here, so the body is skipped regardless of the conditional outcome.
// Observable test behavior is identical with or without this branch, hence
// every mutator on this if-statement is equivalent.
// Stryker disable next-line ConditionalExpression,LogicalOperator,EqualityOperator,StringLiteral,BlockStatement
if (hasNativeRuntime()) {
	// Stryker disable next-line ArrowFunction
	onLlmCatalog((models) => useLlmCatalogStore.getState().setModels(models));
	// Stryker disable next-line ArrowFunction
	onOllamaPullProgress((progress) =>
		useLlmCatalogStore.getState().setPullProgress(progress),
	);
	// Persist paused pulls when they change, so partial downloads survive a
	// settings-window close — and mirror the ACTIVE pull map so a pull that dies
	// WITH the process (app quit, crash, dev rebuild: no cancelled/error frame
	// ever arrives) re-enters the next session as an interrupted paused entry
	// instead of vanishing while its partial blobs sit on disk. Both are
	// change-detected by reference; `pulls` only gets a new reference about once
	// per integer percent (see isRedundantProgressFrame), so the mirror costs
	// ~100 writes per download, not one per NDJSON chunk.
	let lastPaused = useLlmCatalogStore.getState().pausedPulls;
	let lastPulls = useLlmCatalogStore.getState().pulls;
	useLlmCatalogStore.subscribe((state) => {
		if (state.pausedPulls !== lastPaused) {
			lastPaused = state.pausedPulls;
			persistPausedPulls(state.pausedPulls);
		}
		if (state.pulls !== lastPulls) {
			lastPulls = state.pulls;
			persistActivePullProgress(state.pulls);
		}
	});
}
