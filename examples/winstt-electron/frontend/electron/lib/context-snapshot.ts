/**
 * Pure helpers for the Windows UIA context snapshot. Kept in a separate
 * module from `context-reader.ts` so that downstream consumers (the
 * relay's context-capture orchestrator, tests) can import the formatter
 * without dragging in electron — `context-reader.ts` uses `app.isPackaged`
 * to resolve the helper binary, which trips bun:test's electron mock
 * timing when imported transitively.
 */

import { denoiseForLlm, isCanvasSurface, pruneAxHtmlForLlm, stripListScrollback } from "./ax-prune";

export interface WindowContextSnapshot {
	/** Lowercased exe basename of the foreground window's process. */
	appExe?: string;
	/**
	 * Hierarchical XML serialization of the focused window's UIA
	 * subtree. Compact tags (window/doc/edit/text/button/...) and at
	 * most ~150K chars / 250 elements / 9 levels deep.
	 */
	axHtml?: string;
	/**
	 * Current clipboard text, interleaved as supplementary context (the reference
	 * "80% of the use case with 5% of the code"). Echo-guarded at capture time:
	 * dropped when it equals our own last transcription, because WinSTT pastes
	 * via a clipboard sandwich, so right after a dictation the clipboard holds
	 * the text we just pasted — feeding it back would make the LLM echo itself.
	 */
	clipboardText?: string;
	elementName: string;
	focusedText: string;
	/**
	 * On-device OCR of the foreground window, attached ONLY as a last
	 * resort when UIA exposed no readable text (canvas/game/RDP windows).
	 * Lower-fidelity than the structured fields (no reading order
	 * guarantees, no hidden/scrolled text), so it's labeled as approximate
	 * in the prompt. Never set for denied apps — `redactSensitiveFields`
	 * whitelists only the legacy triple, so this is dropped on redaction.
	 */
	ocrText?: string;
	/**
	 * The user's currently-selected text (UIA TextPattern selection). The
	 * highest-signal context we have: if the user highlighted something before
	 * dictating, that's almost always the thing they're acting on (the email to
	 * reply to, the paragraph to rewrite). Captured side-effect-free via the
	 * `--selection` UIA read — NOT the Ctrl+C clipboard trick, which would
	 * inject keystrokes mid-recording. Absent when nothing is selected.
	 * Mirrors the field-standard "selected text first" approach (whishpy,
	 * VoiceInk's SelectedTextService) — see
	 * memory/reference_stt_context_awareness_field_survey.md.
	 */
	selectedText?: string;
	textAfter?: string;
	textBefore?: string;
	/** Active page URL when the foreground app is a recognized browser. */
	url?: string;
	windowTitle: string;
}

export const EMPTY_CONTEXT: WindowContextSnapshot = {
	windowTitle: "",
	elementName: "",
	focusedText: "",
};

/**
 * Strip the optional Wispr-tier fields out of a snapshot. Used by the
 * deny-list filter so that an app on the user's "don't scrape" list
 * still produces a snapshot — keeping window title + element name as
 * harmless metadata — but never leaks textbox contents, the axHtml
 * tree, or the URL. The legacy three-field shape is the cheapest
 * "this app was active but we collected no content" signal.
 */
export function redactSensitiveFields(snapshot: WindowContextSnapshot): WindowContextSnapshot {
	return {
		windowTitle: snapshot.windowTitle,
		elementName: snapshot.elementName,
		focusedText: "",
	};
}

/**
 * Match a snapshot against a user-managed deny-list of patterns. Each
 * pattern is one of:
 *   - An executable name (`"chrome.exe"`, `"1password.exe"`) — matched
 *     as case-insensitive exact equality against `snapshot.appExe`.
 *   - A URL host suffix (`"bankofamerica.com"`, `"login.example.org"`)
 *     — matched against the host portion of `snapshot.url` (every
 *     pattern matches any subdomain: `bankofamerica.com` covers
 *     `www.bankofamerica.com` and `secure.bankofamerica.com`).
 *
 * Patterns starting with `*.` are normalised by dropping the leading
 * `*.` so users can author either form. Empty / whitespace-only
 * patterns are ignored. The function is deliberately tolerant — a
 * mistyped entry is silently a no-op rather than a runtime error,
 * because a deny-list is a defensive guardrail and an exception thrown
 * here would just turn into "context-awareness silently stopped
 * working" for the user.
 */
