#!/usr/bin/env bun

/**
 * i18n coverage verifier for WinSTT.
 *
 * Walks every `.ts`/`.tsx` source file under `src/`, finds calls to
 * `useTranslations("ns")` / `getTranslations("ns")` and the corresponding
 * `t("key")` / `t("key", { ... })` lookups, then verifies that:
 *
 *   1. Every (namespace, key) referenced by the code exists in `messages/en.json`.
 *   2. Every key present in `messages/en.json` exists in every other locale.
 *   3. (warn-only) No non-English value is byte-identical to the English source
 *      — that usually means the string was copied without being translated.
 *      A small allowlist covers strings that legitimately stay in English
 *      (proper nouns like "WinSTT", "Ollama", numeric labels like "0-3").
 *   4. (--lint-jsx) JSX text nodes and aria-label/title/placeholder/alt
 *      attribute literals that look like user-facing prose must either go
 *      through t() or carry a `// i18n-ignore` suppression comment. Opt-in
 *      because the existing codebase has accumulated literals that pre-date
 *      this lint; sweeping them is a separate piece of work.
 *
 * Run as:
 *   bun run scripts/verify-i18n.ts            # report only (exit 1 if missing)
 *   bun run scripts/verify-i18n.ts --strict   # also fail on untranslated values
 *   bun run scripts/verify-i18n.ts --lint-jsx # also fail on hardcoded JSX strings
 */

import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");
const SRC_DIR = join(REPO_ROOT, "src");
const MESSAGES_DIR = join(REPO_ROOT, "messages");
const EN_PATH = join(MESSAGES_DIR, "en.json");

const SOURCE_EXTS = new Set([".ts", ".tsx"]);
const SKIP_DIRS = new Set(["node_modules", "dist", "dist-electron", "dist-renderer", "coverage"]);

const STRICT = process.argv.includes("--strict");
const LINT_JSX = process.argv.includes("--lint-jsx");

type Json = string | number | boolean | null | { [k: string]: Json } | Json[];

/**
 * Strings whose value is allowed to match English in any locale.
 * Either a brand name / acronym / shared loanword (legitimately identical
 * across many languages), or an internationally-recognised technical term.
 */
const KEEP_ENGLISH: ReadonlySet<string> = new Set([
	"titleBar.appName", // brand name "WinSTT"
	"mainPage.pttButton", // 3-letter abbreviation
	"download.eta", // "eta {time}" pattern, kept short
	"settings.tabAudio", // "Audio" — same word in es/fr/it
	"settings.tabGeneral", // "General" — same word in es
	"settings.tabLlm", // "LLM" acronym
	"general.fileTranscriptionFormat", // "Format" — same word in fr
	"snippets.expansion", // "Expansion" — same word in fr
	"llm.presetFormal", // "Formal" — same word in es
	"llm.presetCasual", // "Casual" — same loanword in es
	"statusBar.error", // "ERROR" — same word in es
	"tray.modePtt", // "PTT" acronym
	"model.deviceCpuLabel", // "CPU" acronym
	"model.deviceAutoLabel", // "Auto" — same loanword in fr
	"general.visualizerRadial", // same loanword in es/fr
	"general.visualizerAura", // same loanword in es/fr
	// Brand names: identical across all languages.
	"integrations.openai", // "OpenAI"
	"integrations.elevenlabs", // "ElevenLabs"
	"integrations.groupOpenai", // "OpenAI"
	"integrations.groupElevenlabs", // "ElevenLabs"
	"integrations.groupLocal", // "Local" — same word in es/fr
	"llm.providerOpenRouter", // "OpenRouter" brand
	"llm.providerOllama", // "Ollama (local)" — brand + cognate in es/fr
	// API-key placeholders: literal prefixes shared with the provider.
	"integrations.openaiApiKeyPlaceholder", // "sk-…"
	"integrations.elevenlabsApiKeyPlaceholder", // "el-…"
	"llm.openrouterApiKeyPlaceholder", // "sk-or-v1-…"
	// Pure format strings (no translatable words).
	"llm.modelSizeLabel", // "{size} GB"
	"llm.pullProgress", // "{percent}% — {status}"
	// Acronyms / shared loanwords across many languages.
	"tts.deviceCpu", // "CPU" acronym
	"tts.deviceCuda", // "GPU (CUDA)" acronyms
	"tray.sectionDiagnostics", // "Diagnostics" — same word in fr
	"tray.sectionTranscription", // "Transcription" — same word in fr
	// About panel — brand / proper-noun tokens that legitimately stay identical
	// across every locale.
	"about.electronVersion", // "Electron" brand
	"about.nodeVersion", // "Node" brand
	"about.appInfoTitle", // "Application" — same word in fr/es
	"about.appVersion", // "Version" — same word in fr
]);

