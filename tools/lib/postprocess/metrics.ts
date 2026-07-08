// Deterministic metric layer: magnitude (how much the text changed) and guards
// (cheap sanity gates the judge must never override). None of this calls a
// model except semantic delta, which needs precomputed embeddings passed in.

function words(text: string): string[] {
	return text
		.toLowerCase()
		.replace(/\s+/g, " ")
		.trim()
		.split(" ")
		.filter(Boolean);
}

/** Word-level Levenshtein normalized by the longer token count → 0..1.
 *  "How much of the wording changed", independent of meaning. */
export function surfaceDelta(before: string, after: string): number {
	const a = words(before);
	const b = words(after);
	if (a.length === 0 && b.length === 0) return 0;
	const maxLen = Math.max(a.length, b.length);
	if (maxLen === 0) return 0;
	let prev = new Array<number>(b.length + 1);
	let curr = new Array<number>(b.length + 1);
	for (let j = 0; j <= b.length; j++) prev[j] = j;
	for (let i = 1; i <= a.length; i++) {
		curr[0] = i;
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
		}
		[prev, curr] = [curr, prev];
	}
	return Math.min(1, prev[b.length]! / maxLen);
}

export function cosine(a: number[], b: number[]): number | null {
	if (a.length === 0 || a.length !== b.length) return null;
	let dot = 0;
	let na = 0;
	let nb = 0;
	for (let i = 0; i < a.length; i++) {
		const x = a[i]!;
		const y = b[i]!;
		dot += x * y;
		na += x * x;
		nb += y * y;
	}
	if (na === 0 || nb === 0) return null;
	return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** 1 - cosine(before, after), clamped 0..1. "How much the meaning moved."
 *  Returns null when embeddings were unavailable. */
export function semanticDelta(
	embBefore: number[] | null,
	embAfter: number[] | null,
): number | null {
	if (!embBefore || !embAfter) return null;
	const c = cosine(embBefore, embAfter);
	if (c === null) return null;
	return Math.min(1, Math.max(0, 1 - c));
}

export interface GuardResult {
	name: string;
	pass: boolean;
	detail: string;
}

export interface GuardReport {
	results: GuardResult[];
	pass: boolean;
}

const LEAK_PREAMBLE =
	/^\s*(sure|certainly|okay|ok|here('|’)?s|here is|of course|i('| ha)ve|i will|as an ai|the (cleaned|transformed|rewritten|revised|updated|corrected) (text|version)|below is)\b/i;
const MARKDOWN_INJECTION = /\*\*|__|<mark\b|==[^=]|^#{1,6}\s/im;
const LITERAL_PATTERNS: RegExp[] = [
	/\bhttps?:\/\/[^\s"')]+/gi, // URLs
	/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/gi, // emails
	/\b[a-z]:\\[^\s"']+/gi, // windows paths
	/\b[\w.-]+\.(?:com|org|net|io|dev|ai)\b/gi, // bare domains
];

/** Modifiers whose whole job is to compress — length shrink is expected. */
const SHRINKING = new Set(["concise", "summarize"]);
/** Translate legitimately changes almost every surface token and the
 *  source-language embedding, so magnitude-based guards do not apply. */
const TRANSLATING = new Set(["translate"]);

export function runGuards(
	before: string,
	after: string,
	modifierId: string,
): GuardReport {
	const results: GuardResult[] = [];

	const nonEmpty = after.trim().length > 0;
	results.push({
		name: "non-empty",
		pass: nonEmpty,
		detail: nonEmpty ? "" : "empty output",
	});

	const leak = LEAK_PREAMBLE.test(after);
	results.push({
		name: "no-preamble-leak",
		pass: !leak,
		detail: leak ? `leading commentary: "${after.slice(0, 40)}…"` : "",
	});

	const md = MARKDOWN_INJECTION.test(after);
	results.push({
		name: "no-markdown-injection",
		pass: !md,
		detail: md ? "unrequested emphasis/heading/highlight" : "",
	});

	// Length sanity: shrinkers may go short; everyone else must not gut or balloon
	// the text. Skipped for translate (token counts diverge across languages).
	if (!TRANSLATING.has(modifierId)) {
		const inLen = words(before).length;
		const outLen = words(after).length;
		const ratio = inLen === 0 ? 1 : outLen / inLen;
		const floor = SHRINKING.has(modifierId) ? 0.1 : 0.45;
		const ok = ratio >= floor && ratio <= 4;
		results.push({
			name: "length-sanity",
			pass: ok,
			detail: ok ? "" : `output/input word ratio ${ratio.toFixed(2)}`,
		});
	}

	// Literal preservation: any URL/email/path/domain present verbatim in the
	// input must survive (case-insensitively) in the output. No effect when the
	// input has no such literals.
	if (!TRANSLATING.has(modifierId)) {
		const lowerAfter = after.toLowerCase();
		const missing: string[] = [];
		for (const pattern of LITERAL_PATTERNS) {
			for (const m of before.matchAll(pattern)) {
				const literal = m[0].toLowerCase();
				if (!lowerAfter.includes(literal)) missing.push(m[0]);
			}
		}
		const ok = missing.length === 0;
		results.push({
			name: "literal-preservation",
			pass: ok,
			detail: ok ? "" : `dropped: ${missing.slice(0, 3).join(", ")}`,
		});
	}

	return { results, pass: results.every((r) => r.pass) };
}

/** Interpret the 2D magnitude signal into a diagnostic label. */
export function magnitudeVerdict(
	surface: number,
	semantic: number | null,
	modifierId: string,
): string {
	if (TRANSLATING.has(modifierId)) return "translation";
	const highSurface = surface >= 0.15;
	if (semantic === null) {
		return highSurface ? "modified" : "near-no-op";
	}
	const highSemantic = semantic >= 0.12;
	if (!highSurface && !highSemantic) return "no-op";
	if (highSurface && !highSemantic) return "clean-restyle";
	if (highSurface && highSemantic) return "meaning-drift";
	return "subtle-meaning-shift";
}
