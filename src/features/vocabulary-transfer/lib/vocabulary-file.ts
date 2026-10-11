import {
	dictionaryEntrySchema,
	snippetEntrySchema,
} from "@/shared/config/settings-schema";
import { VOCABULARY_LIMITS } from "@/shared/config/vocabulary-limits";

export type VocabularyKind = "dictionary" | "snippets";
export interface VocabularyRow {
	key: string;
	value?: string | undefined;
	autoAdded?: boolean | undefined;
}
export const MAX_VOCABULARY_FILE_BYTES = 20 * 1024 * 1024;

// A strict CSV reader: quotes, escaped quotes, embedded newlines, BOM, LF and CRLF.
// Parsing must finish successfully before the caller mutates the dictionary.
function csvRows(text: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let field = "";
	let quoted = false;
	let closed = false;
	const endField = () => {
		row.push(field);
		field = "";
		closed = false;
	};
	const endRow = () => {
		endField();
		if (row.some((cell) => cell.trim().length > 0)) {
			rows.push(row);
		}
		row = [];
		if (rows.length > VOCABULARY_LIMITS.dictionaryEntries + 1) {
			throw new Error("limit");
		}
	};
	for (let index = 0; index < text.length; index++) {
		const char = text[index];
		if (quoted) {
			if (char === '"') {
				if (text[index + 1] === '"') {
					field += '"';
					index++;
				} else {
					quoted = false;
					closed = true;
				}
			} else {
				field += char;
			}
		} else if (char === ",") {
			endField();
		} else if (char === "\n" || char === "\r") {
			endRow();
			if (char === "\r" && text[index + 1] === "\n") {
				index++;
			}
		} else if (char === '"' && !field && !closed) {
			quoted = true;
		} else {
			if (closed || char === '"') {
				throw new Error("invalid");
			}
			field += char;
		}
	}
	if (quoted) {
		throw new Error("invalid");
	}
	endRow();
	return rows;
}

function fromJson(text: string, kind: VocabularyKind): VocabularyRow[] {
	const root: unknown = JSON.parse(text);
	let entries: unknown = root;
	if (root && typeof root === "object" && !Array.isArray(root)) {
		const archive = root as Record<string, unknown>;
		if (archive["format"] === "voiceink.dictionary" && kind === "dictionary") {
			if (
				archive["schemaVersion"] !== 1 ||
				!Array.isArray(archive["vocabulary"]) ||
				!Array.isArray(archive["replacements"])
			) {
				throw new Error("invalid");
			}
			if (
				archive["vocabulary"].length > VOCABULARY_LIMITS.dictionaryEntries ||
				archive["replacements"].length > VOCABULARY_LIMITS.dictionaryEntries
			) {
				throw new Error("limit");
			}
			const rows: { key: unknown; value?: unknown }[] = archive[
				"vocabulary"
			].map((item) => {
				if (!item || typeof item !== "object") {
					throw new Error("invalid");
				}
				return { key: (item as Record<string, unknown>)["term"] };
			});
			for (const item of archive["replacements"]) {
				if (!item || typeof item !== "object" || !Array.isArray(item.sources)) {
					throw new Error("invalid");
				}
				for (const key of item.sources) {
					rows.push({ key, value: item["replacement"] });
					if (rows.length > VOCABULARY_LIMITS.dictionaryEntries * 2) {
						throw new Error("limit");
					}
				}
			}
			// The source vocabulary may also contain a replacement source. Prefer its explicit rule.
			const replaced = new Set(
				rows
					.filter((row) => "value" in row)
					.map((row) => String(row.key).trim().toLowerCase()),
			);
			return rows.filter(
				(row) =>
					"value" in row || !replaced.has(String(row.key).trim().toLowerCase()),
			) as VocabularyRow[];
		}
		if (
			archive["format"] !== "winstt-vocabulary" ||
			archive["version"] !== 1 ||
			archive["kind"] !== kind
		) {
			throw new Error("invalid");
		}
		entries = archive["entries"];
	}
	if (!Array.isArray(entries)) {
		throw new Error("invalid");
	}
	if (entries.length > VOCABULARY_LIMITS.dictionaryEntries) {
		throw new Error("limit");
	}
	return entries.map((entry: unknown) => {
		if (typeof entry === "string" && kind === "dictionary") {
			return { key: entry };
		}
		if (!entry || typeof entry !== "object") {
			throw new Error("invalid");
		}
		const item = entry as Record<string, unknown>;
		return {
			key: kind === "dictionary" ? item["term"] : item["trigger"],
			value: kind === "dictionary" ? item["replacement"] : item["expansion"],
			...(typeof item["autoAdded"] === "boolean" && kind === "dictionary"
				? { autoAdded: item["autoAdded"] }
				: {}),
		} as VocabularyRow;
	});
}