async function* walk(dir: string): AsyncGenerator<string> {
	const entries = await readdir(dir, { withFileTypes: true });
	for (const entry of entries) {
		if (entry.isDirectory()) {
			if (SKIP_DIRS.has(entry.name)) continue;
			yield* walk(join(dir, entry.name));
		} else if (SOURCE_EXTS.has(extname(entry.name))) {
			yield join(dir, entry.name);
		}
	}
}

interface Reference {
	file: string;
	key: string;
	namespace: string;
}

const T_VAR_RE =
	/(?:const|let)\s+(\w+)\s*=\s*(?:useTranslations|getTranslations)\(\s*(?:"([^"]+)"|'([^']+)'|`([^`]+)`)?\s*\)/g;

const T_CALL_RE = /(\w+)\(\s*(?:"([^"]+)"|'([^']+)'|`([^`]+)`)/g;

/** Detect t-vars and resolve their keys for one source file. */
function extractRefs(file: string, source: string, refs: Reference[]): void {
	const tVars = new Map<string, string>(); // varName -> namespace
	for (const m of source.matchAll(T_VAR_RE)) {
		const varName = m[1];
		const ns = m[2] ?? m[3] ?? m[4] ?? "";
		if (varName === undefined) continue;
		tVars.set(varName, ns);
	}
	if (tVars.size === 0) return;

	for (const m of source.matchAll(T_CALL_RE)) {
		const varName = m[1];
		if (varName === undefined) continue;
		const ns = tVars.get(varName);
		if (ns === undefined) continue;
		const key = m[2] ?? m[3] ?? m[4];
		if (!key) continue;
		refs.push({ namespace: ns, key, file });
	}
}

function hasKey(messages: Json, namespace: string, key: string): boolean {
	// next-intl supports dotted keys within a namespace, e.g.
	// `useTranslations("model")` + `t("resourceWarning.cancel")` resolves
	// `messages.model.resourceWarning.cancel`. Walk both the namespace and
	// the (possibly dotted) key to mirror runtime lookup semantics.
	const parts = [...namespace.split("."), ...key.split(".")];
	let cur: Json = messages;
	for (const p of parts) {
		if (typeof cur !== "object" || cur === null || Array.isArray(cur)) return false;
		cur = (cur as Record<string, Json>)[p] as Json;
		if (cur === undefined) return false;
	}
	return typeof cur === "string";
}

function flatKeys(obj: Json, prefix = ""): string[] {
	if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return [];
	const out: string[] = [];
	for (const [k, v] of Object.entries(obj as Record<string, Json>)) {
		const path = prefix ? `${prefix}.${k}` : k;
		if (typeof v === "string") out.push(path);
		else out.push(...flatKeys(v, path));
	}
	return out;
}

function getValue(obj: Json, dotted: string): string | undefined {
	const parts = dotted.split(".");
	let cur: Json = obj;
	for (const p of parts) {
		if (typeof cur !== "object" || cur === null || Array.isArray(cur)) return undefined;
		cur = (cur as Record<string, Json>)[p] as Json;
		if (cur === undefined) return undefined;
	}
	return typeof cur === "string" ? cur : undefined;
}