export function isDeniedByList(
	snapshot: WindowContextSnapshot,
	denyList: readonly string[]
): boolean {
	if (denyListIsEmpty(denyList)) {
		return false;
	}
	const probe = buildDenyProbe(snapshot);
	return denyList.some((raw) => denyPatternMatchesProbe(raw, probe));
}

interface DenyProbe {
	readonly appExe: string;
	readonly host: string;
}

function denyListIsEmpty(denyList: readonly string[] | undefined): boolean {
	return !denyList || denyList.length === 0;
}

function buildDenyProbe(snapshot: WindowContextSnapshot): DenyProbe {
	const appExe = (snapshot.appExe ?? "").toLowerCase();
	const url = (snapshot.url ?? "").toLowerCase();
	return { appExe, host: extractHost(url) };
}

function normaliseDenyPattern(raw: string): string {
	return raw.trim().toLowerCase().replace(LEADING_WILDCARD_RE, "");
}

function denyPatternMatchesProbe(raw: string, probe: DenyProbe): boolean {
	const pattern = normaliseDenyPattern(raw);
	if (pattern === "") {
		return false;
	}
	return matchesAppExePattern(pattern, probe.appExe) || matchesHostPattern(pattern, probe.host);
}

function matchesAppExePattern(pattern: string, appExe: string): boolean {
	return pattern.endsWith(".exe") && appExe === pattern;
}

function matchesHostPattern(pattern: string, host: string): boolean {
	if (host === "") {
		return false;
	}
	return host === pattern || host.endsWith(`.${pattern}`);
}

/**
 * Recognised IDE / code-editor process names. Exe match on
 * `snapshot.appExe`; the captured axHtml is treated as code context so
 * the cleanup prompt knows to wrap identifiers in backticks. Wispr Flow
 * gates its IDE-specific behaviour on the same kind of exe-name match.
 *
 * VS Code, Cursor, Windsurf all spawn as `Code.exe` derivatives but
 * with distinct basenames; matching by lowercased suffix covers each
 * one and any future fork. JetBrains products use vendor-specific
 * binaries (`idea64.exe`, `pycharm64.exe`, ...) so we match on a few
 * known prefixes.
 */
const IDE_EXE_MATCHERS: readonly ((exe: string) => boolean)[] = [
	(exe) => exe === "code.exe",
	(exe) => exe === "cursor.exe",
	(exe) => exe === "windsurf.exe",
	(exe) => exe === "code - insiders.exe",
	(exe) => exe === "vscodium.exe",
	(exe) => exe === "sublime_text.exe",
	(exe) => exe.startsWith("idea") && exe.endsWith(".exe"),
	(exe) => exe.startsWith("pycharm") && exe.endsWith(".exe"),
	(exe) => exe.startsWith("webstorm") && exe.endsWith(".exe"),
	(exe) => exe.startsWith("rubymine") && exe.endsWith(".exe"),
	(exe) => exe.startsWith("clion") && exe.endsWith(".exe"),
	(exe) => exe.startsWith("goland") && exe.endsWith(".exe"),
	(exe) => exe.startsWith("rustrover") && exe.endsWith(".exe"),
	(exe) => exe.startsWith("rider") && exe.endsWith(".exe"),
	(exe) => exe.startsWith("phpstorm") && exe.endsWith(".exe"),
	(exe) => exe === "devenv.exe",
];

/** Lowercase-scheme stripper for {@link extractHost}. Hoisted to module
 *  scope per biome's "no in-function regex literal" rule. */
const SCHEME_PREFIX_RE = /^[a-z]+:\/\//;
/** Strips the leading `*.` from a deny-list pattern so users can author
 *  `*.example.com` or `example.com` interchangeably. */
const LEADING_WILDCARD_RE = /^\*\./;

/** True when the snapshot's foreground app is a recognised IDE. Exported so
 *  the context-playground debug tooling can surface the same IDE verdict the
 *  prompt formatter uses (it drives the "treat visible content as code" hint). */
export function isIdeContext(snapshot: WindowContextSnapshot): boolean {
	const exe = (snapshot.appExe ?? "").toLowerCase();
	if (!exe) {
		return false;
	}
	return IDE_EXE_MATCHERS.some((match) => match(exe));
}

