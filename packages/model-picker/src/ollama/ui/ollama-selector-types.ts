/**
 * Shared private interfaces threaded across the extracted Ollama-selector
 * component files. Kept in one leaf, type-only module so the sibling `.tsx`
 * files (chips, shelf, trigger, rows) import the shared shapes from a single
 * place instead of reaching back into the host component — and so the modules
 * form a clean DAG (types ← chips/shelf ← rows/trigger ← host).
 */

import type { SystemInfoEntry } from "@/shared/api/ipc-client";
import type {
	OllamaLibraryHit,
	OllamaLibraryTag,
	OllamaPullProgress,
	RecommendedOllamaModel,
	OllamaModel,
} from "@/shared/api/models";
import type { QuantBadgeCacheState } from "../lib/quant-shelf-helpers";

export interface PausedPullState {
	pausedAt: number;
	progress: OllamaPullProgress;
}

/** Shape of a single recommended-model fit assessment used to render the
 *  "won't fit" warning chip next to oversized recommendations. Mirrors
 *  {@link import("@/entities/llm-catalog").OllamaFitAssessment} but without
 *  pulling the entities package into the picker. */
export interface OllamaFitInfo {
	availableBytes: number;
	fits: boolean;
	requiredBytes: number;
	shortfall: "vram" | "ram" | "unknown" | undefined;
}

/** State surfaced by the library scraper — passed in so the picker stays
 *  presentational while the renderer-side store drives fetching. */
export interface OllamaLibrarySearchProps {
	/** Optional full library catalog. The selector no longer loads or fuzzy-lists
	 *  this catalog; when a caller has it cached, descriptions can enrich local
	 *  installed rows. */
	catalog: readonly OllamaLibraryHit[];
	/** Scraper failure reason — surfaces inline in the Library area. */
	error?: string | null;
	/** Trigger a per-model tag scrape. Idempotent once cached. */
	fetchTags: (model: string) => void;
	isLoaded: boolean;
	isLoading: boolean;
	/** Legacy catalog loader; this selector intentionally does not call it. */
	loadCatalog: () => void;
	/** Per-model tag-fetch state keyed by lower-cased model slug. */
	tagsByModel: Readonly<
		Record<
			string,
			{
				error?: string | null;
				isLoading: boolean;
				tags: readonly OllamaLibraryTag[];
			}
		>
	>;
}

export interface OllamaModelSelectorProps {
	disabled?: boolean | undefined;
	/** Render the list as an always-open inline panel (no popup) — used to host
	 *  the picker in a dedicated surface and by render tests. */
	inline?: boolean | undefined;
	isLoading?: boolean | undefined;
	/** When provided, the popup grows a third "Library" section that lists
	 *  scraped ollama.com search results with paginated pull actions. */
	librarySearch?: OllamaLibrarySearchProps | undefined;
	models: readonly OllamaModel[];
	onChange: (modelName: string) => void;
	/** Delete an installed model. Omit to hide the delete button. */
	onDelete?: ((modelName: string) => void) | undefined;
	/** Forget a paused pull (doesn't touch disk). Omit to hide the recommended UI. */
	onDiscardPull?: ((modelName: string) => void) | undefined;
	/** Called when the dropdown opens — used to refresh the catalog. */
	onOpen?: (() => void) | undefined;
	/** Start (or restart) a pull. Omit to hide the recommended UI. */
	onPull?: ((modelName: string) => void) | undefined;
	/** Resume a previously-paused pull. Omit to hide the recommended UI. */
	onResumePull?: ((modelName: string) => void) | undefined;
	/** Stop an active pull (becomes a paused pull). Omit to hide the recommended UI. */
	onStopPull?: ((modelName: string) => void) | undefined;
	pausedPulls?: Readonly<Record<string, PausedPullState>> | undefined;
	placeholder?: string | undefined;
	/** Active pulls keyed by model name. Omit to hide the recommended UI. */
	pulls?: Readonly<Record<string, OllamaPullProgress>> | undefined;
	/** Curated list of suggested models. When supplied alongside pull
	 *  callbacks, the popup grows a "Recommended" section with inline
	 *  install actions; omitting it falls back to installed-only mode. */
	recommendedModels?: readonly RecommendedOllamaModel[] | undefined;
	/** In-flight model swap (caller-driven; the picker has no IPC subscription
	 *  for Ollama swaps the way the STT picker does). When set, the trigger
	 *  renders the same `from → ◌ → to` view + accent sweep used by the STT
	 *  selector. `fromName` is the previously-loaded model id; `toName` the
	 *  one the user just picked. Both are resolved against `models` to render
	 *  publisher chips. Omit (or pass `null`) when no swap is in flight. */
	swap?:
		| { fromName?: string | null | undefined; toName: string }
		| null
		| undefined;
	/** Optional fit-assessment lookup. Called per recommended model to
	 *  render a "Won't fit" badge when the host system can't run it. */
	systemFit?: ((sizeBytes: number) => OllamaFitInfo) | undefined;
	/** Optional system info — currently only used to decide whether to call
	 *  `systemFit`; if the caller supplies neither, the badge is suppressed. */
	systemInfo?: SystemInfoEntry | null | undefined;
	value: string;
}