async function main() {
	// 1. Collect references from source code.
	const refs: Reference[] = [];
	for await (const file of walk(SRC_DIR)) {
		const source = await readFile(file, "utf-8");
		extractRefs(file, source, refs);
	}

	// 2. Load locale files.
	const localeFiles = (await readdir(MESSAGES_DIR)).filter((f) => f.endsWith(".json"));
	const locales: Record<string, Json> = {};
	for (const f of localeFiles) {
		const code = f.replace(/\.json$/, "");
		locales[code] = JSON.parse(await readFile(join(MESSAGES_DIR, f), "utf-8")) as Json;
	}
	if (!locales.en) {
		console.error(`Missing ${EN_PATH}`);
		process.exit(2);
	}

	let errors = 0;
	let warnings = 0;

	// 3. Code-vs-en: every used key must exist in en.json.
	const usedSet = new Set<string>();
	for (const r of refs) {
		const dotted = `${r.namespace}.${r.key}`;
		usedSet.add(dotted);
		// Skip dynamic keys built from variables (we can't statically resolve them).
		if (/[`${}]/.test(r.key)) continue;
		if (!hasKey(locales.en, r.namespace, r.key)) {
			console.error(`MISSING-IN-EN  ${dotted}  (used in ${relative(REPO_ROOT, r.file)})`);
			errors++;
		}
	}

	// 4. en-vs-locales: every en key must exist (and not be empty) in each other locale.
	const enKeys = flatKeys(locales.en);
	for (const [code, messages] of Object.entries(locales)) {
		if (code === "en") continue;
		for (const dotted of enKeys) {
			const val = getValue(messages, dotted);
			if (val === undefined) {
				console.error(`MISSING        [${code}] ${dotted}`);
				errors++;
				continue;
			}
			if (val.trim() === "") {
				console.error(`EMPTY          [${code}] ${dotted}`);
				errors++;
				continue;
			}
			if (KEEP_ENGLISH.has(dotted)) continue;
			const enVal = getValue(locales.en, dotted);
			if (enVal !== undefined && val === enVal) {
				const level = STRICT ? "error" : "warn";
				if (level === "error") {
					console.error(`UNTRANSLATED   [${code}] ${dotted}  = "${val}"`);
					errors++;
				} else {
					console.warn(`UNTRANSLATED   [${code}] ${dotted}  = "${val}"`);
					warnings++;
				}
			}
		}
	}

	// 5. Unused-key report (informational only — does not fail the run).
	const unused: string[] = [];
	for (const dotted of enKeys) {
		if (!usedSet.has(dotted)) unused.push(dotted);
	}
	if (unused.length > 0) {
		console.log(`\nINFO: ${unused.length} en.json keys not referenced by code:`);
		for (const u of unused) console.log(`  - ${u}`);
	}

	// 6. Hardcoded-JSX-string scan (opt-in via --lint-jsx). Catches the
	//    most common ways a user-facing literal sneaks past `t()` without
	//    us noticing: JSX text children (`>Hello</`) and the attribute
	//    positions screen readers / pointer users actually see
	//    (`aria-label`, `aria-description`, `title`, `placeholder`, `alt`).
	//    Annotate a legitimate exception with a trailing `// i18n-ignore`
	//    comment on the same line.
	//
	//    Reported as a warning by default so we can land this without a
	//    breaking sweep; promoted to a failing error when --lint-jsx is
	//    passed (CI uses this in a parallel job that's allowed to fail
	//    while the residuals are being cleaned up).
	const literalHits = await scanForHardcodedJsxLiterals();
	for (const item of literalHits) {
		if (LINT_JSX) {
			console.error(`HARDCODED-JSX  ${item.file}:${item.line}  ${item.snippet}`);
			errors++;
		} else {
			console.warn(`HARDCODED-JSX  ${item.file}:${item.line}  ${item.snippet}`);
			warnings++;
		}
	}

	console.log(
		`\n${errors} error(s), ${warnings} warning(s). ` +
			`Scanned ${refs.length} t() call(s) across ${enKeys.length} en keys × ${
				Object.keys(locales).length - 1
			} non-en locales. ` +
			`Found ${literalHits.length} hardcoded JSX string(s) (${LINT_JSX ? "errors" : "warnings; pass --lint-jsx to fail"}).`
	);

	if (errors > 0) process.exit(1);
}

/* ------------------------------------------------------------------ */
/* Hardcoded-JSX-literal scanner                                      */
/* ------------------------------------------------------------------ */

interface LiteralHit {
	file: string;
	line: number;
	snippet: string;
}

// Attributes whose literal string values are user-visible and therefore
// must be localised. Other attribute strings (e.g. `data-testid`, `id`,
// `className`, `src`) are excluded — they're not human-readable text.
const LOCALISABLE_ATTRS = new Set([
	"aria-label",
	"aria-description",
	"aria-placeholder",
	"aria-roledescription",
	"alt",
	"placeholder",
	"title",
]);

// Suppression sentinel — any line containing this comment is skipped.
const IGNORE_SENTINEL = "i18n-ignore";

// JSX text-node literal: `>Some text<`. Excludes pure whitespace,
// expressions (`>{x}<`), and JSX comments. The regex is intentionally
// permissive — false positives are filtered downstream by the
// "looks like a real word" check (`isLocalisableLiteral`).
const JSX_TEXT_RE = />\s*([A-Za-z][A-Za-z 0-9!?,.'"&:;()/-]{2,})\s*</g;

// Attribute literal: `<Foo aria-label="Done">` or `placeholder="Search…"`.
const JSX_ATTR_RE =
	/\b(aria-label|aria-description|aria-placeholder|aria-roledescription|alt|placeholder|title)\s*=\s*"([^"\n]+)"/g;

// Strings that look like text but aren't user-facing prose: brand names,
// acronyms, file extensions, numeric labels, technical tokens. Mirrors
// the spirit of KEEP_ENGLISH but applied at the JSX-string level.
const LITERAL_ALLOWLIST_RE =
	/^(WinSTT|Electron|Node|Bun|Vite|OpenAI|ElevenLabs|Ollama|OpenRouter|CPU|GPU|RAM|VRAM|API|URL|PNG|JPG|WAV|MP3|SRT|TXT|JSON|YAML|HTTP|HTTPS|TCP|UDP|IPC|RPC|DOM|UI|ID|SDK|CLI|TTS|STT|VAD|LLM|MIT|FSD|FAQ|MB|GB|KB|ms|sec|min|hr|N\/A|TODO|FIXME|\d+(\.\d+)?[A-Za-z]*)$/;

function looksLikePropName(s: string): boolean {
	return /^[a-z][a-zA-Z0-9-]*$/.test(s);
}

function isLocalisableLiteral(value: string): boolean {
	const trimmed = value.trim();
	if (trimmed.length < 3) return false;
	if (LITERAL_ALLOWLIST_RE.test(trimmed)) return false;
	// No spaces and no letters? Probably a token / id.
	if (!/[A-Za-z]/.test(trimmed)) return false;
	// Pure single-word lowercase prop names (`autoFocus`, `disabled`).
	if (looksLikePropName(trimmed)) return false;
	// Contains template-style placeholders (`{count}`) — almost always already a t() arg.
	if (/{\w+}/.test(trimmed)) return false;
	return true;
}

async function scanForHardcodedJsxLiterals(): Promise<LiteralHit[]> {
	const hits: LiteralHit[] = [];
	for await (const file of walk(SRC_DIR)) {
		// Only .tsx files have JSX. .ts files can hold strings but they're
		// not user-rendered without going through a t() at some point.
		if (extname(file) !== ".tsx") continue;
		const source = await readFile(file, "utf-8");
		const rel = relative(REPO_ROOT, file);
		const lines = source.split("\n");
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (line === undefined) continue;
			if (line.includes(IGNORE_SENTINEL)) continue;
			// Skip import / type / re-export lines — they have no JSX.
			if (/^\s*(import|export|type|interface)\b/.test(line)) continue;
			for (const m of line.matchAll(JSX_TEXT_RE)) {
				const value = m[1] ?? "";
				if (!isLocalisableLiteral(value)) continue;
				hits.push({ file: rel, line: i + 1, snippet: `>${value}<` });
			}
			for (const m of line.matchAll(JSX_ATTR_RE)) {
				const attr = m[1] ?? "";
				const value = m[2] ?? "";
				if (!LOCALISABLE_ATTRS.has(attr)) continue;
				if (!isLocalisableLiteral(value)) continue;
				// Inline JSX expressions (`title={someVar}`) never match
				// JSX_ATTR_RE because we require a quoted RHS, so we don't
				// have to filter them out explicitly.
				hits.push({ file: rel, line: i + 1, snippet: `${attr}="${value}"` });
			}
		}
	}
	return hits;
}

await main();
