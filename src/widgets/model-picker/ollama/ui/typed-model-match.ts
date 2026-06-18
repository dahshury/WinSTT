import type { OllamaLibraryTag } from "@/shared/api/models";
import type { TypedModelQueryInfo } from "../lib/ollama-description-helpers";
import { isSameOllamaTag } from "../lib/quant-shelf-helpers";
import type { OllamaTagsState } from "./ollama-selector-types";

export function matchingTypedModelTag(
	info: TypedModelQueryInfo | null,
	tagsState: OllamaTagsState,
): OllamaLibraryTag | undefined {
	if (!info) {
		return undefined;
	}
	return tagsState?.tags.find((tag) =>
		isSameOllamaTag(info.modelName, tag.name),
	);
}
