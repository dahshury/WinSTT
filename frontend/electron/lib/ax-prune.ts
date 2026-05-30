/**
 * Tier-3 role-pruned axHtml fallback for the LLM context.
 *
 * Runs ONLY when the focused field is THIN (empty composer / caret-split came
 * back below the rich threshold) and we must mine the surrounding UI tree for
 * the thing the user is acting on. Designed from the 22-app profiling workflow
 * (see `context-parsing-roadmap.md`): a GLOBAL role-based prune, not per-app
 * parsers.
 *
 * Strategy (condensed from the synthesized spec):
 *   1. Parse the compact axHtml emitted by `winstt-context.c` into a node tree
 *      (locality, not role alone, decides content-vs-chrome).
 *   2. Anchor on the focused node; climb to its nearest CONTENT LANDMARK
 *      (doc/pane/group/article that also holds substantial text besides the
 *      focused edit) — the shared container of "the email + my reply" / "the
 *      thread + my composer". Everything outside it (nav rails, inbox/channel
 *      lists, tab strips, the browser omnibox) is dropped by being out of scope.
 *   3. Within the landmark, KEEP content roles and DROP chrome SUBTREES by role,
 *      with a nav-list-vs-content-list override by name + focus-locality.
 *   4. Emit each kept node's NAME and inner TEXT in document order, de-noised
 *      and capped. (UIA puts most leaf content in the `name` attribute, not
 *      inner text — so we emit both.)
 *
 * Returns "" when it can't do better than the raw tree (cold/virtualized/no
 * focus), so the caller cleanly falls back to the raw axHtml + OCR path — the
 * pruner never regresses behaviour.
 *
 * Pure module (no electron import) so bun:test can exercise it directly, same
 * as `context-snapshot.ts`. Owns the shared LLM de-noise helper.
 */

export interface AxNode {
	children: AxNode[];
	focused: boolean;
	name: string;
	role: string;
	text: string;
}

// ── De-noise (canonical copy; mirrors ASR's sanitiseContextTail filter) ─────
// Object-replacement U+FFFC (Gmail icons/avatars — the dominant web-app noise),
// \p{C} control/format, \p{So} dingbats, bullets, and emoji. By Unicode
// CATEGORY so real scripts (\p{L}) survive. Exported + used by context-snapshot.
const LLM_NOISE_RE = /[\p{C}\p{So}•‣⁃\u{1F000}-\u{1FAFF}]/gu;
const INLINE_WS_RE = /\s+/g;

/**
 * Strip decorative/control noise for the LLM while PRESERVING line structure:
 * split on newline, de-noise + collapse inline whitespace per line, drop blank
 * lines, rejoin. Turns "￼\nHi…\n￼\n￼\nbody" into clean prose.
 */
export function denoiseForLlm(raw: string | undefined): string {
	if (!raw) {
		return "";
	}
	return raw
		.split("\n")
		.map((line) => line.replace(LLM_NOISE_RE, "").replace(INLINE_WS_RE, " ").trim())
		.filter((line) => line.length > 0)
		.join("\n")
		.trim();
}

// ── Role classification (from the synthesized global spec) ───────────────────
/** Chrome whose ENTIRE subtree is dropped — its names never reach the LLM. */
const DROP_SUBTREE_ROLES: ReadonlySet<string> = new Set([
	"toolbar",
	"tabs",
	"tab",
	"menu",
	"menuitem",
	"status",
	"button",
	"link",
	"combo",
	"check",
	"radio",
	"image",
	"tree",
	"table",
	"thead",
	"banner",
]);
/** Roles whose `name` attribute carries leaf content worth emitting. */
const NAME_EMIT_ROLES: ReadonlySet<string> = new Set(["item", "text", "node", "row", "header"]);
/** List-like containers that get the nav-vs-content locality check. */
const LIST_LIKE_ROLES: ReadonlySet<string> = new Set(["list", "item", "row", "node"]);
/** Ancestor roles that can serve as the focused element's content landmark. */
const LANDMARK_ROLES: ReadonlySet<string> = new Set(["doc", "pane", "group", "article"]);

/** A LIST whose NAME reads like navigation/inbox/roster chrome, not content.
 *  Broad vocabulary — applied only to list-like roles (list/item/row/node),
 *  where "Conversations"/"Chats" mean the inbox switcher, not the open thread. */
