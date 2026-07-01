/**
 * Pure helpers extracted from LlmSettingsPanel for testability.
 *
 * These hold the panel's branchy display-logic. Keeping them pure (no JSX, no
 * hooks, no side effects) makes them exhaustively unit-testable.
 */

/**
 * Determine whether the submit button in the API-key dialog should be enabled.
 * Returns true when the trimmed key is non-empty.
 */
export function isApiKeyValid(key: string): boolean {
	return key.trim().length > 0;
}

/**
 * Determine the text for the primary Ollama dialog button.
 * When Ollama is installed (showRun=true), returns "run" semantics;
 * otherwise returns "download" semantics.
 */
export type OllamaPrimaryAction = "run" | "download";

export function getOllamaPrimaryAction(showRun: boolean): OllamaPrimaryAction {
	return showRun ? "run" : "download";
}

/**
 * Determine the label key for OllamaPrimaryButton based on the current
 * starting state and whether the run vs. download path is shown.
 */
export function getOllamaPrimaryLabelKey(
	showRun: boolean,
	starting: boolean,
): string {
	if (showRun) {
		return starting ? "starting" : "runOllama";
	}
	return "downloadOllama";
}

/**
 * Build the result object returned by OllamaDialog>handleStart when the
 * Ollama startup attempt fails.
 */
export function buildOllamaStartError(
	error: string | undefined,
	fallbackKey: string,
): { errorMessage: string; started: false } {
	return { started: false, errorMessage: error ?? fallbackKey };
}

/**
 * Read an optional input element's current value, returning an empty string
 * when the element is not yet mounted.
 */
export function readInputValue(
	element: HTMLInputElement | null | undefined,
): string {
	return element?.value ?? "";
}

/**
 * Whether the Ollama model selection needs to be synced because the provider
 * or the model list changed since the last render.
 */
export function ollamaModelSyncNeeded(
	prev: { provider: string; models: readonly { name: string }[] },
	provider: string,
	models: readonly { name: string }[],
): boolean {
	return prev.provider !== provider || prev.models !== models;
}

/**
 * If the current Ollama model is no longer installed after a scan, call
 * `update` with the first available replacement.  No-op when the current
 * model is still present or no replacement exists.
 *
 * @param shouldSync - injected predicate (e.g. shouldSyncOllamaModel) that
 *   returns the replacement model name or null.
 */
export function applyOllamaModelReplacementIfNeeded(
	provider: string,
	models: readonly { name: string }[],
	current: string,
	shouldSync: (
		provider: string,
		models: readonly { name: string }[],
		current: string,
	) => string | null,
	update: (patch: { model: string }) => void,
): void {
	const replacement = shouldSync(provider, models, current);
	if (replacement) {
		update({ model: replacement });
	}
}
