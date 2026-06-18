import type { OllamaPullProgress } from "@/shared/api/models";
import {
	findInstalledOllamaTag,
	isSameOllamaTag,
} from "../lib/quant-shelf-helpers";
import type {
	OllamaFitInfo,
	OllamaLibrarySearchProps,
	PausedPullState,
	QuantShelfDeps,
} from "./ollama-selector-types";

function findRecordKeyByOllamaTag<T>(
	record: Readonly<Record<string, T>>,
	name: string,
): string | undefined {
	if (record[name]) {
		return name;
	}
	return Object.keys(record).find((key) => isSameOllamaTag(key, name));
}

export function defaultTagBodyClick(
	deps: QuantShelfDeps,
	defaultTag: string,
): (() => void) | undefined {
	if (findRecordKeyByOllamaTag(deps.pulls, defaultTag) !== undefined) {
		return undefined;
	}
	const installedName = findInstalledOllamaTag(deps.installedNames, defaultTag);
	if (installedName !== undefined) {
		return () => deps.onSelect(installedName);
	}
	const pausedName = findRecordKeyByOllamaTag(deps.pausedPulls, defaultTag);
	if (pausedName !== undefined) {
		return () => deps.onResume(pausedName);
	}
	return () => deps.onPull(defaultTag);
}

export function buildQuantShelfDeps(opts: {
	installedNames: ReadonlySet<string>;
	librarySearch: OllamaLibrarySearchProps | undefined;
	onDelete: ((name: string) => void) | undefined;
	onDiscardPull: ((name: string) => void) | undefined;
	onPull: ((name: string) => void) | undefined;
	onResumePull: ((name: string) => void) | undefined;
	onSelect: (name: string) => void;
	onStopPull: ((name: string) => void) | undefined;
	pausedPulls: Readonly<Record<string, PausedPullState>>;
	pulls: Readonly<Record<string, OllamaPullProgress>>;
	systemFit: ((sizeBytes: number) => OllamaFitInfo) | undefined;
	value: string;
}): QuantShelfDeps {
	const tagsByModel = opts.librarySearch?.tagsByModel;
	const fetchTags = opts.librarySearch?.fetchTags;
	return {
		getFit: opts.systemFit,
		getTags: tagsByModel
			? (baseSlug: string) => tagsByModel[baseSlug.toLowerCase()]?.tags ?? []
			: undefined,
		fetchTags: fetchTags
			? (baseSlug: string) => fetchTags(baseSlug)
			: undefined,
		installedNames: opts.installedNames,
		selectedName: opts.value,
		pulls: opts.pulls,
		pausedPulls: opts.pausedPulls,
		onSelect: opts.onSelect,
		onPull: opts.onPull ?? noop,
		onStop: opts.onStopPull ?? noop,
		onResume: opts.onResumePull ?? noop,
		onDiscard: (name: string) => {
			const installedName = findInstalledOllamaTag(opts.installedNames, name);
			if (installedName !== undefined) {
				(opts.onDelete ?? noop)(installedName);
				return;
			}
			(opts.onDiscardPull ?? noop)(name);
		},
	};
}

function noop() {
	/* no-op fallback when caller doesn't supply pull callbacks */
}
