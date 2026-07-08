import { Slider as BaseSlider } from "@base-ui/react/slider";
import { useState } from "react";
import { cn } from "@/shared/lib/cn";

/**
 * Which palette the scrubber paints with:
 * - `overlay` — fixed near-white (`overlay-foreground`) for the dark glass TTS
 *   island, where the surface is always dark regardless of app theme.
 * - `surface` — theme `foreground` tokens for cards that follow the app theme
 *   (the history playback bar), so the rail stays visible in light mode too.
 */
export type MediaSeekTone = "overlay" | "surface";

interface MediaSeekBarProps {
	/** Furthest reachable point (seconds) — drawn as the buffered underlay. For a
	 *  fully-loaded clip pass `duration` so the underlay spans the whole rail. */
	bufferedEnd: number;
	className?: string;
	/** Played position (seconds). */
	currentTime: number;
	disabled?: boolean;
	/** Total seconds — the slider's `max` (may grow while a stream buffers). */
	duration: number;
	onSeek: (seconds: number) => void;
	/** Palette. Defaults to `overlay` so the TTS island is unchanged. */
	tone?: MediaSeekTone;
}

function clampPct(n: number, max: number): number {
	if (max <= 0) {
		return 0;
	}
	return Math.min(100, Math.max(0, (n / max) * 100));
}

const TONE_CLASSES: Record<
	MediaSeekTone,
	{ rail: string; buffered: string; fill: string; thumb: string }
> = {
	overlay: {
		rail: "bg-overlay-foreground/15",
		buffered: "bg-overlay-foreground/30",
		fill: "bg-overlay-foreground/80",
		thumb: "bg-overlay-foreground shadow-glass-chip",
	},
	surface: {
		rail: "bg-foreground/15",
		buffered: "bg-foreground/25",
		fill: "bg-foreground/70",
		thumb: "bg-foreground shadow-sm",
	},
};

/**
 * Compact media-player scrubber. Built on the same Base UI slider primitive as
 * the shared {@link Slider} (so keyboard + pointer scrubbing and a11y come for
 * free): a thin rail with a buffered underlay beneath the played fill, and a
 * thumb that surfaces on hover / drag / focus.
 *
 * Seeking is committed on release (`onValueCommitted`), not on every drag tick,
 * so a consumer whose seek is expensive (the TTS island tears down and
 * reschedules Web Audio sources) is only asked to seek once per gesture. The
 * thumb tracks a local `scrub` value while dragging so it still feels live, then
 * snaps to the consumer's reported position once the seek lands.
 *
 * Shared by the TTS read-aloud island (`tone="overlay"`) and the history
 * playback bar (`tone="surface"`).
 */
export function MediaSeekBar({
	bufferedEnd,
	className,
	currentTime,
	disabled,
	duration,
	onSeek,
	tone = "overlay",
}: MediaSeekBarProps) {
	const [scrub, setScrub] = useState<number | null>(null);
	const max = duration > 0 ? duration : 1;
	const value = Math.min(Math.max(scrub ?? currentTime, 0), max);
	const palette = TONE_CLASSES[tone];
	return (
		<BaseSlider.Root
			aria-label="Seek"
			className={cn(
				"group/seek relative flex h-5 touch-none select-none items-center",
				disabled && "pointer-events-none opacity-50",
				className,
			)}
			disabled={disabled}
			max={max}
			min={0}
			onValueChange={(next) => setScrub(next)}
			onValueCommitted={(next) => {
				onSeek(next);
				setScrub(null);
			}}
			step={0.05}
			value={value}
		>
			<BaseSlider.Control className="relative flex h-full w-full cursor-pointer items-center outline-none">
				<BaseSlider.Track className="relative flex h-full w-full items-center">
					{/* Thin visible rail — clips/rounds the fills; the thumb sits OUTSIDE
					    it (a Track child) so it isn't cropped by this overflow-hidden. */}
					<div
						className={cn(
							"relative h-1 w-full overflow-hidden rounded-full",
							palette.rail,
						)}
					>
						<div
							aria-hidden="true"
							className={cn(
								"absolute inset-y-0 left-0 rounded-full",
								palette.buffered,
							)}
							style={{ width: `${clampPct(bufferedEnd, max)}%` }}
						/>
						<div
							aria-hidden="true"
							className={cn(
								"absolute inset-y-0 left-0 rounded-full",
								palette.fill,
							)}
							style={{ width: `${clampPct(value, max)}%` }}
						/>
					</div>
					<BaseSlider.Thumb
						className={cn(
							"size-2.5 rounded-full opacity-0 transition-opacity duration-150 group-hover/seek:opacity-100 group-data-[dragging]/seek:opacity-100 has-[:focus-visible]:opacity-100",
							palette.thumb,
						)}
					/>
				</BaseSlider.Track>
			</BaseSlider.Control>
		</BaseSlider.Root>
	);
}