/** Accessibility-name marker for a console-style control whose "text before
 *  the caret" is the ENTIRE scrollback buffer (animation frames, ANSI/log
 *  residue) rather than a clean editable field. Matched against the focused
 *  element's NAME (not its content) — e.g. VS Code / Cursor's
 *  "Terminal 45, <shell> Use Alt+F1 for terminal accessibility help". */
const TERMINAL_NAME_RE = /\b(?:terminal|console)\b/i;

/** True when the focused control looks like a terminal/console. Its caret
 *  context is scrollback soup, not useful prior text — the playground surfaces
 *  this so terminal noise can be recognised (and suppressed). */
export function looksLikeTerminal(snapshot: WindowContextSnapshot): boolean {
	return TERMINAL_NAME_RE.test(snapshot.elementName);
}

/**
 * Pull the host portion out of a URL string. URL constructor is
 * intentionally avoided here — UIA's omnibox value sometimes lacks a
 * scheme (Chromium can show `github.com/foo` with no `https://`) and
 * `new URL("github.com/foo")` throws. We treat anything before the
 * first `/` (after optionally stripping a scheme) as the host, which
 * handles both `https://github.com/foo` and `github.com/foo`.
 */
function extractHost(url: string): string {
	if (url === "") {
		return "";
	}
	const hostPart = sliceHostPart(url.replace(SCHEME_PREFIX_RE, ""));
	return stripQueryAndFragment(hostPart);
}

function sliceHostPart(noScheme: string): string {
	const slashIdx = noScheme.indexOf("/");
	return slashIdx === -1 ? noScheme : noScheme.slice(0, slashIdx);
}

function stripQueryAndFragment(hostPart: string): string {
	return hostPart.split("?")[0]?.split("#")[0] ?? "";
}

/**
 * Format the snapshot into a flat JSON object the LLM cleanup step reads as
 * structured context. Keys (all optional, emitted only when non-empty):
 * app, ide, url, window, field, selection, beforeCaret / afterCaret (or
 * fieldText), screen, screenOcr, clipboard, note. Empty fields are omitted
 * entirely (never null). Returns "" when nothing was captured, so callers can
 * blindly concatenate. The KEY NAMES are the contract the system prompt's
 * rules reference (see `withContextPrefix` in electron/ipc/llm.ts) — keep the
 * two in sync.
 */
export function formatContextForPrompt(snapshot: WindowContextSnapshot): string {
	const sections = buildPromptSections(snapshot);
	const context: Record<string, string | boolean> = {};
	for (const section of sections) {
		if (section.value.length === 0) {
			continue;
		}
		// `ide` is a presence flag — its section carries "yes", emit a boolean.
		context[section.key] = section.key === "ide" ? true : section.value;
	}
	if (Object.keys(context).length === 0) {
		return "";
	}
	return JSON.stringify(context, null, 2);
}

interface PromptSection {
	readonly key: string;
	readonly value: string;
}

const BLANK_LINES_RE = /\n{2,}/g;

function collapseBlankLines(raw: string | undefined): string {
	return (raw ?? "").replace(BLANK_LINES_RE, "\n").trim();
}

function trimOrEmpty(raw: string | undefined): string {
	return (raw ?? "").trim();
}

function ideMarkerFor(snapshot: WindowContextSnapshot): string {
	return isIdeContext(snapshot) ? "yes" : "";
}

/**
 * Below this many chars of de-noised focused-field text, the focused element
 * isn't carrying a real body (empty reply box, search bar, canvas) — so the
 * full-window axHtml tree (pruned or raw) is worth including as fallback
 * context. At/above it, the focused field IS the context and the tree is
 * redundant page chrome.
 */
const RICH_FIELD_MIN_CHARS = 40;

/**
 * True when the focused element yielded a substantial body — the email/message/
 * doc the user is acting on — via either the caret split or the whole-text read.
 * Drives the focused-field-first decision in {@link buildPromptSections}.
 */
/**
 * De-noise a caret/field string for the LLM AND strip dated inbox/feed
 * list-scrollback (Gmail/Outlook-web flatten the whole inbox into the focused
 * composer's text range — see {@link stripListScrollback}). This is the single
 * "clean caret context" funnel used by both the richness gate and the emitted
 * sections, so the rich-vs-thin decision is made on REAL content (an inbox-only
 * field strips to empty → thin → falls through to the Tier-3 tree pruner).
 */
