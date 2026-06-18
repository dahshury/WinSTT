import type { ReactNode } from "react";
import type { OllamaLibraryTag } from "@/shared/api/models";
import { isSameOllamaTag } from "../lib/quant-shelf-helpers";
import { OllamaQuantShelf } from "./OllamaQuantShelf";
import type { QuantShelfDeps } from "./ollama-selector-types";

const scheduledTagFetches = new Set<string>();

function requestTagFetch(
	baseSlug: string,
	fetchTags: ((baseSlug: string) => void) | undefined,
): void {
	if (!(baseSlug && fetchTags) || scheduledTagFetches.has(baseSlug)) {
		return;
	}
	scheduledTagFetches.add(baseSlug);
	queueMicrotask(() => {
		fetchTags(baseSlug);
	});
}

function appendMissingOllamaTags(
	tags: readonly OllamaLibraryTag[],
	extraTags: readonly OllamaLibraryTag[],
): readonly OllamaLibraryTag[] {
	if (extraTags.length === 0) {
		return tags;
	}
	const missing = extraTags.filter(
		(extraTag) => !tags.some((tag) => isSameOllamaTag(tag.name, extraTag.name)),
	);
	return missing.length > 0 ? [...tags, ...missing] : tags;
}

interface LazyQuantShelfProps {
	baseSlug: string;
	deps: QuantShelfDeps;
	extraTags?: readonly OllamaLibraryTag[] | undefined;
	forceKeepNames?: ReadonlySet<string> | undefined;
	paramSize: string | null | undefined;
	placeholder?: ReactNode;
}

export function LazyQuantShelf({
	baseSlug,
	paramSize,
	deps,
	extraTags,
	forceKeepNames,
	placeholder,
}: LazyQuantShelfProps) {
	const { fetchTags, getTags } = deps;
	requestTagFetch(baseSlug, fetchTags);
	const fetchedTags = baseSlug ? (getTags?.(baseSlug) ?? []) : [];
	const tags = appendMissingOllamaTags(fetchedTags, extraTags ?? []);
	if (tags.length === 0) {
		return placeholder ?? null;
	}
	return (
		<OllamaQuantShelf
			forceKeepNames={forceKeepNames}
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
			tags={tags}
		/>
	);
}
