import type { ModelStateEntry, SystemInfoEntry } from "@/shared/api/ipc-client";
import type { SelectOption } from "@/shared/ui/select";
import type { ModelInfo } from "../model/catalog-store";

const FAMILY_LABELS: Record<string, string> = {
	whisper: "Whisper",
	"lite-whisper": "Lite-Whisper",
	nemo: "NeMo",
	granite: "Granite",
	gigaam: "GigaAM",
	kaldi: "Kaldi",
	"t-one": "T-One",
	moonshine: "Moonshine",
	cohere: "Cohere",
	sense_voice: "SenseVoice",
	dolphin: "Dolphin",
};

function getFamilyLabel(family: string): string {
	return FAMILY_LABELS[family] ?? family;
}

type CacheBadgeFormatter = (entry: ModelStateEntry) => string;

const CACHE_BADGE_FORMATTERS: Record<
	ModelStateEntry["cache"]["state"],
	CacheBadgeFormatter
> = {
	cached: () => " ✓ Downloaded",
	partial: (entry) =>
		` ⏬ ${Math.min(99, Math.max(0, Math.round(entry.cache.progress * 100)))}%`,
	not_cached: () => " ⬇ Not downloaded",
};

/**
 * Format a cache state into a one-token badge that fits inline with the
 * model's display name. Renderer-side only — the server emits raw state
 * + bytes; this turns them into something a single-line dropdown row
 * can show without breaking layout.
 */
export function formatCacheBadge(entry: ModelStateEntry | undefined): string {
	if (!entry) {
		return "";
	}
	const formatter = CACHE_BADGE_FORMATTERS[entry.cache.state];
	return formatter(entry);
}

/** Server signals "no usable fitness data" with a non-positive byte estimate. */
export function hasEstimatedFootprint(
	entry: ModelStateEntry | undefined,
): entry is ModelStateEntry {
	return !!entry && entry.estimated_bytes > 0;
}

/** True only when the host advertises at least one GPU. */
export function hasGpu(sys: SystemInfoEntry | null): boolean {
	return !!sys && sys.gpus.length > 0;
}

/**
 * A GPU-equipped host "rescues" a model that wouldn't be comfortable on CPU,
 * provided the model is comfortable on the GPU. Returns false if there's no
 * GPU or the model is uncomfortable on GPU too.
 */
export function isRescuedByGpu(
	entry: ModelStateEntry,
	sys: SystemInfoEntry | null,
): boolean {
	return hasGpu(sys) && entry.comfortable_on_gpu;
}

/**
 * Decide whether to flag a model with the ⚠ glyph in the picker.
 *
 * "Comfortable" comes from the server (sized against detected RAM/VRAM).
 * The picker shows ⚠ only when the model is uncomfortable on BOTH the
 * GPU (if present) AND the CPU — that's the "no way this runs cleanly"
 * case. If the user has a beefy GPU, a fitness miss on CPU is fine.
 */
export function isUncomfortable(
	entry: ModelStateEntry | undefined,
	sys: SystemInfoEntry | null,
): boolean {
	if (!hasEstimatedFootprint(entry)) {
		return false;
	}
	const isFineSomewhere =
		isRescuedByGpu(entry, sys) || entry.comfortable_on_cpu;
	return !isFineSomewhere;
}

interface BuildOptionsContext {
	statesById: Record<string, ModelStateEntry>;
	systemInfo: SystemInfoEntry | null;
}

function modelToOption(m: ModelInfo, ctx?: BuildOptionsContext): SelectOption {
	const entry = ctx?.statesById[m.id];
	const badge = formatCacheBadge(entry);
	const warn = isUncomfortable(entry, ctx?.systemInfo ?? null) ? " ⚠" : "";
	return {
		id: m.id,
		label: `[${getFamilyLabel(m.family)}] ${m.displayName} (${m.sizeLabel})${badge}${warn}`,
	};
}

function groupByFamily(models: readonly ModelInfo[]): Map<string, ModelInfo[]> {
	const grouped = new Map<string, ModelInfo[]>();
	for (const m of models) {
		const list = grouped.get(m.family) ?? [];
		list.push(m);
		grouped.set(m.family, list);
	}
	return grouped;
}

/** Build grouped select options from a model catalog, prefixed by family label. */
export function buildModelOpts(
	models: readonly ModelInfo[],
	ctx?: BuildOptionsContext,
): SelectOption[] {
	const opts: SelectOption[] = [];
	for (const items of groupByFamily(models).values()) {
		for (const m of items) {
			opts.push(modelToOption(m, ctx));
		}
	}
	return opts;
}

/**
 * True when the model can honor a decoder-level "translate to English" pass.
 * Two engine families support it: multilingual Whisper exports (via the
 * `<|translate|>` decoder token) and NeMo Canary (via the `target_language`
 * recognize kwarg). `.en` Whisper variants advertise English only
 * (`supportsLanguageDetection = false`) so they have nothing to translate, and
 * every other family silently no-ops server-side. The Model-tab toggle — and
 * the LLM "Translate" modifier lock that mirrors it — only apply to these two.
 */
export function supportsTranslateToEnglish(model: ModelInfo): boolean {
	return (
		(model.family === "whisper" && model.supportsLanguageDetection) ||
		model.id.startsWith("nemo-canary-")
	);
}

