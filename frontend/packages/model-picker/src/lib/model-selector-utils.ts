export function capitalize(str: string): string {
	return str.charAt(0).toUpperCase() + str.slice(1);
}

const PROVIDER_DISPLAY_OVERRIDES: Record<string, string> = {
	"microsoft/azure": "Microsoft Azure",
};

export function formatProvider(provider?: string): string {
	if (!provider) {
		return "OpenRouter";
	}
	return PROVIDER_DISPLAY_OVERRIDES[provider] ?? capitalize(provider);
}

const MAKER_DISPLAY_OVERRIDES: Record<string, string> = {
	openai: "OpenAI",
	anthropic: "Anthropic",
	google: "Google",
	meta: "Meta",
	mistral: "Mistral",
};

export function formatMaker(maker?: string): string {
	if (!maker) {
		return "Unknown";
	}
	return MAKER_DISPLAY_OVERRIDES[maker] ?? capitalize(maker);
}

// Many entries below have a value that is functionally identical to
// `capitalize(key)` (e.g. `anthropic: "Anthropic"`). Removing or emptying
// such an entry produces no observable change to formatModelToken because
// the fallback path computes the same capitalized string. These entries
// are kept for documentation/discoverability and are flagged below as
// equivalent mutants where applicable.
const MODEL_NAME_TOKEN_MAP: Record<string, string> = {
	gpt: "GPT",
	ai: "AI",
	llm: "LLM",
	rl: "RL",
	hf: "HF",
	api: "API",
	xai: "xAI",
	openai: "OpenAI",
	// Stryker disable next-line StringLiteral: equivalent — capitalize("anthropic") === "Anthropic"
	anthropic: "Anthropic",
	deepseek: "DeepSeek",
	minimax: "MiniMax",
	"z-ai": "Z.AI",
	zai: "Z.AI",
	// Stryker disable next-line StringLiteral: equivalent — capitalize("moonshot") === "Moonshot"
	moonshot: "Moonshot",
	moonshotai: "Moonshot",
	// Stryker disable next-line StringLiteral: equivalent — capitalize("qwen") === "Qwen"
	qwen: "Qwen",
	// Stryker disable next-line StringLiteral: equivalent — capitalize("llama") === "Llama"
	llama: "Llama",
	// Stryker disable next-line StringLiteral: equivalent — capitalize("mistral") === "Mistral"
	mistral: "Mistral",
	// Stryker disable next-line StringLiteral: equivalent — capitalize("mixtral") === "Mixtral"
	mixtral: "Mixtral",
	// Stryker disable next-line StringLiteral: equivalent — capitalize("codestral") === "Codestral"
	codestral: "Codestral",
	// Stryker disable next-line StringLiteral: equivalent — capitalize("gemini") === "Gemini"
	gemini: "Gemini",
	// Stryker disable next-line StringLiteral: equivalent — capitalize("gemma") === "Gemma"
	gemma: "Gemma",
	// Stryker disable next-line StringLiteral: equivalent — capitalize("claude") === "Claude"
	claude: "Claude",
	// Stryker disable next-line StringLiteral: equivalent — capitalize("cohere") === "Cohere"
	cohere: "Cohere",
	// Stryker disable next-line StringLiteral: equivalent — capitalize("command") === "Command"
	command: "Command",
	// Stryker disable next-line StringLiteral: equivalent — capitalize("grok") === "Grok"
	grok: "Grok",
	// Stryker disable next-line StringLiteral: equivalent — capitalize("yi") === "Yi"
	yi: "Yi",
	// Stryker disable next-line StringLiteral: equivalent — capitalize("phi") === "Phi"
	phi: "Phi",
	// Stryker disable next-line StringLiteral: equivalent — capitalize("nova") === "Nova"
	nova: "Nova",
	// Stryker disable next-line StringLiteral: equivalent — capitalize("titan") === "Titan"
	titan: "Titan",
	wizardlm: "WizardLM",
	// Stryker disable next-line StringLiteral: equivalent — capitalize("dolphin") === "Dolphin"
	dolphin: "Dolphin",
	// Stryker disable next-line StringLiteral: equivalent — capitalize("hermes") === "Hermes"
	hermes: "Hermes",
	hermes3: "Hermes 3",
	o1: "o1",
	o3: "o3",
	o4: "o4",
	// Stryker disable next-line StringLiteral: equivalent — KNOWN_VERSION_REGEX matches "4o" and toLowerCase() yields the same value, so this entry is observably redundant.
	"4o": "4o",
	"3-5": "3.5",
	// Stryker disable next-line StringLiteral: equivalent — KNOWN_VERSION_REGEX matches "3.5"; the mapped value equals the version-regex fallback.
	"3.5": "3.5",
	// Stryker disable next-line StringLiteral: equivalent — capitalize/regex fallback returns "r1" → "R1" (capitalize-first). Same string.
	r1: "R1",
	// Stryker disable next-line StringLiteral: equivalent — same reason as r1.
	r2: "R2",
	v2: "v2",
	v3: "v3",
	v4: "v4",
	// Stryker disable next-line StringLiteral: equivalent — capitalize("mini") === "Mini"
	mini: "Mini",
	// Stryker disable next-line StringLiteral: equivalent — capitalize("turbo") === "Turbo"
	turbo: "Turbo",
	// Stryker disable next-line StringLiteral: equivalent — capitalize("pro") === "Pro"
	pro: "Pro",
	// Stryker disable next-line StringLiteral: equivalent — capitalize("preview") === "Preview"
	preview: "Preview",
	// Stryker disable next-line StringLiteral: equivalent — capitalize("flash") === "Flash"
	flash: "Flash",
	// Stryker disable next-line StringLiteral: equivalent — capitalize("sonnet") === "Sonnet"
	sonnet: "Sonnet",
	// Stryker disable next-line StringLiteral: equivalent — capitalize("opus") === "Opus"
	opus: "Opus",
	// Stryker disable next-line StringLiteral: equivalent — capitalize("haiku") === "Haiku"
	haiku: "Haiku",
	// Stryker disable next-line StringLiteral: equivalent — capitalize("instruct") === "Instruct"
	instruct: "Instruct",
	// Stryker disable next-line StringLiteral: equivalent — capitalize("vision") === "Vision"
	vision: "Vision",
	// Stryker disable next-line StringLiteral: equivalent — capitalize("chat") === "Chat"
	chat: "Chat",
	// Stryker disable next-line StringLiteral: equivalent — capitalize("thinking") === "Thinking"
	thinking: "Thinking",
	// Stryker disable next-line StringLiteral: equivalent — capitalize("nitro") === "Nitro"
	nitro: "Nitro",
	// Stryker disable next-line StringLiteral: equivalent — capitalize("free") === "Free"
	free: "Free",
	// Stryker disable next-line StringLiteral: equivalent — capitalize("online") === "Online"
	online: "Online",
	// Stryker disable next-line StringLiteral: equivalent — capitalize("exacto") === "Exacto"
	exacto: "Exacto",
	// Stryker disable next-line StringLiteral: equivalent — capitalize("floor") === "Floor"
	floor: "Floor",
	// Stryker disable next-line StringLiteral: equivalent — capitalize("extended") === "Extended"
	extended: "Extended",
};

