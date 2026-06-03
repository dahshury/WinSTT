const PROVIDER_ICONS: Record<string, string> = {
  ai21: "/provider-icons/ai21.png",
  "aion-labs": "/provider-icons/aion-labs.png",
  alfredpros: "/provider-icons/alfredpros.png",
  alibaba: "/provider-icons/alibaba.png",
  allenai: "/provider-icons/allenai.png",
  alpindale: "/provider-icons/alpindale.png",
  amazon: "/provider-icons/amazon.png",
  "anthracite-org": "/provider-icons/anthracite-org.png",
  anthropic: "/provider-icons/anthropic.png",
  "arcee-ai": "/provider-icons/arcee-ai.png",
  arliai: "/provider-icons/arliai.png",
  baidu: "/provider-icons/baidu.png",
  bytedance: "/provider-icons/bytedance.png",
  cognitivecomputations: "/provider-icons/cognitivecomputations.png",
  cohere: "/provider-icons/cohere.png",
  deepcogito: "/provider-icons/deepcogito.png",
  deepseek: "/provider-icons/deepseek.png",
  eleutherai: "/provider-icons/eleutherai.png",
  essentialai: "/provider-icons/essentialai.png",
  google: "/provider-icons/google.svg",
  gryphe: "/provider-icons/gryphe.png",
  huggingface: "/provider-icons/huggingface.svg",
  "ibm-granite": "/provider-icons/ibm-granite.webp",
  inception: "/provider-icons/inception.png",
  inflection: "/provider-icons/inflection.png",
  kwaipilot: "/provider-icons/kwaipilot.png",
  liquid: "/provider-icons/liquid.png",
  mancer: "/provider-icons/mancer.png",
  meituan: "/provider-icons/meituan.png",
  "meta-llama": "/provider-icons/meta-llama.png",
  microsoft: "/provider-icons/microsoft.svg",
  minimax: "/provider-icons/minimax.png",
  mistralai: "/provider-icons/mistralai.png",
  moonshotai: "/provider-icons/moonshotai.png",
  morph: "/provider-icons/morph.png",
  neversleep: "/provider-icons/neversleep.webp",
  "nex-agi": "/provider-icons/nex-agi.png",
  nousresearch: "/provider-icons/nousresearch.png",
  nvidia: "/provider-icons/nvidia.png",
  openai: "/provider-icons/openai.png",
  opengvlab: "/provider-icons/opengvlab.png",
  openrouter: "/provider-icons/openrouter.png",
  perplexity: "/provider-icons/perplexity.svg",
  "prime-intellect": "/provider-icons/prime-intellect.png",
  qwen: "/provider-icons/qwen.png",
  raifle: "/provider-icons/raifle.png",
  relace: "/provider-icons/relace.png",
  sao10k: "/provider-icons/sao10k.png",
  "stepfun-ai": "/provider-icons/stepfun-ai.png",
  switchpoint: "/provider-icons/switchpoint.png",
  tencent: "/provider-icons/tencent.png",
  thedrummer: "/provider-icons/thedrummer.png",
  thudm: "/provider-icons/thudm.webp",
  tngtech: "/provider-icons/tngtech.png",
  undi95: "/provider-icons/undi95.png",
  "x-ai": "/provider-icons/x-ai.png",
  xiaomi: "/provider-icons/xiaomi.webp",
  "z-ai": "/provider-icons/z-ai.png",
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
