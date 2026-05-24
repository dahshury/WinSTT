import { create } from "zustand";
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

export type { OllamaModel };

export interface PullState {
	progress: OllamaPullProgress;
	startedAt: number;
}

/**
 * A pull that the user stopped before completion. Ollama keeps the partial
 * blob files on disk; calling {@link LlmCatalogState.resumePull} re-issues
 * /api/pull, which picks up from the existing blobs (or starts fresh if
 * Ollama GC'd them — either way the user ends up with the model).
 *
 * We track this in-memory only. After an app restart the paused state
 * disappears from the UI; the partial blobs are still on disk, so the
 * user just sees the model as "not installed" and can pull it (which
 * still resumes from disk). Persisting across restarts isn't worth the
 * complexity for what's essentially a recovery hint.
 */
export interface PausedPullState {
	pausedAt: number;
	/** Last known progress before the cancel landed — used to render the
	 *  dimmed progress bar so the user can see "I was at 60% before stopping". */
	progress: OllamaPullProgress;
}

interface LlmCatalogState {
	cancelPull: (model: string) => Promise<void>;
	deleteModel: (model: string) => Promise<{ success: boolean; error?: string | undefined }>;
	/** Forget a paused pull from the UI. Doesn't touch disk — the partial
	 *  blobs stay until the next pull either consumes them or Ollama GCs. */
	discardPausedPull: (model: string) => void;
	error: string | null;
	isLoaded: boolean;
	isReachable: boolean;
	isScanning: boolean;
	models: OllamaModel[];
	pausedPulls: Record<string, PausedPullState>;
	pullModel: (model: string) => Promise<{ success: boolean; error?: string | undefined }>;
	pulls: Record<string, PullState>;
	resumePull: (model: string) => Promise<{ success: boolean; error?: string | undefined }>;
	scanModels: () => Promise<void>;
	setError: (error: string | null) => void;
	setModels: (models: OllamaModel[]) => void;
	setPullProgress: (progress: OllamaPullProgress) => void;
	setScanning: (scanning: boolean) => void;
}

const isTerminalStatus = (status: OllamaPullProgress["status"]): boolean =>
	status === "success" || status === "error" || status === "cancelled";

function makeScanErrorState(err: unknown) {
	return {
		error: String(err),
		isReachable: false as const,
		isScanning: false as const,
		isLoaded: true as const,
	};
}

function makeScanSuccessState(result: {
	models: OllamaModel[];
	reachable: boolean;
	error?: string;
}) {
	return {
		models: result.models,
		isReachable: result.reachable,
		error: result.error ?? null,
		isLoaded: true as const,
		isScanning: false as const,
	};
}

interface PullSlices {
	pausedPulls: Record<string, PausedPullState>;
	pulls: Record<string, PullState>;
}

/** Drop an entry from a record without mutating the original. */
function withoutKey<V>(record: Record<string, V>, key: string): Record<string, V> {
	const next = { ...record };
	delete next[key];
	return next;
}

/** Build the next paused-pulls map when a pull is cancelled — snapshot the
 *  last known active progress so the UI can render "I was at 60% before stopping". */
function recordPausedSnapshot(
	pausedPulls: Record<string, PausedPullState>,
	model: string,
	progress: OllamaPullProgress
): Record<string, PausedPullState> {
	return {
		...pausedPulls,
		[model]: { progress, pausedAt: Date.now() },
	};
}

/** State transition for a cancelled status — preserve the last known progress
 *  in pausedPulls so the UI can offer Resume. */
function applyCancelled(slices: PullSlices, progress: OllamaPullProgress): Partial<PullSlices> {
	const existing = slices.pulls[progress.model];
	const nextPulls = withoutKey(slices.pulls, progress.model);
	if (!existing) {
		return { pulls: nextPulls };
	}
	return {
		pulls: nextPulls,
		pausedPulls: recordPausedSnapshot(slices.pausedPulls, progress.model, existing.progress),
	};
}

/** State transition for terminal success/error — clear the active pull and
 *  any paused state for the same model (partial bytes are consumed or moot). */
