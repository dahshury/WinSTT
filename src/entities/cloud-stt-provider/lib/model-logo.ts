import {
	makerFromModelId,
	resolveProviderIcon,
} from "@/shared/lib/provider-icons";
import { bareCloudModelId } from "../model/catalog";

/**
 * Maker token for a model chip's brand logo. ElevenLabs models carry no maker
 * slash, so the provider itself is the maker; every other id (local models and
 * OpenRouter cloud ids alike) resolves to its upstream maker via
 * {@link makerFromModelId} on the prefix-stripped id (e.g.
 * `openrouter:openai/whisper-1` → openai, `openrouter:hexgrad/kokoro-82m` →
 * hexgrad). Resolving off the *bare* id keeps the cloud prefix from hijacking
 * the logo (it would otherwise match "openrouter").
 */
export function modelMakerToken(modelId: string): string {
	if (modelId.startsWith("elevenlabs:")) {
		return "elevenlabs";
	}
	return makerFromModelId(bareCloudModelId(modelId));
}

/** Uncolored brand logo (renderer-resolved public URL) for a model chip, or
 *  `null` when no logo is bundled for the maker — callers fall back to a glyph. */
export function modelChipLogo(modelId: string): string | null {
	return resolveProviderIcon(modelMakerToken(modelId));
}
