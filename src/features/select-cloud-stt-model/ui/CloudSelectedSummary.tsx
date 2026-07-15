"use client";

import { Mic01Icon } from "@hugeicons/core-free-icons";
import {
	type CloudModel,
	CLOUD_CATALOG,
	providerDisplayName,
	providerOf,
} from "@/entities/cloud-stt-provider";
import type { OpenRouterModel } from "@/shared/api/models";
import { brandLogoFor } from "@/shared/ui/brand-logo";
import {
	type SelectedModelMetaItem,
	type SelectedModelNameParts,
	SelectedModelSummary,
} from "@/shared/ui/model-picker/ui/SelectedModelSummary";
import { AuthorBadge } from "@/shared/ui/model-picker/ui/AuthorBadge";
import { OpenRouterSelectedSummary } from "@/shared/ui/model-picker/ui/OpenRouterSelectedSummary";

// ElevenLabs' curated catalog carries no accuracy/speed scores, so surface the
// one fact its in-list cards lead with: multilingual transcription.
const ELEVENLABS_META: SelectedModelMetaItem[] = [
	{
		key: "audio",
		label: "",
		icon: Mic01Icon,
		tone: "teal",
		title: "Speech-to-text",
		description: "Multilingual transcription.",
	},
];

/** Split "Scribe v1 (experimental)" into name "Scribe v1" + muted variant
 *  "(experimental)"; a bare "Scribe v1" keeps the whole label as the name. */
function elevenlabsNameParts(model: CloudModel): SelectedModelNameParts {
	const trimmed = model.displayName.trim();
	const match = /^(?<main>.+?)\s+(?<variant>\(.+\))$/.exec(trimmed);
	const main = match?.groups?.["main"]?.trim();
	const variant = match?.groups?.["variant"]?.trim();
	return main && variant
		? { full: trimmed, main, variant }
		: { full: trimmed, main: trimmed };
}

function ElevenLabsSelectedSummary({ model }: { model: CloudModel }) {
	return (
		<SelectedModelSummary
			leading={
				<AuthorBadge
					label={providerDisplayName("elevenlabs")}
					logoNode={brandLogoFor("elevenlabs", {
						className: "size-5 shrink-0",
					})}
				/>
			}
			meta={ELEVENLABS_META}
			metaPlacement="right"
			name={elevenlabsNameParts(model)}
		/>
	);
}

/** Strip the `<provider>:` selection prefix — the provider tag is everything
 *  before the FIRST colon (OpenRouter slugs keep their own `author/slug`
 *  and `:variant` intact after it). */
function stripSelectionPrefix(selectedId: string): string {
	const colon = selectedId.indexOf(":");
	return colon === -1 ? selectedId : selectedId.slice(colon + 1);
}

interface CloudSelectedSummaryProps {
	/** OpenRouter STT rows already adapted into the shared picker shape — the
	 *  parent's `openrouterPickerModels`, matched by bare model id. */
	models: readonly OpenRouterModel[];
	placeholder: string;
	selectedId: string;
}

/**
 * The rich "selected model" content for the collapsed cloud-STT trigger —
 * maker logo pill + formatted name/variant + connected spec badge, identical
 * to the STT / Ollama pickers. Resolves the selected id to its provider's
 * model and renders the matching summary; falls back to the italic placeholder
 * when the selection can't be resolved (e.g. the live scan hasn't landed yet).
 */
export function CloudSelectedSummary({
	models,
	placeholder,
	selectedId,
}: CloudSelectedSummaryProps) {
	const provider = providerOf(selectedId);
	const bareId = stripSelectionPrefix(selectedId);
	if (provider === "openrouter") {
		const model = models.find((m) => m.id === bareId);
		if (model) {
			return <OpenRouterSelectedSummary model={model} />;
		}
	} else if (provider === "elevenlabs") {
		const model = CLOUD_CATALOG.elevenlabs.find((m) => m.id === bareId);
		if (model) {
			return <ElevenLabsSelectedSummary model={model} />;
		}
	}
	return (
		<span className="flex min-w-0 flex-1 items-center font-medium text-body text-foreground-muted italic tracking-tight">
			{placeholder}
		</span>
	);
}
