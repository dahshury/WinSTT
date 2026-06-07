/**
 * Pure pull-matching + description-index + capability/context formatting helpers
 * for the Ollama picker (no JSX). This is the surface the `maker-groups.test.ts`
 * suite imports (via the host's re-export).
 */

import type {
	OllamaLibraryHit,
	OllamaModel,
	OllamaPullProgress,
} from "@/shared/api/models";
import {
	libraryBaseSlug,
	paramSizeFromName,
} from "../lib/quant-shelf-helpers";

const VALID_MODEL_NAME_RE = /^[a-zA-Z0-9._:/-]+$/;
const LEADING_LETTERS_RE = /^[a-zA-Z]+/;

/** Pull the leading alphabetic chunk off an Ollama slug — `gemma3n` → `gemma`. */
export function familySlugFromName(name: string): string {
	return (LEADING_LETTERS_RE.exec(name)?.[0] ?? "").toLowerCase();
}

function normalizeOllamaParamSize(value: string | null | undefined): string {
	return (value ?? "").trim().toLowerCase();
}

export interface TypedModelQueryInfo {
	baseSlug: string;
	modelName: string;
	paramSize: string | undefined;
}

export function typedModelQueryInfo(
	query: string,
): TypedModelQueryInfo | null {
	const modelName = query.trim();
	if (!(modelName && VALID_MODEL_NAME_RE.test(modelName))) {
		return null;
	}
	const colonIdx = modelName.indexOf(":");
	if (colonIdx <= 0 || colonIdx === modelName.length - 1) {
		return null;
	}
	const baseSlug = libraryBaseSlug(modelName);
	if (!baseSlug) {
		return null;
	}
	return {
		baseSlug,
		modelName,
		paramSize: paramSizeFromName(modelName) || undefined,
	};
}

export function singleActivePullName(
	pulls: Readonly<Record<string, OllamaPullProgress>>,
): string | null {
	const names = Object.keys(pulls);
	return names.length === 1 ? (names[0] ?? null) : null;
}

export function ollamaPullMatchesRow(
	pullName: string,
	rowName: string,
	rowParamSize?: string | null | undefined,
): boolean {
	if (libraryBaseSlug(pullName) !== libraryBaseSlug(rowName)) {
		return false;
	}
	const rowParam =
		normalizeOllamaParamSize(rowParamSize) ||
		normalizeOllamaParamSize(paramSizeFromName(rowName));
	const pullParam = normalizeOllamaParamSize(paramSizeFromName(pullName));
	return !rowParam || !pullParam || rowParam === pullParam;
}

export function activePullNameForRow(
	pulls: Readonly<Record<string, OllamaPullProgress>>,
	rowName: string,
	rowParamSize?: string | null | undefined,
): string | null {
	for (const name of Object.keys(pulls)) {
		if (ollamaPullMatchesRow(name, rowName, rowParamSize)) {
			return name;
		}
	}
	return null;
}

export const EMPTY_DESCRIPTION_BY_BASE: ReadonlyMap<string, string> = new Map();
let cachedDescriptionIndex: {
	catalog: readonly OllamaLibraryHit[];
	descriptions: ReadonlyMap<string, string>;
} | null = null;

function cleanOllamaDescription(
	value: string | null | undefined,
): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

export function buildOllamaDescriptionIndex(
	catalog: readonly OllamaLibraryHit[] | undefined,
): ReadonlyMap<string, string> {
	if (!catalog || catalog.length === 0) {
		return EMPTY_DESCRIPTION_BY_BASE;
	}
	if (cachedDescriptionIndex?.catalog === catalog) {
		return cachedDescriptionIndex.descriptions;
	}
	const descriptions = new Map<string, string>();
	for (const hit of catalog) {
		const description = cleanOllamaDescription(hit.description);
		if (description) {
			descriptions.set(libraryBaseSlug(hit.name), description);
		}
	}
	cachedDescriptionIndex = { catalog, descriptions };
	return descriptions;
}

export function ollamaDescriptionForName(
	name: string,
	descriptionsByBase: ReadonlyMap<string, string>,
): string | undefined {
	return descriptionsByBase.get(libraryBaseSlug(name));
}

export function formatOllamaContextWindow(
	tokens: number | null | undefined,
): string | undefined {
	if (!tokens || tokens <= 0) {
		return undefined;
	}
	if (tokens >= 1_000_000) {
		const millions = tokens / 1_000_000;
		return `${millions.toFixed(millions >= 10 ? 0 : 1).replace(/\.0$/, "")}M context`;
	}
	if (tokens >= 1_000) {
		return `${Math.round(tokens / 1_000)}K context`;
	}
	return `${tokens} context`;
}

function capabilityLabel(value: string): string {
	const normalized = value.trim().toLowerCase();
	switch (normalized) {
		case "insert":
			return "Fill-in-middle";
		case "tools":
			return "Tools";
		case "vision":
			return "Vision";
		default:
			return normalized
				.split(/[-_\s]+/)
				.filter(Boolean)
				.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
				.join(" ");
	}
}

export function normalizedCapabilitySet(
	capabilities: readonly string[] | null | undefined,
): Set<string> {
	return new Set(
		(capabilities ?? []).map((cap) => cap.trim().toLowerCase()).filter(Boolean),
	);
}

export function supportsOllamaToolCalling(
	capabilities: readonly string[] | null | undefined,
): boolean {
	return normalizedCapabilitySet(capabilities).has("tools");
}

export function visibleCapabilities(
	capabilities: readonly string[] | null | undefined,
	options: { excludeTools?: boolean } = {},
): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const raw of capabilities ?? []) {
		const key = raw.trim().toLowerCase();
		if (
			!key ||
			key === "completion" ||
			key === "thinking" ||
			(options.excludeTools && key === "tools") ||
			seen.has(key)
		) {
			continue;
		}
		seen.add(key);
		out.push(capabilityLabel(key));
	}
	return out;
}

function localOllamaDescription(model: OllamaModel): string | undefined {
	const details = model.details;
	const facts: string[] = [];
	if (details?.format) {
		facts.push(details.format.toUpperCase());
	}
	if (details?.family) {
		facts.push(`${details.family} family`);
	}
	if (details?.quantizationLevel) {
		facts.push(details.quantizationLevel);
	}
	const contextWindow = formatOllamaContextWindow(model.contextLength);
	if (contextWindow) {
		facts.push(contextWindow);
	}
	const caps = visibleCapabilities(model.capabilities);
	if (caps.length > 0) {
		facts.push(caps.join(", "));
	}
	return facts.length > 0
		? `Local Ollama model: ${facts.join(" / ")}`
		: "Local Ollama model discovered from Ollama";
}

export function installedDescriptionForModel(
	model: OllamaModel,
	descriptionsByBase: ReadonlyMap<string, string>,
): string | undefined {
	return (
		ollamaDescriptionForName(model.name, descriptionsByBase) ??
		localOllamaDescription(model)
	);
}