export function parseVocabularyFile(
	text: string,
	kind: VocabularyKind,
): VocabularyRow[] {
	if (new TextEncoder().encode(text).byteLength > MAX_VOCABULARY_FILE_BYTES) {
		throw new Error("limit");
	}
	const raw = text.replace(/^\uFEFF/, "");
	let rows: VocabularyRow[];
	if (raw.trimStart().startsWith("[") || raw.trimStart().startsWith("{")) {
		rows = fromJson(raw, kind);
	} else {
		const csv = csvRows(raw);
		const header = csv[0]?.map((cell) => cell.trim().toLowerCase());
		const keyHeaders =
			kind === "dictionary"
				? ["term", "word", "original", "originaltext"]
				: ["trigger"];
		const valueHeaders =
			kind === "dictionary"
				? ["replacement", "replacementtext"]
				: ["expansion"];
		const keyIndex =
			header?.findIndex((cell) => keyHeaders.includes(cell)) ?? -1;
		const valueIndex =
			header?.findIndex((cell) => valueHeaders.includes(cell)) ?? -1;
		if (
			keyIndex >= 0 &&
			valueIndex < 0 &&
			(kind === "snippets" || (header?.length ?? 0) > 1)
		) {
			throw new Error("invalid");
		}
		if (keyIndex >= 0) {
			csv.shift();
		}
		rows = csv.map((cells) => {
			if (keyIndex < 0 && cells.length > 2) {
				throw new Error("invalid");
			}
			return {
				key: cells[keyIndex >= 0 ? keyIndex : 0] as string,
				value: cells[valueIndex >= 0 ? valueIndex : 1],
			};
		});
	}
	const limit =
		kind === "dictionary"
			? VOCABULARY_LIMITS.dictionaryEntries
			: VOCABULARY_LIMITS.snippets;
	if (rows.length > limit) {
		throw new Error("limit");
	}
	for (const row of rows) {
		const parsed =
			kind === "dictionary"
				? dictionaryEntrySchema.safeParse({
						id: "import",
						term: row.key,
						replacement: row.value,
					})
				: snippetEntrySchema.safeParse({
						id: "import",
						trigger: row.key,
						expansion: row.value,
					});
		if (!parsed.success) {
			throw new Error("invalid");
		}
		row.key = row.key.trim();
		// Replacement and expansion whitespace can be meaningful; preserve it after validation.
	}
	return rows;
}

export function planVocabularyMerge(
	existing: readonly string[],
	incoming: readonly VocabularyRow[],
	kind: VocabularyKind,
) {
	const seen = new Set(existing.map((key) => key.trim().toLowerCase()));
	const added = incoming.filter((row) => {
		const key = row.key.trim().toLowerCase();
		if (seen.has(key)) {
			return false;
		}
		seen.add(key);
		return true;
	});
	const limit =
		kind === "dictionary"
			? VOCABULARY_LIMITS.dictionaryEntries
			: VOCABULARY_LIMITS.snippets;
	if (existing.length + added.length > limit) {
		throw new Error("limit");
	}
	return { added, skipped: incoming.length - added.length };
}
