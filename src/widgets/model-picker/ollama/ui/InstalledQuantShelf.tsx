import type { OllamaLibraryTag, OllamaModel } from "@/shared/api/models";
import { formatOllamaSize } from "../lib/family-helpers";
import { libraryBaseSlug, paramSizeFromName } from "../lib/quant-shelf-helpers";
import { LazyQuantShelf } from "./LazyQuantShelf";
import { OllamaQuantShelf } from "./OllamaQuantShelf";
import type { QuantShelfDeps } from "./ollama-selector-types";

function installedSelfTag(model: OllamaModel): OllamaLibraryTag {
	const tag: OllamaLibraryTag = { name: model.name };
	if (model.size) {
		tag.sizeBytes = model.size;
		tag.sizeLabel = formatOllamaSize(model.size);
	}
	if (model.details?.quantizationLevel) {
		tag.quantization = model.details.quantizationLevel;
	}
	if (model.details?.parameterSize) {
		tag.parameterSize = model.details.parameterSize;
	}
	return tag;
}

function installedParamSize(model: OllamaModel): string {
	return paramSizeFromName(model.name) || (model.details?.parameterSize ?? "");
}

export function InstalledQuantShelf({
	model,
	deps,
}: {
	deps: QuantShelfDeps;
	model: OllamaModel;
}) {
	const paramSize = installedParamSize(model);
	const selfPlaceholder = (
		<OllamaQuantShelf
			getFit={deps.getFit}
			installedNames={deps.installedNames}
			onDiscard={deps.onDiscard}
			onPull={deps.onPull}
			onResume={deps.onResume}
			onSelect={deps.onSelect}
			onStop={deps.onStop}
			paramSize={paramSize}
			pausedPulls={deps.pausedPulls}
			pulls={deps.pulls}
			selectedName={deps.selectedName}
			tags={[installedSelfTag(model)]}
		/>
	);
	return (
		<LazyQuantShelf
			baseSlug={libraryBaseSlug(model.name)}
			deps={deps}
			paramSize={paramSize}
			placeholder={selfPlaceholder}
		/>
	);
}