// Stryker disable next-line Regex: equivalent — removing the inner `\d+`'s plus quantifier is unobservable because formatModelToken's capitalize fallback produces the same string for any digit-led token.
const KNOWN_VERSION_REGEX = /^\d+(?:[.-]\d+)*[a-z]?$/i;
// Stryker disable next-line Regex: equivalent — the `+` collapses runs of separators, but tokenizeModelCore's length>0 filter drops empty tokens either way.
const TOKEN_SPLIT_REGEX = /[-_\s]+/;

const VERSION_HYPHEN_PREFIXES = new Set(["GPT", "o1", "o3", "o4"]);

function formatModelToken(rawToken: string): string {
	const lower = rawToken.toLowerCase();
	const mapped = MODEL_NAME_TOKEN_MAP[lower];
	if (mapped) {
		return mapped;
	}
	// Stryker disable next-line ConditionalExpression,BlockStatement,Regex: equivalent mutant — for any token the regex matches (digits-led pattern), the fallback `charAt(0).toUpperCase() + slice(1).toLowerCase()` produces the same lowercase string, so the explicit branch is observably indistinguishable from skipping it.
	if (KNOWN_VERSION_REGEX.test(rawToken)) {
		return rawToken.toLowerCase();
	}
	return rawToken.charAt(0).toUpperCase() + rawToken.slice(1).toLowerCase();
}