function normalizedLanguages(model: ModelInfo): Set<string> {
	return new Set(model.languages.map((language) => language.toLowerCase()));
}

const CANONICAL_REALTIME_MODEL_IDS = new Set<string>([
	"streaming-nemo-ctc-en-1040ms",
	"streaming-nemo-ctc-en-1040ms-int8",
	"streaming-nemo-rnnt-en-1040ms",
	"streaming-nemo-rnnt-en-1040ms-int8",
	"streaming-parakeet-unified-en-1120ms",
	"streaming-parakeet-unified-en-1120ms-int8",
	"streaming-nemotron-en-1120ms",
	"streaming-nemotron-en-1120ms-int8",
]);

const STREAMING_EXPORT_VARIANT_RE =
	/^streaming-(?:nemo-(?:ctc|rnnt)-en(?:-\d+ms)?(?:-int8)?|parakeet-unified-en-\d+ms(?:-int8)?|nemotron-en-\d+ms(?:-int8)?)$/;

/**
 * The sherpa/NeMo streaming catalog contains one HF repo per chunk size and
 * precision. The realtime picker should not expose those implementation
 * variants as different product choices; use the highest-latency published
 * export for each precision and leave older ids loadable for existing
 * settings/cache compatibility.
 */
export function isCanonicalRealtimeModel(model: ModelInfo): boolean {
	return (
		!STREAMING_EXPORT_VARIANT_RE.test(model.id) ||
		CANONICAL_REALTIME_MODEL_IDS.has(model.id)
	);
}

/**
 * True when a model should be shown as a user-facing STT choice.
 *
 * The catalog keeps non-canonical streaming export ids loadable for saved
 * settings/cache compatibility, but every picker should collapse those
 * implementation variants to the single best export for each architecture.
 */
export function isVisibleSttModel(model: ModelInfo): boolean {
	return isCanonicalRealtimeModel(model);
}

/** True when a model should appear in the dedicated realtime-model slot. */
export function isSelectableRealtimeModel(model: ModelInfo): boolean {
	return model.nativeStreaming && isVisibleSttModel(model);
}

/**
 * True when two STT models can transcribe at least one common language.
 * An empty language list is the catalog's "many/any languages" sentinel, so it
 * overlaps every explicit list.
 */
export function modelsHaveLanguageOverlap(
	primary: ModelInfo,
	candidate: ModelInfo,
): boolean {
	if (primary.languages.length === 0 || candidate.languages.length === 0) {
		return true;
	}
	const candidateLanguages = normalizedLanguages(candidate);
	return primary.languages.some((language) =>
		candidateLanguages.has(language.toLowerCase()),
	);
}

/** True when the saved model id is missing or not present in the loaded
 *  catalog. Drives the auto-fallback guard in ModelSettingsPanel: STT is the
 *  app's core capability and the selector must never be in a "no model"
 *  state, but a stale saved id (model deleted from the catalog, corrupted
 *  settings) can leave it pointing at nothing. */
export function needsModelFallback(
	modelId: string | undefined | null,
	models: readonly ModelInfo[],
): boolean {
	if (!modelId) {
		return true;
	}
	return !models.some((m) => m.id === modelId);
}

/**
 * Pick the smallest model id from a list, using the `statesById` byte
 * estimate as the sort key. Returns null when the list is empty. Extracted
 * from `pickDefaultSttModel` so the outer function stays CC ≤ 3.
 */
function smallestModelId(
	candidates: readonly ModelInfo[],
	statesById: Record<string, ModelStateEntry>,
): string | null {
	const bySize = (a: ModelInfo, b: ModelInfo): number => {
		const sa = statesById[a.id]?.estimated_bytes ?? Number.POSITIVE_INFINITY;
		const sb = statesById[b.id]?.estimated_bytes ?? Number.POSITIVE_INFINITY;
		return sa - sb;
	};
	return candidates.toSorted(bySize)[0]?.id ?? null;
}

/** Resolve a sensible default STT model when the user's saved selection is
 *  invalid. Prefers something already cached on disk (zero-friction enable,
 *  no surprise download), then falls back to the smallest in the catalog.
 *  `filter` narrows the eligible set (e.g. native-streaming realtime only). Returns
 *  null only when the catalog itself is empty (boot race). */
export function pickDefaultSttModel(
	models: readonly ModelInfo[],
	statesById: Record<string, ModelStateEntry>,
	filter: (m: ModelInfo) => boolean = () => true,
): string | null {
	const eligible = models.filter(filter);
	const cached = eligible.filter(
		(m) => statesById[m.id]?.cache.state === "cached",
	);
	const preferred = cached.length > 0 ? cached : eligible;
	return smallestModelId(preferred, statesById);
}

/** Pick a default only from models that are already fully cached locally. */
export function pickCachedSttModel(
	models: readonly ModelInfo[],
	statesById: Record<string, ModelStateEntry>,
	filter: (m: ModelInfo) => boolean = () => true,
): string | null {
	const cached = models.filter(
		(m) => filter(m) && statesById[m.id]?.cache.state === "cached",
	);
	return smallestModelId(cached, statesById);
}