function cleanCaret(raw: string | undefined): string {
	return stripListScrollback(denoiseForLlm(raw));
}

function focusedFieldIsRich(snapshot: WindowContextSnapshot): boolean {
	const caretChars = cleanCaret(snapshot.textBefore).length + cleanCaret(snapshot.textAfter).length;
	if (caretChars >= RICH_FIELD_MIN_CHARS) {
		return true;
	}
	return cleanCaret(snapshot.focusedText).length >= RICH_FIELD_MIN_CHARS;
}

/** The lightweight "where are we" sections — app / IDE / URL / window / focused
 *  field. Always safe to include: short, no scraped body content. */
function buildMetadataSections(snapshot: WindowContextSnapshot): readonly PromptSection[] {
	return [
		{ key: "app", value: trimOrEmpty(snapshot.appExe) },
		{ key: "ide", value: ideMarkerFor(snapshot) },
		{ key: "url", value: trimOrEmpty(snapshot.url) },
		{ key: "window", value: snapshot.windowTitle.trim() },
		{ key: "field", value: snapshot.elementName.trim() },
	];
}

/** Caps for the supplementary context fields. Selected text keeps its HEAD (a
 *  coherent highlighted block reads top-down); clipboard keeps its HEAD too. */
const SELECTED_TEXT_LLM_MAX = 4000;
const CLIPBOARD_LLM_MAX = 2000;

/** The user's explicit selection — the strongest intent signal. Emitted right
 *  after the metadata so it leads the content the LLM reasons over. Empty (and
 *  thus filtered out) when nothing was selected. */
function buildSelectedTextSection(snapshot: WindowContextSnapshot): PromptSection {
	return {
		key: "selection",
		value: clipHead(cleanCaret(snapshot.selectedText), SELECTED_TEXT_LLM_MAX),
	};
}

/** Clipboard interleave — lowest-priority supplementary context, so it's emitted
 *  last. Already echo-guarded at capture time (never carries our own last
 *  paste), but flagged "use only if relevant" so the LLM can ignore stale copies. */
function buildClipboardSection(snapshot: WindowContextSnapshot): PromptSection {
	return {
		key: "clipboard",
		value: clipHead(cleanCaret(snapshot.clipboardText), CLIPBOARD_LLM_MAX),
	};
}

function buildPromptSections(snapshot: WindowContextSnapshot): readonly PromptSection[] {
	const meta = buildMetadataSections(snapshot);
	// Supplementary context, shared by every branch: the explicit selection
	// (highest-signal, leads) and the clipboard interleave (lowest, trails).
	// Empty sections are filtered by sectionHasValue, so they're no-ops when absent.
	const selected = buildSelectedTextSection(snapshot);
	const clip = buildClipboardSection(snapshot);
	// Terminal/console: the scrollback (axHtml tree + caret text) is re-render
	// soup, not "what the user is acting on". Omit it and just flag the surface
	// so the LLM knows where the dictation lands without the noise.
	if (looksLikeTerminal(snapshot)) {
		return [
			...meta,
			selected,
			{
				key: "note",
				value: "Terminal/console focused — scrollback omitted (no clean prior text available).",
			},
			clip,
		];
	}
	const content = buildContentSections(snapshot);
	// Focused-field-first (mirrors Wispr Flow's "reads limited text near your
	// cursor" + superwhisper's focused-input capture — no mainstream dictation
	// tool dumps the whole a11y tree). When the focused element yields a real
	// body (email/message/doc), THAT is the context; the full-window axHtml tree
	// is redundant page chrome (inbox list, 60 browser tabs, bookmark bar) and is
	// dropped. Only when the focused field is thin (empty reply box, canvas,
	// game, odd app) do we fall back to the tree + OCR for surrounding context.
	if (focusedFieldIsRich(snapshot)) {
		return [...meta, selected, ...content, clip];
	}
	return [
		...meta,
		selected,
		buildFallbackTreeSection(snapshot),
		...content,
		buildOcrSection(snapshot),
		clip,
	];
}

/**
 * The "what's around the thin focused field" section. Tier 3: try the
 * role-pruned tree first (just the item the user is acting on — the original
 * email, the message thread); only if that can't beat the raw tree do we fall
 * back to dumping the whole axHtml. Both are reference-only for the LLM.
 */
