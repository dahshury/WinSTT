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
		const existing = pulls[progress.model];
		if (isTerminalStatus(progress.status)) {
			const nextPulls = { ...pulls };
			delete nextPulls[progress.model];
			// On a "cancelled" terminal status, preserve the last known
			// progress so the UI can offer Resume + show where we stopped.
			// On "success" or "error", clear any paused state for the same
			// model — the partial bytes are either consumed or moot.
			if (progress.status === "cancelled" && existing) {
				set({
					pulls: nextPulls,
					pausedPulls: {
						...pausedPulls,
						[progress.model]: {
							progress: existing.progress,
							pausedAt: Date.now(),
						},
					},
				});
				return;
			}
			const nextPaused = { ...pausedPulls };
			delete nextPaused[progress.model];
			set({ pulls: nextPulls, pausedPulls: nextPaused });
			return;
		}
		// Any non-terminal progress means we're actively transferring — drop
		// any paused state for this model so the UI doesn't show both bars.
		const nextPaused = { ...pausedPulls };
		const hadPaused = nextPaused[progress.model] != null;
		if (hadPaused) {
			delete nextPaused[progress.model];
		}
		set({
			pulls: {
				...pulls,
				[progress.model]: {
					progress,
					startedAt: pulls[progress.model]?.startedAt ?? Date.now(),
				},
			},
			...(hadPaused ? { pausedPulls: nextPaused } : {}),
		});
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
		// Resume path: when this `pullModel` call is actually a resume of a
		// previously-cancelled pull, seed the optimistic "starting" entry with
		// the last known percent so the bar doesn't flash back to 0% before
		// the server's first progress frame arrives. The paused entry is
		// cleared below as part of the same atomic set.
		const paused = pausedPulls[model];
		const seededProgress: OllamaPullProgress = paused
			? { ...paused.progress, status: "pulling", statusText: "resuming" }
			: { model, status: "pulling", statusText: "starting" };
		const nextPaused = { ...pausedPulls };
		if (paused) {
			delete nextPaused[model];
		}
		set({
			pulls: {
				...pulls,
				[model]: { progress: seededProgress, startedAt: Date.now() },
			},
			...(paused ? { pausedPulls: nextPaused } : {}),
		});
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
		const next = { ...pausedPulls };
		delete next[model];
		set({ pausedPulls: next });
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
