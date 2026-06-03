import { createProviderIconResolver } from "./provider-icon-resolver";
import { publicAsset } from "./public-asset";

const PROVIDER_NAME_ALIASES: Record<string, string> = {
  gemini: "google",
  gemma: "google",
  gpt: "openai",
  llama: "meta-llama",
  meta: "meta-llama",
  mistral: "mistralai",
  phi: "microsoft",
  qwq: "qwen",
  xai: "x-ai",
};

const getProviderIcon = createProviderIconResolver(PROVIDER_NAME_ALIASES);

/**
 * Reduce an LLM model id to a maker token the icon table can match.
 * - OpenRouter pins (`model::provider`) → drop the `::provider` suffix.
 * - OpenRouter ids (`vendor/model`) → the `vendor` segment.
 * - Ollama ids (`qwen2.5:7b`) → the family before the `:tag`.
 * Fuzzy matching in {@link getProviderIcon} then maps e.g. `qwen2.5` → `qwen`.
 */
export function makerFromModelId(model: string): string {
  const withoutPin = model.split("::")[0] ?? model;
  const vendor = withoutPin.includes("/")
    ? withoutPin.split("/")[0]
    : withoutPin;
  return (vendor ?? withoutPin).split(":")[0]?.trim() ?? "";
}

/**
 * Resolve a maker token (or raw model id, via {@link makerFromModelId}) to a
 * renderer-root-relative logo URL, or `null` when no logo is bundled for that
 * maker — callers render a neutral fallback glyph instead.
 */
export function resolveProviderIcon(
  provider: string | null | undefined,
): string | null {
  const path = getProviderIcon(provider);
  return path ? publicAsset(path) : null;
}