function buildFallbackTreeSection(snapshot: WindowContextSnapshot): PromptSection {
	// Canvas/grid surfaces (Figma, Canva, Google Sheets) expose only chrome via
	// UIA — their real content is painted to <canvas>. Skip the tree entirely so
	// we don't leak menu/panel labels; the OCR section carries these instead.
	if (isCanvasSurface(snapshot.appExe, snapshot.url)) {
		return { key: "screen", value: "" };
	}
	const pruned = pruneAxHtmlForLlm(snapshot.axHtml);
	if (pruned.length > 0) {
		return { key: "screen", value: pruned };
	}
	// Fall back to the raw axHtml when the pruner couldn't isolate the focused
	// item — handed to the LLM as the `screen` field (reference only; the system
	// prompt instructs it not to echo the context).
	return { key: "screen", value: trimOrEmpty(snapshot.axHtml) };
}

function buildOcrSection(snapshot: WindowContextSnapshot): PromptSection {
	return {
		key: "screenOcr",
		value: collapseBlankLines(snapshot.ocrText),
	};
}

function buildContentSections(snapshot: WindowContextSnapshot): readonly PromptSection[] {
	const before = cleanCaret(snapshot.textBefore);
	const after = cleanCaret(snapshot.textAfter);
	if (isCaretMode(before, after)) {
		return buildCaretSections(before, after);
	}
	return [
		{
			key: "fieldText",
			value: cleanCaret(snapshot.focusedText),
		},
	];
}

function isCaretMode(before: string, after: string): boolean {
	return before.length > 0 || after.length > 0;
}

/**
 * Backstop caps for the caret context handed to the LLM. The native helper
 * bounds capture at CARET_BEFORE_CHARS=21000 / CARET_AFTER_CHARS=2000
 * (winstt-context.c) — these match that BEFORE budget (24000 ≥ 21000) and the
 * AFTER budget (2000) so a deep thread / ~100-turn chat / very long email is
 * NEVER cropped here; they only fire if some other path (a future capture
 * source, a non-native test, a pathological field) produces a giant string,
 * keeping the dictation prompt bounded. `before` keeps its TAIL (the text
 * nearest the caret is the highest-signal continuation context); `after` keeps
 * its HEAD (the text the output sits in front of).
 */
const CARET_BEFORE_LLM_MAX = 24_000;
const CARET_AFTER_LLM_MAX = 2000;

function clipTail(value: string, max: number): string {
	return value.length > max ? value.slice(value.length - max) : value;
}

function clipHead(value: string, max: number): string {
	return value.length > max ? value.slice(0, max) : value;
}

function buildCaretSections(before: string, after: string): readonly PromptSection[] {
	return [
		{ key: "beforeCaret", value: clipTail(before, CARET_BEFORE_LLM_MAX) },
		{ key: "afterCaret", value: clipHead(after, CARET_AFTER_LLM_MAX) },
	];
}

/**
 * Extract a prior-text fragment from the snapshot for use as a Whisper
 * `initial_prompt` tail. Returns "" when nothing useful is present.
 *
 * Whisper's prompt is decoder context — it conditions the model as if the
 * prompt were prior speech. The highest-signal slice we have is `textBefore`
 * (the user's caret-leading text in the focused field). We do NOT include
 * `appExe` / `url` / `axHtml` / window titles — structured metadata degrades
 * the decoder. Terminal/console scrollback is suppressed entirely (re-render
 * soup, never the user's prior text). The deny-list path emits
 * {@link redactSensitiveFields}, which strips `textBefore`, so a denied
 * snapshot extracts to "".
 */
export function extractAsrPromptTail(snapshot: WindowContextSnapshot): string {
	// Terminal/console scrollback is re-render soup (animation frames, ANSI
	// residue, lost spaces) — never the user's prior text. Feeding it to Whisper
	// only biases the decoder toward noise, so suppress it entirely for terminals.
	if (looksLikeTerminal(snapshot)) {
		return "";
	}
	const before = snapshot.textBefore;
	if (typeof before !== "string") {
		return "";
	}
	// Strip dated inbox/feed scrollback so Whisper's prior-text bias never
	// includes unrelated inbox subjects. The downstream sanitiseContextTail still
	// removes decorative noise and caps to ~500 chars. (No PII redaction — the
	// tail only biases a LOCAL Whisper decoder; nothing leaves the machine.)
	return stripListScrollback(before.trim());
}