const NAV_NAME_RE =
	/\b(?:chats?|conversations?|inbox|channels?|direct messages|members?|participants?|navigation|recents?|files?|explorer|folders?|sidebar|side panel|mailbox|page list|pages|primary|timeline tabs|who to follow|what's happening)\b/i;
/** A CONTAINER (group/pane) NAME that's pure chrome — a side rail / nav pane /
 *  roster column. Deliberately NARROWER than NAV_NAME_RE: it must NOT contain
 *  "conversation" / "messages" / "chat", because those words name the CONTENT
 *  transcript group on chat/AI surfaces (claude.ai's `group "conversation"`,
 *  a "Messages" group). Only unambiguous chrome-container words live here. */
const CONTAINER_NAV_RE =
	/\b(?:sidebar|side panel|side bar|navigation|nav rail|primary column|sidebar column|servers?|roster|app bar|browser chrome|left rail)\b/i;
/** A list NAME that signals it IS the content thread, not nav — wins over the
 *  nav regex when both match (e.g. "Messages in conversation with Maya",
 *  "Chat Messages", "Timeline: Conversation"). Locality + this hint beat the
 *  nav-name drop, per the synthesized spec. */
const CONTENT_LIST_NAME_RE = /\b(?:messages?|conversation with|thread|comments?|timeline)\b/i;
/** Browser address bar / search box that frequently steals focus="1". */
const OMNIBOX_NAME_RE = /^(?:address and search bar|search|search mail|urlbar)$/i;

/** Canvas/grid surfaces whose real content is painted to <canvas> and not
 *  exposed via UIA — Tier 3 would only mine chrome (menus, panels, axis
 *  headers). The synthesized spec routes these to OCR (Tier 5) BEFORE Tier 3.
 *  Detected by exe or URL so the caller can skip the tree path entirely. */
const CANVAS_EXES: ReadonlySet<string> = new Set(["figma.exe", "canva.exe"]);
const CANVAS_URL_RE = /(?:^|\/\/|\.)(?:figma\.com|canva\.com)\b|docs\.google\.com\/spreadsheets/i;

/** True when the focused surface is a canvas/grid app (Figma, Canva, Google
 *  Sheets) whose body isn't in the UIA tree — caller should skip Tier 3 and
 *  rely on OCR instead of leaking panel/menu chrome into the LLM context. */
export function isCanvasSurface(appExe: string | undefined, url: string | undefined): boolean {
	if (appExe && CANVAS_EXES.has(appExe.toLowerCase())) {
		return true;
	}
	return Boolean(url && CANVAS_URL_RE.test(url));
}

const LEAF_MIN_CHARS = 2;
const LANDMARK_MIN_CHARS = 20;
const MAX_LLM_CONTEXT_CHARS = 5000;

// ── Parser ──────────────────────────────────────────────────────────────────
// Match each tag as a whole token. Attribute values in this axHtml are
// XML-escaped (literal `>` becomes `&gt;`), so a tag never contains a `>` —
// `<[^>]+>` is therefore a correct, robust tag tokenizer (the earlier
// single-mega-regex approach mis-parsed multi-word attribute values like
// `name="Address and search bar"`).
const TAG_RE = /<[^>]+>/g;
const ROLE_RE = /^<\/?\s*([a-z][a-z0-9]*)/i;
const NAME_ATTR_RE = /\bname="([^"]*)"/i;
const FOCUS_ATTR_RE = /\bfocus="1"/i;
const ENTITY_RE = /&(lt|gt|quot|amp|apos|#39);/g;
const ENTITY_MAP: Record<string, string> = {
	lt: "<",
	gt: ">",
	quot: '"',
	amp: "&",
	apos: "'",
	"#39": "'",
};

function unescapeEntities(value: string): string {
	return value.replace(ENTITY_RE, (whole, code: string) => ENTITY_MAP[code] ?? whole);
}

function appendText(node: AxNode, between: string): void {
	const trimmed = between.trim();
	if (trimmed.length === 0) {
		return;
	}
	const piece = unescapeEntities(trimmed);
	node.text = node.text.length > 0 ? `${node.text} ${piece}` : piece;
}

interface ParsedTag {
	focused: boolean;
	isClose: boolean;
	name: string;
	role: string;
	selfClose: boolean;
}

function classifyTag(tag: string): ParsedTag | null {
	const roleMatch = ROLE_RE.exec(tag);
	if (!roleMatch) {
		return null;
	}
	const nameMatch = NAME_ATTR_RE.exec(tag);
	return {
		focused: FOCUS_ATTR_RE.test(tag),
		isClose: tag.startsWith("</"),
		name: nameMatch ? unescapeEntities(nameMatch[1] ?? "") : "",
		role: (roleMatch[1] ?? "").toLowerCase(),
		selfClose: tag.endsWith("/>"),
	};
}

/** Parse a compact axHtml string into a node tree. Tolerant of both the real
 *  open/close form (`<role name="x">val</role>`) and self-closing (`<role/>`). */
export function parseAxHtml(ax: string): AxNode {
	const root: AxNode = { children: [], focused: false, name: "", role: "root", text: "" };
	const stack: AxNode[] = [root];
	let lastIndex = 0;
	TAG_RE.lastIndex = 0;
	let match = TAG_RE.exec(ax);
	while (match !== null) {
		appendText(stack.at(-1) as AxNode, ax.slice(lastIndex, match.index));
		lastIndex = TAG_RE.lastIndex;
		applyTag(stack, match[0]);
		match = TAG_RE.exec(ax);
	}
	return root;
}

function applyTag(stack: AxNode[], tag: string): void {
	const parsed = classifyTag(tag);
	if (!parsed) {
		return;
	}
	if (parsed.isClose) {
		if (stack.length > 1) {
			stack.pop();
		}
		return;
	}
	const node: AxNode = {
		children: [],
		focused: parsed.focused,
		name: parsed.name,
		role: parsed.role,
		text: "",
	};
	stack.at(-1)?.children.push(node);
	if (!parsed.selfClose) {
		stack.push(node);
	}
}

// ── Tree queries ─────────────────────────────────────────────────────────────
function findFocusPath(node: AxNode, path: AxNode[]): AxNode[] | null {
	const next = [...path, node];
	if (node.focused) {
		return next;
	}
	for (const child of node.children) {
		const found = findFocusPath(child, next);
		if (found) {
			return found;
		}
	}
	return null;
}

function isOmnibox(node: AxNode): boolean {
	return node.role === "edit" && OMNIBOX_NAME_RE.test(node.name.trim());
}

function containsNode(node: AxNode, target: AxNode): boolean {
	if (node === target) {
		return true;
	}
	return node.children.some((child) => containsNode(child, target));
}

/** De-noised length of the content a landmark would yield. Includes the focused
 *  node's own text: in Tier 3 the composer is empty (chat/mail), so it adds ~0
 *  and a content-bearing ancestor still wins via MAX selection — but when the
 *  focus IS the content (a code editor's Monaco edit), its text counts so the
 *  editor's doc landmark isn't measured as empty. */
function scopedContentLen(node: AxNode, focus: AxNode | null): number {
	return denoiseForLlm(collectLines(node, focus).join("\n")).length;
}

/** Among the focused element's landmark-role ancestors, pick the one with the
 *  MOST scoped content (the body the user is acting on). NOT the nearest one:
 *  the signal usually sits in a SIBLING of the thin composer (the original
 *  email beside the empty reply, the tweet beside the reply box), so the
 *  nearest wrapper ("Reply composer" with just a "Replying to …" label) is too
 *  small. Climbing to the shared container is safe because chrome subtrees
 *  (nav rails, sidebars, inbox/channel/member lists) are dropped by role + name
 *  during collection, so a higher landmark only adds real content, not chrome. */
function findLandmarkOnPath(path: AxNode[], focus: AxNode): AxNode | null {
	let best: AxNode | null = null;
	let bestLen = 0;
	for (const node of path) {
		if (node === focus || !LANDMARK_ROLES.has(node.role)) {
			continue;
		}
		const len = scopedContentLen(node, focus);
		// `>=` so that on ties we keep the HIGHER ancestor (later in the path),
		// which captures the focused field's content-bearing siblings.
		if (len >= LANDMARK_MIN_CHARS && len >= bestLen) {
			best = node;
			bestLen = len;
		}
	}
	return best;
}

/** Fallback when there is no usable focus: the landmark-role subtree carrying
 *  the most kept content (handles the flattened-doc / omnibox-focus cases). */
function findLargestLandmark(root: AxNode): AxNode | null {
	let best: AxNode | null = null;
	let bestLen = 0;
	const visit = (node: AxNode): void => {
		if (LANDMARK_ROLES.has(node.role)) {
			const len = collectLines(node, null).join("\n").length;
			if (len > bestLen) {
				bestLen = len;
				best = node;
			}
		}
		for (const child of node.children) {
			visit(child);
		}
	};
	visit(root);
	return best;
}

// ── Collection ────────────────────────────────────────────────────────────────
/** A node that reads like nav/inbox/sidebar chrome is dropped — UNLESS it
 *  contains the focus (locality) or its name signals it's the content thread
 *  ("Messages…", "…conversation with…", "Timeline…"). Applies to BOTH list-like
 *  roles (inbox/channel/member lists) AND landmark containers (group/pane named
 *  "Sidebar column", "Navigation"), so climbing to a high landmark stays safe.
 *  Locality + content-hint beat the nav-name drop, per the synthesized spec. */
function isNavChrome(node: AxNode, focus: AxNode | null): boolean {
	if (CONTENT_LIST_NAME_RE.test(node.name)) {
		return false;
	}
	// Lists use the broad nav vocabulary (inbox/channels/members); landmark
	// containers use the NARROW one (sidebar/nav rail) so a content transcript
	// group named "conversation"/"messages" is never mistaken for chrome.
	const matchesNav = LIST_LIKE_ROLES.has(node.role)
		? NAV_NAME_RE.test(node.name)
		: LANDMARK_ROLES.has(node.role) && CONTAINER_NAV_RE.test(node.name);
	if (!matchesNav) {
		return false;
	}
	return !(focus && containsNode(node, focus));
}

/** Collect emit-worthy lines from a subtree. `focus` drives nav-list locality;
 *  `exclude` (when set) skips that node's OWN name/text but still recurses — used
 *  to measure a landmark's content WITHOUT counting the thin focused field. */
function collectLines(node: AxNode, focus: AxNode | null, exclude: AxNode | null = null): string[] {
	if (DROP_SUBTREE_ROLES.has(node.role) || isOmnibox(node) || isNavChrome(node, focus)) {
		return [];
	}
	const lines: string[] = [];
	if (node !== exclude) {
		if (NAME_EMIT_ROLES.has(node.role)) {
			const name = node.name.trim();
			if (name.length >= LEAF_MIN_CHARS) {
				lines.push(name);
			}
		}
		const text = node.text.trim();
		if (text.length >= LEAF_MIN_CHARS) {
			lines.push(text);
		}
	}
	for (const child of node.children) {
		lines.push(...collectLines(child, focus, exclude));
	}
	return lines;
}

/** Drop a line equal to the immediately-preceding one (UIA often exposes the
 *  same string as both `name` and inner text on one node). */
function dedupeConsecutive(lines: readonly string[]): string[] {
	const out: string[] = [];
	for (const line of lines) {
		if (line !== out.at(-1)) {
			out.push(line);
		}
	}
	return out;
}

function resolveLandmark(root: AxNode): AxNode | null {
	const path = findFocusPath(root, []);
	const focus = path?.at(-1) ?? null;
	if (focus && !isOmnibox(focus) && path) {
		const onPath = findLandmarkOnPath(path, focus);
		if (onPath) {
			return onPath;
		}
	}
	return findLargestLandmark(root);
}

/**
 * Prune an axHtml tree to just the content the user is acting on, for the LLM.
 * Returns "" when it can't meaningfully beat the raw tree, so the caller keeps
 * its existing raw-axHtml + OCR fallback.
 */
export function pruneAxHtmlForLlm(axHtml: string | undefined): string {
	if (!axHtml || axHtml.trim().length === 0) {
		return "";
	}
	const root = parseAxHtml(axHtml);
	const landmark = resolveLandmark(root);
	if (!landmark) {
		return "";
	}
	const focus = findFocusPath(root, [])?.at(-1) ?? null;
	const lines = dedupeConsecutive(collectLines(landmark, focus));
	const out = denoiseForLlm(lines.join("\n"));
	if (out.length < LANDMARK_MIN_CHARS) {
		return "";
	}
	return out.length > MAX_LLM_CONTEXT_CHARS ? out.slice(0, MAX_LLM_CONTEXT_CHARS) : out;
}
