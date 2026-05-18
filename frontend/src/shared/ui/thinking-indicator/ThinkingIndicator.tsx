"use client";

import { AnimatePresence, domAnimation, LazyMotion, m } from "motion/react";
import { type ComponentPropsWithoutRef, useEffect, useRef, useState } from "react";
import { cn } from "@/shared/lib/cn";

const CIRCLE_A =
	"M 12 8 C 14.21 8 16 9.79 16 12 C 16 14.21 14.21 16 12 16 C 9.79 16 8 14.21 8 12 C 8 9.79 9.79 8 12 8 Z";
const INFINITY_PATH =
	"M 12 12 C 14 8.5 19 8.5 19 12 C 19 15.5 14 15.5 12 12 C 10 8.5 5 8.5 5 12 C 5 15.5 10 15.5 12 12 Z";
const CIRCLE_B =
	"M 12 16 C 14.21 16 16 14.21 16 12 C 16 9.79 14.21 8 12 8 C 9.79 8 8 9.79 8 12 C 8 14.21 9.79 16 12 16 Z";

const DEFAULT_WORDS = [
	"Accomplishing",
	"Actioning",
	"Actualizing",
	"Architecting",
	"Baking",
	"Beaming",
	"Beboppin'",
	"Befuddling",
	"Billowing",
	"Blanching",
	"Bloviating",
	"Boogieing",
	"Boondoggling",
	"Booping",
	"Bootstrapping",
	"Brewing",
	"Bunning",
	"Burrowing",
	"Calculating",
	"Canoodling",
	"Caramelizing",
	"Cascading",
	"Catapulting",
	"Cerebrating",
	"Channeling",
	"Channelling",
	"Choreographing",
	"Churning",
	"Clauding",
	"Coalescing",
	"Cogitating",
	"Combobulating",
	"Composing",
	"Computing",
	"Concocting",
	"Considering",
	"Contemplating",
	"Cooking",
	"Crafting",
	"Creating",
	"Crunching",
	"Crystallizing",
	"Cultivating",
	"Deciphering",
	"Deliberating",
	"Determining",
	"Dilly-dallying",
	"Discombobulating",
	"Doing",
	"Doodling",
	"Drizzling",
	"Ebbing",
	"Effecting",
	"Elucidating",
	"Embellishing",
	"Enchanting",
	"Envisioning",
	"Evaporating",
	"Fermenting",
	"Fiddle-faddling",
	"Finagling",
	"Flambéing",
	"Flibbertigibbeting",
	"Flowing",
	"Flummoxing",
	"Fluttering",
	"Forging",
	"Forming",
	"Frolicking",
	"Frosting",
	"Gallivanting",
	"Galloping",
	"Garnishing",
	"Generating",
	"Gesticulating",
	"Germinating",
	"Gitifying",
	"Grooving",
	"Gusting",
	"Harmonizing",
	"Hashing",
	"Hatching",
	"Herding",
	"Honking",
	"Hullaballooing",
	"Hyperspacing",
	"Ideating",
	"Imagining",
	"Improvising",
	"Incubating",
	"Inferring",
	"Infusing",
	"Ionizing",
	"Jitterbugging",
	"Julienning",
	"Kneading",
	"Leavening",
	"Levitating",
	"Lollygagging",
	"Manifesting",
	"Marinating",
	"Meandering",
	"Metamorphosing",
	"Misting",
	"Moonwalking",
	"Moseying",
	"Mulling",
	"Mustering",
	"Musing",
	"Nebulizing",
	"Nesting",
	"Newspapering",
	"Noodling",
	"Nucleating",
	"Orbiting",
	"Orchestrating",
	"Osmosing",
	"Perambulating",
	"Percolating",
	"Perusing",
	"Philosophising",
	"Photosynthesizing",
	"Pollinating",
	"Pondering",
	"Pontificating",
	"Pouncing",
	"Precipitating",
	"Prestidigitating",
	"Processing",
	"Proofing",
	"Propagating",
	"Puttering",
	"Puzzling",
	"Quantumizing",
	"Razzle-dazzling",
	"Razzmatazzing",
	"Recombobulating",
	"Reticulating",
	"Roosting",
	"Ruminating",
	"Sautéing",
	"Scampering",
	"Schlepping",
	"Scurrying",
	"Seasoning",
	"Shenaniganing",
	"Shimmying",
	"Simmering",
	"Skedaddling",
	"Sketching",
	"Slithering",
	"Smooshing",
	"Sock-hopping",
	"Spelunking",
	"Spinning",
	"Sprouting",
	"Stewing",
	"Sublimating",
	"Swirling",
	"Swooping",
	"Symbioting",
	"Synthesizing",
	"Tempering",
	"Thinking",
	"Thundering",
	"Tinkering",
	"Tomfoolering",
	"Topsy-turvying",
	"Transfiguring",
	"Transmuting",
	"Twisting",
	"Undulating",
	"Unfurling",
	"Unravelling",
	"Vibing",
	"Waddling",
	"Wandering",
	"Warping",
	"Whatchamacalliting",
	"Whirlpooling",
	"Whirring",
	"Whisking",
	"Wibbling",
	"Working",
	"Wrangling",
	"Zesting",
	"Zigzagging",
] as const;
const WORD_ROTATION_MS = 4000;

