/**
 * Renderer mirror of the Vocabulary limits enforced by
 * `src-tauri/src/winstt/commands/settings.rs`.
 *
 * Rust validates UTF-8 byte lengths (not JavaScript UTF-16 code units), so all
 * field checks in the settings schema and editable grids go through these
 * helpers. Keeping the numbers together also prevents add/paste paths from
 * drifting away from the backend collection caps.
 */
export const VOCABULARY_LIMITS = {
	dictionaryEntries: 2000,
	idBytes: 128,
	replacementBytes: 2 * 1024,
	snippetExpansionBytes: 16 * 1024,
	snippets: 1000,
	termOrTriggerBytes: 256,
} as const;

const CONTROL_CHARACTER_RE = /\p{Cc}/u;

export function utf8ByteLength(value: string): number {
	return new TextEncoder().encode(value).byteLength;
}

/** Mirrors Rust `validate_text`: bounded UTF-8 and no NUL bytes. */
export function fitsRustText(value: string, maxBytes: number): boolean {
	return !value.includes("\0") && utf8ByteLength(value) <= maxBytes;
}

/** Mirrors Rust `validate_short_text`: `validate_text` plus no controls. */
export function fitsRustShortText(value: string, maxBytes: number): boolean {
	return (
		fitsRustText(value, maxBytes) &&
		!Array.from(value).some((character) => CONTROL_CHARACTER_RE.test(character))
	);
}