export interface QuantBadgeState {
	cacheState: QuantBadgeCacheState;
	/** A pull is flowing for this tag right now. */
	isDownloading: boolean;
	/** Pull percent [0..100] for the progress fill (active OR paused), or null. */
	progressPercent: number | null;
}

/** Everything the quant shelf needs from the picker, threaded down to each row
 *  as one bundle so the row signatures stay small. The pull/select/fit handlers
 *  are the SAME ones the old Pull-button cluster used — the shelf just folds
 *  them into the badges. `getTags`/`fetchTags` source the per-model tag list
 *  from the library store (keyed by lower-cased base slug). */
export interface QuantShelfDeps {
	fetchTags: ((baseSlug: string) => void) | undefined;
	getFit: ((sizeBytes: number) => OllamaFitInfo) | undefined;
	getTags: ((baseSlug: string) => readonly OllamaLibraryTag[]) | undefined;
	installedNames: ReadonlySet<string>;
	onDiscard: (name: string) => void;
	onPull: (name: string) => void;
	onResume: (name: string) => void;
	onSelect: (name: string) => void;
	onStop: (name: string) => void;
	pausedPulls: Readonly<Record<string, PausedPullState>>;
	pulls: Readonly<Record<string, OllamaPullProgress>>;
	selectedName: string | undefined;
}

export interface TriggerPullSummary {
	model: string;
	percent: number;
	status: OllamaPullProgress["status"];
}

export type OllamaTagsState =
	| OllamaLibrarySearchProps["tagsByModel"][string]
	| undefined;

/** Everything one maker group's rows need, bundled so the section signature
 *  stays small. */
export interface MakerGroupDeps {
	descriptionsByBase: ReadonlyMap<string, string>;
	getFit: ((sizeBytes: number) => OllamaFitInfo) | undefined;
	installedNames: ReadonlySet<string>;
	/** True for installed models backed by the curated catalog — they get no
	 *  whole-card delete (only per-quant shelf deletes). See
	 *  {@link import("../lib/maker-groups").isCatalogBackedModel}. */
	isCatalogModel: (name: string) => boolean;
	isFavorite: (name: string) => boolean;
	onDelete: ((name: string) => void) | undefined;
	onSelect: (name: string) => void;
	onToggleFavorite: (name: string) => void;
	pausedPulls: Readonly<Record<string, PausedPullState>>;
	pulls: Readonly<Record<string, OllamaPullProgress>>;
	shelfDeps: QuantShelfDeps;
	tagsByModel: OllamaLibrarySearchProps["tagsByModel"];
	value: string;
}