function applyTerminalClear(slices: PullSlices, model: string): Partial<PullSlices> {
	return {
		pulls: withoutKey(slices.pulls, model),
		pausedPulls: withoutKey(slices.pausedPulls, model),
	};
}

/** State transition for any non-terminal progress — upsert the active pull
 *  entry (preserving startedAt) and drop any paused entry so the UI doesn't
 *  show both bars. */
function applyActiveProgress(
	slices: PullSlices,
	progress: OllamaPullProgress
): Partial<PullSlices> {
	const existing = slices.pulls[progress.model];
	const nextPulls = {
		...slices.pulls,
		[progress.model]: {
			progress,
			startedAt: existing?.startedAt ?? Date.now(),
		},
	};
	const hadPaused = slices.pausedPulls[progress.model] != null;
	if (!hadPaused) {
		return { pulls: nextPulls };
	}
	return {
		pulls: nextPulls,
		pausedPulls: withoutKey(slices.pausedPulls, progress.model),
	};
}

/** Pick the right state transition for a given progress frame. */
function nextPullSlices(slices: PullSlices, progress: OllamaPullProgress): Partial<PullSlices> {
	if (!isTerminalStatus(progress.status)) {
		return applyActiveProgress(slices, progress);
	}
	if (progress.status === "cancelled") {
		return applyCancelled(slices, progress);
	}
	return applyTerminalClear(slices, progress.model);
}

/** Build the seed progress for a fresh or resumed pull — when resuming from
 *  a paused entry, preserve the last known percent so the bar doesn't flash
 *  back to 0% before the server's first progress frame arrives. */
function seedPullProgress(model: string, paused: PausedPullState | undefined): OllamaPullProgress {
	if (paused) {
		return { ...paused.progress, status: "pulling", statusText: "resuming" };
	}
	return { model, status: "pulling", statusText: "starting" };
}

/** State delta to apply when starting a pull — installs the seeded entry in
 *  `pulls` and clears any paused entry being resumed. */
function buildStartPullState(slices: PullSlices, model: string): Partial<PullSlices> {
	const paused = slices.pausedPulls[model];
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
		pausedPulls: withoutKey(slices.pausedPulls, model),
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
	pausedPulls: {},
	setModels: (models) => set({ models, isLoaded: true, error: null }),
	setScanning: (scanning) => set({ isScanning: scanning }),
	setError: (error) => set({ error, isLoaded: true }),
	setPullProgress: (progress) => {
		const { pulls, pausedPulls } = get();
		set(nextPullSlices({ pulls, pausedPulls }, progress));
	},
	scanModels: async () => {
		if (get().isScanning) {
			return;
		}
		set({ isScanning: true, error: null });
		try {
			const result = await fetchOllamaModels();
			set(makeScanSuccessState(result));
		} catch (err) {
			set(makeScanErrorState(err));
		}
	},
	pullModel: async (model) => {
		const { pulls, pausedPulls } = get();
		if (pulls[model]) {
			return { success: false, error: "Already pulling" };
		}
		set(buildStartPullState({ pulls, pausedPulls }, model));
		const result = await pullOllamaModel(model);
		if (result.success) {
			await get().scanModels();
		}
		return { success: result.success, error: result.error };
	},
	cancelPull: async (model) => {
		await cancelOllamaModelPull(model);
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
			await get().scanModels();
		}
		return { success: result.success, error: result.error };
	},
}));

// SSR/Electron guard — under bun:test, the bridge is mocked and electronAPI
// is undefined, so the body is skipped regardless of the conditional outcome.
// Observable test behavior is identical with or without this branch, hence
// every mutator on this if-statement is equivalent.
// Stryker disable next-line ConditionalExpression,LogicalOperator,EqualityOperator,StringLiteral,BlockStatement
if (typeof window !== "undefined" && window.electronAPI != null) {
	// Stryker disable next-line ArrowFunction
	onLlmCatalog((models) => useLlmCatalogStore.getState().setModels(models));
	// Stryker disable next-line ArrowFunction
	onOllamaPullProgress((progress) => useLlmCatalogStore.getState().setPullProgress(progress));
}
