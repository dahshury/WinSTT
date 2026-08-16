"use client";

import { createContext, useContext } from "react";

const EMPTY_SHORTCUT_LABELS = new Map<string, string>();

/**
 * Keyboard hints are derived by the picker shell from the model cards that are
 * actually rendered. Keeping the lookup in context lets every picker inherit
 * the same Ctrl+1…9 affordance without threading another prop through each
 * STT/TTS/Ollama/OpenRouter card adapter.
 */
export const ModelPickerShortcutContext = createContext<
	ReadonlyMap<string, string>
>(EMPTY_SHORTCUT_LABELS);

export function useModelPickerShortcut(
	modelId: string | undefined,
): string | undefined {
	const labels = useContext(ModelPickerShortcutContext);
	return modelId ? labels.get(modelId) : undefined;
}
