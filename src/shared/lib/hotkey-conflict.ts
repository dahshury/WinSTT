/**
 * Pairwise conflict detection between two uiohook-style accelerator strings
 * (e.g. `"LCtrl+LShift+V"`).
 *
 * The matchers in `hotkey.ts`, `tts-hotkey.ts`, and (effectively)
 * `repaste-hotkey.ts` all fire when their bound key set is a SUBSET of the
 * currently-held physical keys. That means two bindings collide whenever one's
 * key set is equal to, a subset of, or a superset of the other's — pressing
 * the larger combo satisfies both, so the smaller one fires "by accident".
 *
 * The two combos are DISJOINT only when each has at least one token the other
 * lacks. We forbid every non-disjoint relation in the UI; this module supplies
 * the structural check.
 *
 * Order- and case-insensitive: tokens are normalized via trim+lowercase before
 * comparison. Whitespace-only tokens are dropped. This matches the format the
 * `HotkeyRecorder` emits (canonical "LCtrl+A") while still defending against
 * hand-edits in settings.json that drift on casing or spacing.
 */

export type HotkeyRelation = "disjoint" | "equal" | "subset" | "superset";

function toTokenSet(combo: string): Set<string> {
	const out = new Set<string>();
	for (const part of combo.split("+")) {
		const token = part.trim().toLowerCase();
		if (token !== "") {
			out.add(token);
		}
	}
	return out;
}

function allIn(needle: Set<string>, haystack: Set<string>): boolean {
	for (const t of needle) {
		if (!haystack.has(t)) {
			return false;
		}
	}
	return true;
}

/**
 * Classify the relationship from `a`'s perspective:
 *   - `"equal"`     — same set of keys
 *   - `"subset"`    — every key in `a` is in `b`, and `b` has more (pressing `b` fires `a`)
 *   - `"superset"`  — every key in `b` is in `a`, and `a` has more (pressing `a` fires `b`)
 *   - `"disjoint"`  — neither set contains the other (no accidental trigger)
 *
 * Empty inputs always resolve to `"disjoint"` — they cannot collide because an
 * empty combo registers no listener. The post-Task-#1 schema guarantees no
 * hotkey is ever persisted empty, but this guard keeps the function total.
 */
function classifyEqualSize(sa: Set<string>, sb: Set<string>): HotkeyRelation {
	return allIn(sa, sb) ? "equal" : "disjoint";
}

function classifyAsubsetOfB(sa: Set<string>, sb: Set<string>): HotkeyRelation {
	return allIn(sa, sb) ? "subset" : "disjoint";
}

function classifyBsubsetOfA(sa: Set<string>, sb: Set<string>): HotkeyRelation {
	return allIn(sb, sa) ? "superset" : "disjoint";
}

function classifyDifferentSize(
	sa: Set<string>,
	sb: Set<string>,
): HotkeyRelation {
	return sa.size < sb.size
		? classifyAsubsetOfB(sa, sb)
		: classifyBsubsetOfA(sa, sb);
}

function classifyBySize(sa: Set<string>, sb: Set<string>): HotkeyRelation {
	return sa.size === sb.size
		? classifyEqualSize(sa, sb)
		: classifyDifferentSize(sa, sb);
}

export function compareHotkeys(a: string, b: string): HotkeyRelation {
	const sa = toTokenSet(a);
	const sb = toTokenSet(b);
	if (sa.size === 0 || sb.size === 0) {
		return "disjoint";
	}
	return classifyBySize(sa, sb);
}

/** Convenience: true when the relation is anything other than "disjoint". */
export function isHotkeyConflict(rel: HotkeyRelation): boolean {
	return rel !== "disjoint";
}

/**
 * Settled values for the three configurable hotkeys plus a report of any
 * fields the resolver had to rewrite. `pushToTalkKey` is treated as the
 * primary binding (users rebind it most often, and it's the only one with a
 * dedicated "Push-to-Talk Key" label in the UI); the other two are reset to
 * their defaults when they collide with it OR with each other.
 */
export interface HotkeyTriple {
	pushToTalkKey: string;
	repasteHotkey: string;
	ttsHotkey: string;
}

