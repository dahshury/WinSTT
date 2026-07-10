import { isRecord } from "@/shared/lib/is-record";

/**
 * The models.dev open dataset (https://models.dev/api.json) — a free, key-less
 * aggregate of LLM metadata we use to enrich the cloud-model hover card with the
 * facts our own catalog never carries: a knowledge cutoff, a release date, the
 * developer, and modality/capability flags. Best-effort only: no match → the
 * card just shows the OpenRouter catalog data it already has.
 */
export interface ModelsDevEntry {
	/** models.dev model id, e.g. `kimi-k2` or `moonshotai/kimi-k2`. */
	id: string;
	/** Display name, e.g. "Kimi K2". */
	name?: string | undefined;
	/** The developer/lab, taken from the models.dev provider the entry sits under
	 *  (e.g. "Moonshot AI"), NOT the inference host. */
	developer?: string | undefined;
	/** Training knowledge cutoff, "YYYY-MM" or "YYYY-MM-DD". */
	knowledge?: string | undefined;
	/** First public release date, "YYYY-MM-DD". */
	releaseDate?: string | undefined;
	/** Last update date, "YYYY-MM-DD". */
	lastUpdated?: string | undefined;
	/** Advertises step-by-step reasoning. */
	reasoning?: boolean | undefined;
	/** Advertises function/tool calling. */
	toolCall?: boolean | undefined;
	/** Accepts non-text inputs (vision/audio). */
	inputModalities?: string[] | undefined;
	/** Context window in tokens. */
	contextLimit?: number | undefined;
	/** True for open-weight models. */
	openWeights?: boolean | undefined;
}

/** The parsed, indexed dataset: a lookup map keyed by several normalized ids. */
export type ModelsDevIndex = Record<string, ModelsDevEntry>;

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asBool(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) {
		return;
	}
	const out = value.filter((v): v is string => typeof v === "string");
	return out.length > 0 ? out : undefined;
}

/**
 * Normalize a model identifier to a stable lookup key: lowercase, drop the
 * vendor prefix, and strip a trailing dated-snapshot token (e.g. `-0905`,
 * `-2024-11`, `:free`) plus all remaining punctuation. So `moonshotai/kimi-k2-0905`,
 * `kimi-k2:free`, and `Kimi K2` all collapse to `kimik2`.
 */
export function normalizeModelKey(raw: string): string {
	let s = raw.toLowerCase().trim();
	const slash = s.lastIndexOf("/");
	if (slash >= 0) {
		s = s.slice(slash + 1);
	}
	const colon = s.indexOf(":");
	if (colon >= 0) {
		s = s.slice(0, colon);
	}
	// Trailing dated snapshot: -MMDD, -YYYY-MM-DD, -YYYYMMDD, -latest.
	s = s.replace(/-(?:latest|\d{3,4}|\d{4}-\d{2}(?:-\d{2})?|\d{6,8})$/g, "");
	return s.replace(/[^a-z0-9]/g, "");
}

function trimEntry(
	raw: Record<string, unknown>,
	developer: string | undefined,
): ModelsDevEntry | null {
	const id = asString(raw["id"]);
	if (!id) {
		return null;
	}
	const limit = isRecord(raw["limit"]) ? raw["limit"] : undefined;
	const modalities = isRecord(raw["modalities"])
		? raw["modalities"]
		: undefined;
	const context =
		limit && typeof limit["context"] === "number"
			? limit["context"]
			: undefined;
	return {
		id,
		name: asString(raw["name"]),
		developer,
		knowledge: asString(raw["knowledge"]),
		releaseDate: asString(raw["release_date"]),
		lastUpdated: asString(raw["last_updated"]),
		reasoning: asBool(raw["reasoning"]),
		toolCall: asBool(raw["tool_call"]),
		inputModalities: modalities
			? asStringArray(modalities["input"])
			: undefined,
		contextLimit: context,
		openWeights: asBool(raw["open_weights"]),
	};
}

/** Score how "complete" an entry is — richer entries win on key collisions. */
function completeness(entry: ModelsDevEntry): number {
	let score = 0;
	if (entry.knowledge) {
		score += 2;
	}
	if (entry.releaseDate) {
		score += 1;
	}
	if (entry.developer) {
		score += 1;
	}
	if (entry.inputModalities) {
		score += 1;
	}
	return score;
}

function indexEntry(
	index: ModelsDevIndex,
	key: string,
	entry: ModelsDevEntry,
): void {
	if (!key) {
		return;
	}
	const existing = index[key];
	if (!existing || completeness(entry) > completeness(existing)) {
		index[key] = entry;
	}
}

/**
 * Flatten the raw models.dev `api.json` (provider → models) into a lookup index
 * keyed by every normalized form of each model's id + name, so an OpenRouter id
 * can be resolved by suffix or by display name.
 */
export function parseModelsDevApi(json: unknown): ModelsDevIndex {
	const index: ModelsDevIndex = {};
	if (!isRecord(json)) {
		return index;
	}
	for (const provider of Object.values(json)) {
		if (!isRecord(provider)) {
			continue;
		}
		const developer = asString(provider["name"]);
		const models = provider["models"];
		if (!isRecord(models)) {
			continue;
		}
		for (const [modelKey, rawModel] of Object.entries(models)) {
			if (!isRecord(rawModel)) {
				continue;
			}
			const entry = trimEntry(rawModel, developer);
			if (!entry) {
				continue;
			}
			indexEntry(index, normalizeModelKey(modelKey), entry);
			indexEntry(index, normalizeModelKey(entry.id), entry);
			if (entry.name) {
				indexEntry(index, normalizeModelKey(entry.name), entry);
			}
		}
	}
	return index;
}

/**
 * Resolve a model against the parsed index by its id first, then its display
 * name. Returns `null` when nothing matches — the caller falls back to catalog
 * data alone.
 */
export function lookupModelsDev(
	index: ModelsDevIndex,
	modelId: string,
	modelName?: string | undefined,
): ModelsDevEntry | null {
	const byId = index[normalizeModelKey(modelId)];
	if (byId) {
		return byId;
	}
	if (modelName) {
		const byName = index[normalizeModelKey(modelName)];
		if (byName) {
			return byName;
		}
	}
	return null;
}

export const MODELS_DEV_API_URL = "https://models.dev/api.json";
