import { Slider as BaseSlider } from "@base-ui/react/slider";
import { useState } from "react";
import { cn } from "@/shared/lib/cn";

interface TtsSeekBarProps {
	/** Furthest synthesised point (seconds) — drawn as the buffered underlay. */
	bufferedEnd: number;
	className?: string;
	/** Played position (seconds). */
	currentTime: number;
	disabled?: boolean;
	/** Total buffered seconds — the slider's `max` (grows while streaming). */
	duration: number;
	onSeek: (seconds: number) => void;
}

function clampPct(n: number, max: number): number {
	if (max <= 0) {
		return 0;
	}
	return Math.min(100, Math.max(0, (n / max) * 100));
}

/**
 * Compact media-player scrubber for the TTS read-aloud island. Built on the same
 * Base UI slider primitive as the shared {@link Slider} (so keyboard + pointer
 * scrubbing and a11y come for free) but styled for the dark "glass island": a
 * thin rail with a buffered underlay (synthesised-so-far) beneath the played
 * fill, and a thumb that surfaces on hover / drag / focus.
 *
 * Seeking is committed on release (`onValueCommitted`), not on every drag tick —
 * each seek tears down and reschedules the Web Audio sources, so committing once
 * keeps the drag smooth and click-free. The thumb tracks a local `scrub` value
 * while dragging so it still feels live, then snaps to the queue's reported
 * position once the seek lands.
 */
export function TtsSeekBar({
	bufferedEnd,
	className,
	currentTime,
	disabled,
	duration,
	onSeek,
}: TtsSeekBarProps) {
	const [scrub, setScrub] = useState<number | null>(null);
	const max = duration > 0 ? duration : 1;
	const value = Math.min(Math.max(scrub ?? currentTime, 0), max);
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
					<div className="relative h-1 w-full overflow-hidden rounded-full bg-overlay-foreground/15">
						<div
							aria-hidden="true"
							className="absolute inset-y-0 left-0 rounded-full bg-overlay-foreground/30"
							style={{ width: `${clampPct(bufferedEnd, max)}%` }}
						/>
						<div
							aria-hidden="true"
							className="absolute inset-y-0 left-0 rounded-full bg-overlay-foreground/80"
							style={{ width: `${clampPct(value, max)}%` }}
						/>
					</div>
					<BaseSlider.Thumb className="size-2.5 rounded-full bg-overlay-foreground opacity-0 shadow-glass-chip transition-opacity duration-150 group-hover/seek:opacity-100 group-data-[dragging]/seek:opacity-100 has-[:focus-visible]:opacity-100" />
				</BaseSlider.Track>
			</BaseSlider.Control>
		</BaseSlider.Root>
	);
}