export interface HotkeyTripleResolution {
	rewrites: Array<keyof HotkeyTriple>;
	values: HotkeyTriple;
}

/**
 * Force-resolve a three-hotkey triple so no pair has a subset / superset /
 * equal relationship. Defense-in-depth against hand-edited settings.json or
 * a sync conflict that smuggled overlapping combos past the schema.
 *
 * Policy:
 *   1. `pushToTalkKey` is the anchor — it is never rewritten by this pass.
 *   2. `repasteHotkey` is reset to its default if it conflicts with PTT.
 *   3. `ttsHotkey` is reset to its default if it conflicts with PTT or with
 *      the (now-settled) repaste binding.
 *   4. If a default would ALSO conflict (e.g. a user set PTT to the same
 *      combo a default uses), the function leaves the post-default value in
 *      place. Such cases are rare and self-evident in the UI — the recorder
 *      shows the inline error on next interaction, prompting the user to
 *      pick a non-conflicting combo by hand.
 */
function ttsConflictsWithAny(values: HotkeyTriple): boolean {
	return (
		isHotkeyConflict(compareHotkeys(values.pushToTalkKey, values.ttsHotkey)) ||
		isHotkeyConflict(compareHotkeys(values.repasteHotkey, values.ttsHotkey))
	);
}

export function resolveHotkeyTriple(
	candidate: HotkeyTriple,
	defaults: HotkeyTriple,
): HotkeyTripleResolution {
	const rewrites: Array<keyof HotkeyTriple> = [];
	const values: HotkeyTriple = { ...candidate };

	if (
		isHotkeyConflict(compareHotkeys(values.pushToTalkKey, values.repasteHotkey))
	) {
		values.repasteHotkey = defaults.repasteHotkey;
		rewrites.push("repasteHotkey");
	}
	if (ttsConflictsWithAny(values)) {
		values.ttsHotkey = defaults.ttsHotkey;
		rewrites.push("ttsHotkey");
	}
	return { values, rewrites };
}

/**
 * The full set of five globally-registered hotkeys the runtime registrars can
 * double-fire on when combos overlap: PTT, repaste, TTS, the text-transform
 * trigger, and the post-processing profile-swap cycle. `resolveHotkeyTriple`
 * only reconciled the first three; the transform and profile-swap combos went
 * out unprotected, so a decode could leave two runtime bindings colliding.
 * This resolves all five under the same anchor-then-settle policy.
 */
export interface HotkeySet extends HotkeyTriple {
	profileSwapHotkey: string;
	transformHotkey: string;
}

export interface HotkeySetResolution {
	rewrites: Array<keyof HotkeySet>;
	values: HotkeySet;
}

// PTT is the anchor (index 0, never rewritten). The rest are settled in order:
// each is reset to its default if it conflicts with any already-settled combo.
const HOTKEY_RESOLVE_ORDER: Array<keyof HotkeySet> = [
	"pushToTalkKey",
	"repasteHotkey",
	"ttsHotkey",
	"transformHotkey",
	"profileSwapHotkey",
];

/**
 * Force-resolve all five hotkeys so no pair has a subset / superset / equal
 * relationship. `pushToTalkKey` anchors; the remaining four are each reset to
 * their default when they collide with any earlier-settled binding. Same
 * defense-in-depth rationale as `resolveHotkeyTriple`, extended to the two
 * combos (transform + profile-swap) that were previously unguarded.
 */
export function resolveHotkeySet(
	candidate: HotkeySet,
	defaults: HotkeySet,
): HotkeySetResolution {
	const rewrites: Array<keyof HotkeySet> = [];
	const values: HotkeySet = { ...candidate };
	const settled: string[] = [values.pushToTalkKey];
	for (const key of HOTKEY_RESOLVE_ORDER.slice(1)) {
		const conflicts = settled.some((prior) =>
			isHotkeyConflict(compareHotkeys(prior, values[key])),
		);
		if (conflicts) {
			values[key] = defaults[key];
			rewrites.push(key);
		}
		settled.push(values[key]);
	}
	return { values, rewrites };
}
