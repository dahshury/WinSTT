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

const MODEL_NAME_TOKEN_MAP: Record<string, string> = {
	gpt: "GPT",
	ai: "AI",
	llm: "LLM",
	rl: "RL",
	hf: "HF",
	api: "API",
	xai: "xAI",
	openai: "OpenAI",
	anthropic: "Anthropic",
	deepseek: "DeepSeek",
	minimax: "MiniMax",
	"z-ai": "Z.AI",
	zai: "Z.AI",
	moonshot: "Moonshot",
	moonshotai: "Moonshot",
	qwen: "Qwen",
	llama: "Llama",
	mistral: "Mistral",
	mixtral: "Mixtral",
	codestral: "Codestral",
	gemini: "Gemini",
	gemma: "Gemma",
	claude: "Claude",
	cohere: "Cohere",
	command: "Command",
	grok: "Grok",
	yi: "Yi",
	phi: "Phi",
	nova: "Nova",
	titan: "Titan",
	wizardlm: "WizardLM",
	dolphin: "Dolphin",
	hermes: "Hermes",
	hermes3: "Hermes 3",
	o1: "o1",
	o3: "o3",
	o4: "o4",
	"4o": "4o",
	"3-5": "3.5",
	"3.5": "3.5",
	r1: "R1",
	r2: "R2",
	v2: "v2",
	v3: "v3",
	v4: "v4",
	mini: "Mini",
	turbo: "Turbo",
	pro: "Pro",
	preview: "Preview",
	flash: "Flash",
	sonnet: "Sonnet",
	opus: "Opus",
	haiku: "Haiku",
	instruct: "Instruct",
	vision: "Vision",
	chat: "Chat",
	thinking: "Thinking",
	nitro: "Nitro",
	free: "Free",
	online: "Online",
	exacto: "Exacto",
	floor: "Floor",
	extended: "Extended",
};

const KNOWN_VERSION_REGEX = /^\d+(?:[.-]\d+)*[a-z]?$/i;
const TOKEN_SPLIT_REGEX = /[-_\s]+/;

const VERSION_HYPHEN_PREFIXES = new Set(["GPT", "o1", "o3", "o4"]);

function formatModelToken(rawToken: string): string {
	const lower = rawToken.toLowerCase();
	const mapped = MODEL_NAME_TOKEN_MAP[lower];
	if (mapped) {
		return mapped;
	}
	if (KNOWN_VERSION_REGEX.test(rawToken)) {
		return rawToken.toLowerCase();
	}
	return rawToken.charAt(0).toUpperCase() + rawToken.slice(1).toLowerCase();
}

function stripModelNamespace(name: string): string {
	let core = name;
	const slashIdx = core.indexOf("/");
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

export function formatModelName(name?: string | null): string {
	if (!name) {
		return "";
	}
	const core = stripModelNamespace(name);
	const tokens = tokenizeModelCore(core);
	if (tokens.length === 0) {
		return name;
	}
	return mergeVersionTokens(tokens).join(" ");
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
