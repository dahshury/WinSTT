import type { OpenRouterVariant } from "@/shared/api/models";

/**
 * The closed set of OpenRouter `:variant` suffixes the model id can carry
 * (`openai/gpt-4o:free`, `…:nitro`, …). Shared by the cloud STT and cloud TTS
 * adapters so both split a scanned `OpenRouterSttModel`/`OpenRouterTtsModel` id
 * into the `{ maker, modelName, variant }` parts the shared OpenRouter picker
 * renders (maker badge, author rail grouping, variant accent).
 */
const OPENROUTER_VARIANTS: readonly OpenRouterVariant[] = [
	"exacto",
	"extended",
	"floor",
	"free",
	"nitro",
	"online",
	"thinking",
];

export interface ParsedOpenrouterId {
	maker?: string;
	modelName: string;
	variant?: OpenRouterVariant;
}

/**
 * Split an OpenRouter model id (`author/slug` or `author/slug:variant`) into the
 * maker / model-name / variant parts the picker's cards and author rail key off.
 * A leading `~` (OpenRouter's "preview"/promoted marker) is stripped from the
 * maker so the rail groups it with the canonical author.
 */
export function parseOpenrouterId(id: string): ParsedOpenrouterId {
	let base = id;
	let variant: OpenRouterVariant | undefined;
	for (const candidate of OPENROUTER_VARIANTS) {
		const suffix = `:${candidate}`;
		if (base.endsWith(suffix)) {
			base = base.slice(0, -suffix.length);
			variant = candidate;
			break;
		}
	}
	const parts = base.split("/").filter(Boolean);
	if (parts.length <= 1) {
		return {
			modelName: parts[0] ?? id,
			...(variant ? { variant } : {}),
		};
	}
	return {
		maker: (parts[0] as string).replace(/^~+/, ""),
		modelName: parts.slice(1).join("/"),
		...(variant ? { variant } : {}),
	};
}
