/**
 * Pure helpers for the Windows UIA context snapshot. Kept in a separate
 * module from `context-reader.ts` so that downstream consumers (the
 * relay's context-capture orchestrator, tests) can import the formatter
 * without dragging in electron — `context-reader.ts` uses `app.isPackaged`
 * to resolve the helper binary, which trips bun:test's electron mock
 * timing when imported transitively.
 */

/**
 * Snapshot of the user's focused UI surface, captured via Windows UI
 * Automation immediately before a dictation starts. The fields are
 * intentionally narrow — enough to disambiguate names/jargon, not enough
 * to exfiltrate documents.
 */
export interface WindowContextSnapshot {
	elementName: string;
	focusedText: string;
	windowTitle: string;
}

export const EMPTY_CONTEXT: WindowContextSnapshot = {
	windowTitle: "",
	elementName: "",
	focusedText: "",
};

/**
 * Format the snapshot into a compact prompt fragment for the LLM cleanup
 * step. Returns "" when no context is available, so callers can blindly
 * concatenate without checking.
 *
 * The format is deliberately terse: window title on one line, element on
 * another, then the focused text. We trim aggressive whitespace because
 * UIA tree dumps include lots of stacked newlines from empty controls.
 *
 * Implementation note: an earlier version used three sequential `if`
 * guards which pushed cyclomatic complexity to 4 and made the function
 * stick at CRAP=4 even at 100% coverage (CRAP = CC^2·(1-cov)^3 + CC).
 * Building the lines from a declarative table + `filter` keeps CC at 1
 * without changing observable behaviour.
 */
export function formatContextForPrompt(snapshot: WindowContextSnapshot): string {
	const sections: readonly {
		readonly format: (value: string) => string;
		readonly value: string;
	}[] = [
		{ value: snapshot.windowTitle.trim(), format: (v) => `Window: ${v}` },
		{ value: snapshot.elementName.trim(), format: (v) => `Focused field: ${v}` },
		{
			value: snapshot.focusedText.replace(/\n{2,}/g, "\n").trim(),
			format: (v) => `Visible content:\n${v}`,
		},
	];
	return sections
		.filter((section) => section.value.length > 0)
		.map((section) => section.format(section.value))
		.join("\n");
}
