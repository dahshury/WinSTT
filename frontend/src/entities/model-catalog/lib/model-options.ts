import type { ModelStateEntry, SystemInfoEntry } from "@/shared/api/ipc-client";
import type { SelectOption } from "@/shared/ui/select";
import type { ModelInfo } from "../model/catalog-store";

const FAMILY_LABELS: Record<string, string> = {
	whisper: "Whisper",
	nemo: "NeMo",
	gigaam: "GigaAM",
	kaldi: "Kaldi",
	"t-one": "T-One",
};

function getFamilyLabel(family: string): string {
	return FAMILY_LABELS[family] ?? family;
}

type CacheBadgeFormatter = (entry: ModelStateEntry) => string;

const CACHE_BADGE_FORMATTERS: Record<ModelStateEntry["cache"]["state"], CacheBadgeFormatter> = {
	cached: () => " ✓ Downloaded",
	partial: (entry) => ` ⏬ ${Math.round(entry.cache.progress * 100)}%`,
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
	entry: ModelStateEntry | undefined
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
export function isRescuedByGpu(entry: ModelStateEntry, sys: SystemInfoEntry | null): boolean {
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
	sys: SystemInfoEntry | null
): boolean {
	if (!hasEstimatedFootprint(entry)) {
		return false;
	}
	const isFineSomewhere = isRescuedByGpu(entry, sys) || entry.comfortable_on_cpu;
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
	ctx?: BuildOptionsContext
): SelectOption[] {
	const opts: SelectOption[] = [];
	for (const items of groupByFamily(models).values()) {
		for (const m of items) {
			opts.push(modelToOption(m, ctx));
		}
	}
	return opts;
}

/** Build select options filtered to models that support realtime transcription. */
export function buildRealtimeOpts(
	models: readonly ModelInfo[],
	ctx?: BuildOptionsContext
): SelectOption[] {
	return buildModelOpts(
		models.filter((m) => m.supportsRealtime),
		ctx
	);
}