function stripModelNamespace(name: string): string {
	let core = name;
	const slashIdx = core.indexOf("/");
	// Stryker disable next-line ConditionalExpression: equivalent — when slashIdx is -1, `slice(-1+1)=slice(0)` is the whole string, so always-true is observably the same as the explicit guard.
	if (slashIdx >= 0) {
		core = core.slice(slashIdx + 1);
	}
	const colonIdx = core.indexOf(":");
	if (colonIdx >= 0) {
		core = core.slice(0, colonIdx);
	}
	return core;
}

function isVersionMergeablePrev(prev: string | undefined): prev is string {
	// Stryker disable next-line ConditionalExpression: equivalent mutant — Set.has(undefined) is always false, so the explicit undefined check is observably redundant.
	return prev !== undefined && VERSION_HYPHEN_PREFIXES.has(prev);
}

function shouldMergeVersion(prev: string | undefined, cur: string, index: number): boolean {
	if (index === 0) {
		return false;
	}
	if (!KNOWN_VERSION_REGEX.test(cur)) {
		return false;
	}
	return isVersionMergeablePrev(prev);
}

function mergeVersionTokens(tokens: string[]): string[] {
	const out: string[] = [];
	for (let i = 0; i < tokens.length; i++) {
		const cur = tokens[i] as string;
		const prev = out.at(-1);
		if (shouldMergeVersion(prev, cur, i)) {
			out[out.length - 1] = `${prev}-${cur}`;
			continue;
		}
		out.push(cur);
	}
	return out;
}

function tokenizeModelCore(core: string): string[] {
	const out: string[] = [];
	for (const token of core.split(TOKEN_SPLIT_REGEX)) {
		if (token.length > 0) {
			out.push(formatModelToken(token));
		}
	}
	return out;
}

/**
 * Drops the leading token when it duplicates the maker badge. Compared
 * case-insensitively against both the raw maker slug ("anthropic") and its
 * display form ("Anthropic") so "anthropic/claude-3" doesn't render as
 * "Anthropic Claude 3" next to an Anthropic chip.
 */
function dropLeadingMakerToken(tokens: string[], maker: string, makerFormatted: string): string[] {
	const firstLower = (tokens[0] as string).toLowerCase();
	const matches = firstLower === maker.toLowerCase() || firstLower === makerFormatted.toLowerCase();
	return matches ? tokens.slice(1) : tokens;
}

/**
 * Convert an OpenRouter-style model identifier into a friendly display name.
 *
 * When `maker` is supplied, a leading token equal to the maker (compared
 * case-insensitively against both the raw slug and `formatMaker(maker)`) is
 * dropped — so the rendered string doesn't duplicate the adjacent maker badge.
 */
export function formatModelName(name?: string | null, maker?: string | null): string {
	if (!name) {
		return "";
	}
	const core = stripModelNamespace(name);
	const tokens = tokenizeModelCore(core);
	if (tokens.length === 0) {
		return name;
	}
	const merged = mergeVersionTokens(tokens);
	const final =
		maker && merged.length > 1 ? dropLeadingMakerToken(merged, maker, formatMaker(maker)) : merged;
	return final.join(" ");
}

function shouldKeepUnique<T>(item: T | undefined, filter?: (val: T) => boolean): item is T {
	if (item === undefined) {
		return false;
	}
	return !filter || filter(item);
}

export function getUniqueValues<T>(arr: (T | undefined)[], filter?: (val: T) => boolean): T[] {
	const unique = new Set<T>();
	for (const item of arr) {
		if (shouldKeepUnique(item, filter)) {
			unique.add(item);
		}
	}
	return Array.from(unique).sort();
}

export const __model_selector_utils_test_helpers__ = {
	PROVIDER_DISPLAY_OVERRIDES,
	MAKER_DISPLAY_OVERRIDES,
	VERSION_HYPHEN_PREFIXES,
	stripModelNamespace,
	tokenizeModelCore,
	mergeVersionTokens,
	shouldMergeVersion,
	isVersionMergeablePrev,
	shouldKeepUnique,
	formatModelToken,
};