// Open on "Thinking" when present so the indicator first paints with a
// familiar, on-brand word; subsequent ticks pick randomly from the full
// rotation. Falls back to index 0 for callers that pass a custom list.
function initialWordIndex(words: readonly string[]): number {
	const idx = words.indexOf("Thinking");
	return idx >= 0 ? idx : 0;
}

// Cap the streamed reasoning to a sliding tail so a chatty model can't
// blow up the pill height or churn DOM as tokens arrive. The mask at the
// top of the band fades older characters into the bubble surface anyway.
const REASONING_TAIL_CHARS = 360;

// Mono stack — no external font fetch; falls back gracefully across OSes.
// Mono creates a clean second register against the bubble's medium-weight
// system text, making the streamed reasoning unmistakably "model output"
// rather than competing with the headline state label.
const MONO_STACK =
	'ui-monospace, "JetBrains Mono", "Fira Code", Menlo, Consolas, "Liberation Mono", monospace';

function longestWord(words: readonly string[]): string {
	return words.reduce((a, b) => (a.length >= b.length ? a : b));
}

function tailOf(text: string, max: number): string {
	if (text.length <= max) {
		return text;
	}
	return text.slice(-max);
}

export interface ThinkingIndicatorProps extends ComponentPropsWithoutRef<"div"> {
	/**
	 * Live-streamed reasoning text from the model's `message.thinking`
	 * channel. Empty for non-reasoning models — the band collapses to
	 * nothing in that case so the indicator looks identical to before
	 * the streaming feature shipped.
	 */
	reasoning?: string;
	/**
	 * Wall-clock `Date.now()` of when the current LLM pass started, or
	 * `null` when no pass is active. When set, the pill renders a small
	 * monospace elapsed counter next to the rotating word so the user
	 * has a concrete sense of how long the model has been working —
	 * crucial for reasoning models where dictation→paste latency can
	 * legitimately span seconds.
	 */
	startedAt?: number | null;
	/** Cycle of status words shown one at a time with a shimmer animation. */
	words?: readonly string[];
}

function formatElapsed(ms: number): string {
	if (ms < 0) {
		return "0.0 s";
	}
	const seconds = ms / 1000;
	if (seconds < 10) {
		return `${seconds.toFixed(1)} s`;
	}
	if (seconds < 60) {
		return `${Math.round(seconds)} s`;
	}
	const m = Math.floor(seconds / 60);
	const s = Math.round(seconds % 60);
	return `${m}m ${s}s`;
}

