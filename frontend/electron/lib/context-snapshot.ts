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
 * Automation immediately before a dictation starts.
 *
 * Two tiers of data:
 *
 *   1. The legacy minimal triple (windowTitle / elementName / focusedText)
 *      — present on every snapshot, exactly the shape `EMPTY_CONTEXT` has
 *      so the `toEqual(EMPTY_CONTEXT)` assertions throughout the test
 *      suite stay valid when nothing was captured.
 *
 *   2. Optional Wispr-style enrichments (`textBefore/After`, `appExe`,
 *      `url`, `axHtml`). Each one is attached ONLY when the native helper
 *      produced something non-empty — so a snapshot that legitimately
 *      has no caret + no tree still equals the empty triple.
 *
 * The fields:
 * - `textBefore` / `textAfter`: caret-split capture (`--split` and
 *   `--tree` paths). The LLM uses textBefore to decide whether it's
 *   continuing an unfinished sentence or starting fresh.
 * - `appExe`: lowercased process basename of the foreground window
 *   (e.g. "chrome.exe", "outlook.exe"). Powers the deny-list match —
 *   without it, the deny-list silently never fires.
 * - `url`: Browser URL extracted from the omnibox/urlbar via UIA when
 *   the foreground app is a recognized browser. Used both as a
 *   spelling hint ("we're on github.com") and as a second deny-list
 *   key (host-suffix match on `bankofamerica.com`, etc.).
 * - `axHtml`: Hierarchical XML serialization of the foreground
 *   window's UIA subtree (`--tree` path). The structure preserves the
 *   relationship between e.g. an email's sender + body + the reply
 *   field, which a flat text dump loses.
 */
export interface WindowContextSnapshot {
	/** Lowercased exe basename of the foreground window's process. */
	appExe?: string;
	/**
	 * Hierarchical XML serialization of the focused window's UIA
	 * subtree. Compact tags (window/doc/edit/text/button/...) and at
	 * most ~150K chars / 250 elements / 9 levels deep.
	 */
	axHtml?: string;
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

/** True when the snapshot's foreground app is a recognised IDE. */
function isIdeContext(snapshot: WindowContextSnapshot): boolean {
	const exe = (snapshot.appExe ?? "").toLowerCase();
	if (!exe) {
		return false;
	}
	return IDE_EXE_MATCHERS.some((match) => match(exe));
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
 * Format the snapshot into a compact prompt fragment for the LLM cleanup
 * step. Returns "" when no context is available, so callers can blindly
 * concatenate without checking.
 *
 * Shape (everything except the caret labels is conditional on the
 * corresponding field being non-empty):
 *
 *   App: chrome.exe
 *   URL: github.com
 *   Window: <title>
 *   Focused field: <element name>
 *   Visible UI:
 *   <axHtml — preserved verbatim>
 *   Text immediately before the caret: <textBefore>
 *   Text immediately after the caret: <textAfter>
 *   Visible content: <focusedText>      ← only when no caret-split present
 *
 * The two caret labels are exact literal phrases the system-prompt's
 * continuation clause matches against — don't reword them or split
 * them across lines.
 */
export function formatContextForPrompt(snapshot: WindowContextSnapshot): string {
	const sections = buildPromptSections(snapshot);
	return sections.filter(sectionHasValue).map(renderSection).join("\n");
}

interface PromptSection {
	readonly format: (value: string) => string;
	readonly value: string;
}

const BLANK_LINES_RE = /\n{2,}/g;

function collapseBlankLines(raw: string | undefined): string {
	return (raw ?? "").replace(BLANK_LINES_RE, "\n").trim();
}

function trimOrEmpty(raw: string | undefined): string {
	return (raw ?? "").trim();
}

function sectionHasValue(section: PromptSection): boolean {
	return section.value.length > 0;
}

function renderSection(section: PromptSection): string {
	return section.format(section.value);
}

function ideMarkerFor(snapshot: WindowContextSnapshot): string {
	return isIdeContext(snapshot) ? "yes" : "";
}

function buildPromptSections(snapshot: WindowContextSnapshot): readonly PromptSection[] {
	return [
		{ value: trimOrEmpty(snapshot.appExe), format: (v) => `App: ${v}` },
		{
			value: ideMarkerFor(snapshot),
			format: () => "IDE context: yes (treat visible content as code)",
		},
		{ value: trimOrEmpty(snapshot.url), format: (v) => `URL: ${v}` },
		{ value: snapshot.windowTitle.trim(), format: (v) => `Window: ${v}` },
		{ value: snapshot.elementName.trim(), format: (v) => `Focused field: ${v}` },
		// axHtml goes BEFORE the caret labels so the LLM sees the broader
		// "what is on screen" picture first, then the immediate insertion
		// point. Wrapped in a fence so the model treats the inner tags as
		// data, not as markdown / nested instructions.
		{
			value: trimOrEmpty(snapshot.axHtml),
			format: (v) => `Visible UI (XML — DO NOT echo, only use for reference):\n${v}`,
		},
		...buildContentSections(snapshot),
		{
			value: collapseBlankLines(snapshot.ocrText),
			format: (v) =>
				`Screen text (OCR — approximate, no reliable reading order; the structured fields above were empty so this is the only context):\n${v}`,
		},
	];
}

function buildContentSections(snapshot: WindowContextSnapshot): readonly PromptSection[] {
	const before = collapseBlankLines(snapshot.textBefore);
	const after = collapseBlankLines(snapshot.textAfter);
	if (isCaretMode(before, after)) {
		return buildCaretSections(before, after);
	}
	return [
		{
			value: collapseBlankLines(snapshot.focusedText),
			format: (v) => `Visible content:\n${v}`,
		},
	];
}

function isCaretMode(before: string, after: string): boolean {
	return before.length > 0 || after.length > 0;
}

function buildCaretSections(before: string, after: string): readonly PromptSection[] {
	return [
		{
			value: before,
			format: (v) =>
				`Text immediately before the caret (your cleaned output will be inserted directly after this — continue it, do not repeat it):\n${v}`,
		},
		{
			value: after,
			format: (v) =>
				`Text immediately after the caret (your output will sit directly before this — do not repeat it):\n${v}`,
		},
	];
}

/**
 * Extract a prior-text fragment from the snapshot for use as a Whisper
 * `initial_prompt` tail. Returns "" when nothing useful is present.
 *
 * Whisper's prompt is decoder context — it conditions the model as if
 * the prompt were prior speech. The highest-signal slice we have is
 * `textBefore` (the user's caret-leading text in the focused field):
 * a code editor's prior lines, an email's prior body, etc. We do NOT
 * include `appExe` / `url` / `axHtml` / window titles here — those are
 * structured metadata, not natural prior-text, and Whisper degrades when
 * the prompt isn't shaped like real speech.
 *
 * The deny-list path emits {@link redactSensitiveFields} which already
 * strips `textBefore`, so a denied snapshot extracts to "". Callers
 * needn't re-apply the deny-list filter here.
 */
export function extractAsrPromptTail(snapshot: WindowContextSnapshot): string {
	const before = snapshot.textBefore;
	if (typeof before !== "string") {
		return "";
	}
	return before.trim();
}
