const PROVIDER_ICONS: Record<string, string> = {
	ai21: "/provider-icons/ai21.svg",
	"aion-labs": "/provider-icons/aion-labs.svg",
	alfredpros: "/provider-icons/alfredpros.png",
	alibaba: "/provider-icons/alibaba.svg",
	allenai: "/provider-icons/allenai.svg",
	alpindale: "/provider-icons/alpindale.png",
	amazon: "/provider-icons/amazon.svg",
	"anthracite-org": "/provider-icons/anthracite-org.png",
	anthropic: "/provider-icons/anthropic.svg",
	"arcee-ai": "/provider-icons/arcee-ai.svg",
	arliai: "/provider-icons/arliai.svg",
	baidu: "/provider-icons/baidu.svg",
	bytedance: "/provider-icons/bytedance.svg",
	cognitivecomputations: "/provider-icons/cognitivecomputations.png",
	cohere: "/provider-icons/cohere.svg",
	deepcogito: "/provider-icons/deepcogito.svg",
	deepseek: "/provider-icons/deepseek.svg",
	eleutherai: "/provider-icons/eleutherai.svg",
	essentialai: "/provider-icons/essentialai.svg",
	google: "/provider-icons/google.svg",
	gryphe: "/provider-icons/gryphe.png",
	huggingface: "/provider-icons/huggingface.svg",
	"ibm-granite": "/provider-icons/ibm-granite.svg",
	inception: "/provider-icons/inception.svg",
	inflection: "/provider-icons/inflection.svg",
	kwaipilot: "/provider-icons/kwaipilot.svg",
	liquid: "/provider-icons/liquid.svg",
	mancer: "/provider-icons/mancer.png",
	meituan: "/provider-icons/meituan.svg",
	"meta-llama": "/provider-icons/meta-llama.svg",
	microsoft: "/provider-icons/microsoft.svg",
	minimax: "/provider-icons/minimax.svg",
	mistralai: "/provider-icons/mistralai.svg",
	moonshotai: "/provider-icons/moonshotai.svg",
	morph: "/provider-icons/morph.svg",
	neversleep: "/provider-icons/neversleep.webp",
	"nex-agi": "/provider-icons/nex-agi.png",
	nousresearch: "/provider-icons/nousresearch.svg",
	nvidia: "/provider-icons/nvidia.svg",
	openai: "/provider-icons/openai.svg",
	opengvlab: "/provider-icons/opengvlab.svg",
	openrouter: "/provider-icons/openrouter.svg",
	perplexity: "/provider-icons/perplexity.svg",
	"prime-intellect": "/provider-icons/prime-intellect.svg",
	qwen: "/provider-icons/qwen.svg",
	raifle: "/provider-icons/raifle.png",
	relace: "/provider-icons/relace.svg",
	sao10k: "/provider-icons/sao10k.png",
	"stepfun-ai": "/provider-icons/stepfun-ai.svg",
	switchpoint: "/provider-icons/switchpoint.png",
	tencent: "/provider-icons/tencent.svg",
	thedrummer: "/provider-icons/thedrummer.png",
	thudm: "/provider-icons/thudm.svg",
	tngtech: "/provider-icons/tngtech.svg",
	undi95: "/provider-icons/undi95.png",
	"x-ai": "/provider-icons/x-ai.svg",
	xiaomi: "/provider-icons/xiaomi.svg",
	"z-ai": "/provider-icons/z-ai.svg",
};

const FUZZY_MATCH_PREDICATES: Array<
	(key: string, normalized: string) => boolean
> = [
	(key, normalized) => key.startsWith(normalized),
	(key, normalized) => normalized.startsWith(key),
	(key, normalized) => key.includes(normalized),
	(key, normalized) => normalized.includes(key),
];

function findExactProviderKey(normalized: string): string | null {
	return PROVIDER_ICONS[normalized] ? normalized : null;
}

function findAliasProviderKey(
	aliases: Record<string, string>,
	normalized: string,
): string | null {
	const alias = aliases[normalized];
	return alias && PROVIDER_ICONS[alias] ? alias : null;
}

function findFuzzyProviderKey(normalized: string): string | null {
	for (const key of Object.keys(PROVIDER_ICONS)) {
		if (FUZZY_MATCH_PREDICATES.some((p) => p(key, normalized))) {
			return key;
		}
	}
	return null;
}

export function createProviderIconResolver(
	aliases: Record<string, string> = {},
): (provider: string | null | undefined) => string | null {
	return (provider) => {
		if (!provider) {
			return null;
		}
		const normalized = provider.toLowerCase().trim();
		if (!normalized) {
			return null;
		}

		const match =
			findExactProviderKey(normalized) ??
			findAliasProviderKey(aliases, normalized) ??
			findFuzzyProviderKey(normalized);
		return match ? (PROVIDER_ICONS[match] ?? null) : null;
	};
}