export function ThinkingIndicator({
	className,
	words = DEFAULT_WORDS,
	reasoning = "",
	startedAt = null,
	...rest
}: ThinkingIndicatorProps) {
	const [index, setIndex] = useState(() => initialWordIndex(words));

	useEffect(() => {
		if (words.length <= 1) {
			return;
		}
		const id = setInterval(() => {
			setIndex((i) => {
				// Pick any word except the current one so the rotation always
				// visibly changes. With N≥2 entries this is a single re-roll
				// at worst — cheap, and never loops.
				const pick = Math.floor(Math.random() * (words.length - 1));
				return pick >= i ? pick + 1 : pick;
			});
		}, WORD_ROTATION_MS);
		return () => clearInterval(id);
	}, [words]);

	// Tick the elapsed-time display ~10 Hz so the counter feels live
	// without churning React too aggressively. Pinned to a ref-driven
	// state so we don't re-mount the parent on every tick.
	const [now, setNow] = useState<number>(() => Date.now());
	useEffect(() => {
		if (startedAt === null) {
			return;
		}
		setNow(Date.now());
		const id = setInterval(() => setNow(Date.now()), 100);
		return () => clearInterval(id);
	}, [startedAt]);

	const current = words[index] ?? "";
	const widestWord = longestWord(words);
	const reasoningTail = tailOf(reasoning, REASONING_TAIL_CHARS);
	const showReasoning = reasoningTail.length > 0;
	const elapsedMs = startedAt === null ? 0 : Math.max(0, now - startedAt);
	const showTimer = startedAt !== null;

	// Pin the scroll viewport to the bottom whenever new tokens arrive so
	// the reader always sees the latest chunk. Scroll is bottom-anchored
	// rather than autoscrolling on a timer to avoid jank when the model
	// pauses between bursts.
	const scrollRef = useRef<HTMLDivElement | null>(null);
	useEffect(() => {
		const el = scrollRef.current;
		if (el) {
			el.scrollTop = el.scrollHeight;
		}
	}, []);

	return (
		<LazyMotion features={domAnimation} strict>
			<div
				aria-live="polite"
				className={cn("inline-flex flex-col items-stretch gap-1.5 px-3 py-1.5", className)}
				role="status"
				{...rest}
			>
				{/* HEADLINE REGISTER — unchanged from the original indicator.
				    Topology SVG + rotating word, sentence-case medium. */}
				<div className="inline-flex items-center gap-2 self-center">
					<m.svg
						aria-hidden
						className="shrink-0 text-white/85"
						fill="none"
						height={18}
						stroke="currentColor"
						strokeLinecap="round"
						strokeLinejoin="round"
						strokeWidth={1.5}
						viewBox="0 0 24 24"
						width={18}
					>
						<m.path
							animate={{ d: [CIRCLE_A, INFINITY_PATH, CIRCLE_B, INFINITY_PATH, CIRCLE_A] }}
							transition={{
								d: {
									duration: 6,
									ease: "easeInOut",
									repeat: Number.POSITIVE_INFINITY,
									times: [0, 0.25, 0.5, 0.75, 1],
								},
							}}
						/>
					</m.svg>
					<span className="inline-grid overflow-hidden font-medium text-[13px] leading-tight">
						<span aria-hidden="true" className="shimmer-text invisible col-start-1 row-start-1">
							{widestWord}
						</span>
						<AnimatePresence initial={false} mode="popLayout">
							<m.span
								animate={{
									y: 0,
									opacity: 1,
									transition: { duration: 0.24, ease: [0.4, 0, 0.2, 1] },
								}}
								className="shimmer-text col-start-1 row-start-1"
								exit={{
									y: "-80%",
									opacity: 0,
									transition: { duration: 0.16, ease: [0.4, 0, 0.2, 1] },
								}}
								initial={{ y: "80%", opacity: 0 }}
								key={current}
							>
								{current}
							</m.span>
						</AnimatePresence>
					</span>
					{showTimer && (
						<span
							className="text-[10.5px] text-white/45 tabular-nums leading-tight"
							style={{ fontFamily: MONO_STACK, letterSpacing: "-0.005em" }}
						>
							{formatElapsed(elapsedMs)}
						</span>
					)}
				</div>

				{/* TELETYPE REGISTER — streamed reasoning. Renders only when the
				    model is emitting `message.thinking`. Mono stack creates a
				    clear semantic split from the headline; tail-fade mask makes
				    older lines dissolve into the bubble surface; trailing caret
				    pulses Docker-blue while tokens are arriving. */}
				<AnimatePresence initial={false}>
					{showReasoning && (
						<m.div
							animate={{ opacity: 1, height: "auto" }}
							className="flex w-[clamp(220px,32vw,420px)] flex-col items-stretch overflow-hidden"
							exit={{
								opacity: 0,
								height: 0,
								transition: { duration: 0.2, ease: [0.4, 0, 1, 1] },
							}}
							initial={{ opacity: 0, height: 0 }}
							key="reasoning-band"
							transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
						>
							{/* Brand-accent hairline divider — same Docker-blue
							    treatment as the bubble's top edge, but tighter
							    so the band reads as nested. */}
							<div
								aria-hidden="true"
								className="pointer-events-none h-px self-stretch bg-gradient-to-r from-transparent via-[oklch(62%_0.19_260/0.35)] to-transparent"
							/>
							{/* Scroll viewport. Mask gradient fades the top edge
							    of older text into the bubble so users only ever
							    visually anchor on the trailing tokens. */}
							<div
								className="relative mt-1 max-h-[3.6em] overflow-hidden text-white/55"
								ref={scrollRef}
								style={{
									fontFamily: MONO_STACK,
									fontSize: "10.5px",
									letterSpacing: "-0.005em",
									lineHeight: 1.45,
									WebkitMaskImage:
										"linear-gradient(to bottom, transparent 0, rgba(0,0,0,0.4) 25%, rgba(0,0,0,1) 60%)",
									maskImage:
										"linear-gradient(to bottom, transparent 0, rgba(0,0,0,0.4) 25%, rgba(0,0,0,1) 60%)",
								}}
							>
								<span className="whitespace-pre-wrap break-words">{reasoningTail}</span>
								<m.span
									animate={{ opacity: [0.25, 0.85, 0.25] }}
									aria-hidden="true"
									className="inline-block translate-y-[1px] align-baseline"
									style={{
										width: "1px",
										height: "0.95em",
										marginLeft: "2px",
										backgroundColor: "oklch(62% 0.19 260 / 0.85)",
										boxShadow: "0 0 6px 0 oklch(62% 0.19 260 / 0.45)",
									}}
									transition={{
										duration: 1.2,
										ease: "easeInOut",
										repeat: Number.POSITIVE_INFINITY,
									}}
								/>
							</div>
						</m.div>
					)}
				</AnimatePresence>
			</div>
		</LazyMotion>
	);
}
