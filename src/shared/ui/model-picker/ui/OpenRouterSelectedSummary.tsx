"use client";

import type { ReactNode } from "react";
import type { OpenRouterModel } from "@/shared/api/models";
import { formatMaker, formatModelName } from "../lib/model-selector-utils";
import { getProviderIconWithFallback } from "../lib/provider-icons";
import { AuthorBadge } from "./AuthorBadge";
import { openrouterSelectedMeta } from "./openrouter-selected-meta";
import {
	type SelectedModelNameParts,
	SelectedModelSummary,
} from "./SelectedModelSummary";

function openrouterNameParts(model: OpenRouterModel): SelectedModelNameParts {
	const main = formatModelName(model.model_name ?? model.name, model.maker);
	return {
		full: model.name,
		main: main.length > 0 ? main : model.name,
		...(model.variant ? { variant: model.variant } : {}),
	};
}

/**
 * Rich "selected model" content for a CLOSED OpenRouter picker trigger: the
 * maker logo pill + formatted name/variant + the connected spec badge. Shared
 * so the OpenRouter cloud-STT selector's collapsed trigger reads exactly like
 * the STT and Ollama pickers instead of a bare text label.
 */
export function OpenRouterSelectedSummary({
	model,
	trailing,
}: {
	model: OpenRouterModel;
	trailing?: ReactNode;
}) {
	return (
		<SelectedModelSummary
			leading={
				<AuthorBadge
					label={formatMaker(model.maker)}
					logoSrc={getProviderIconWithFallback(model.maker)}
				/>
			}
			meta={openrouterSelectedMeta(model)}
			metaPlacement="right"
			name={openrouterNameParts(model)}
			{...(trailing ? { trailing } : {})}
		/>
	);
}
