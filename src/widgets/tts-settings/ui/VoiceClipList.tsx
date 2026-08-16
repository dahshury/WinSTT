import { AudioWave01Icon, Delete02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useId } from "react";
import type { TranslateFn } from "@/shared/i18n/translation-types";
import { cn } from "@/shared/lib/cn";
import { IconButton } from "@/shared/ui/icon-button";
import {
	clipSeconds,
	MIN_REF_CLIP_SECS,
	voiceCapacityState,
} from "../lib/clone-voice";
import type { SavedVoiceClip } from "../model/voice-library";

export interface VoiceCapacityMeterProps {
	clipCount: number;
	/** The model's reference budget in seconds, from its catalog row. `0` = the
	 *  server didn't say, so no cap is drawn and only the floor is reported. */
	maxSecs: number;
	t: TranslateFn;
	/** What the voice COSTS against `maxSecs` — its clips plus the silence welded
	 *  between them (`projectedClipSeconds`), because the backend's cap applies to
	 *  the concatenation. A bare sum of the parts would promise room the weld will
	 *  not honour. */
	usedSecs: number;
}

/**
 * How full this voice is against the model's reference budget.
 *
 * The bar answers "can I add more?" at a glance and the line under it says what
 * to do about it — the three states are the three different answers: too little
 * audio to clone from at all, room left, or full (where the next clip loses its
 * tail rather than being refused).
 *
 * Every number shown comes from the catalog row (`maxSecs`) or from the durations
 * the backend measured, so the UI never carries a second copy of a cap.
 */
export function VoiceCapacityMeter({
	clipCount,
	maxSecs,
	t,
	usedSecs,
}: VoiceCapacityMeterProps) {
	const captionId = useId();
	// A voice restored from a previous session knows its clips but not their
	// lengths (re-deriving them means decoding the audio again). Zero seconds
	// across real clips is therefore "unmeasured", not "empty" — drawing a bar at
	// 0% and telling the user to add a second of audio would be a lie about a
	// voice that works.
	const measured = usedSecs > 0;
	const state = voiceCapacityState(usedSecs, maxSecs);
	const filled = maxSecs > 0 ? Math.min(1, usedSecs / maxSecs) : 0;
	// The floor is a mark on the track rather than a number in the copy: it is
	// only ~3% of a 30 s budget, and "you need one more second" reads better as a
	// tick the fill has to clear.
	const floorAt = maxSecs > 0 ? Math.min(1, MIN_REF_CLIP_SECS / maxSecs) : 0;
	const remaining = Math.max(0, maxSecs - usedSecs);
	// "Room left" is only sayable when a cap is known; without one there is
	// nothing to be left OF, so that half of the line simply doesn't render.
	const statusText = measured
		? state === "belowMinimum"
			? t("voiceClipsBelowMinimum", { seconds: MIN_REF_CLIP_SECS })
			: state === "atCapacity"
				? t("voiceClipsAtCapacity")
				: maxSecs > 0
					? t("voiceClipsRemaining", { seconds: clipSeconds(remaining) })
					: ""
		: "";

	return (
		<div className="flex flex-col gap-1">
			{measured && maxSecs > 0 ? (
				<div
					aria-labelledby={captionId}
					aria-valuemax={maxSecs}
					aria-valuemin={0}
					aria-valuenow={usedSecs}
					className="relative h-1 w-full overflow-hidden rounded-full bg-foreground/10"
					role="progressbar"
				>
					<div
						className={cn(
							"h-full rounded-full transition-[width] duration-200 ease-out",
							state === "atCapacity" ? "bg-warning" : "bg-foreground/50",
						)}
						style={{ width: `${filled * 100}%` }}
					/>
					{/* The engine's hard floor. Drawn on top of the fill so it stays
					    visible once the voice clears it. */}
					<span
						aria-hidden="true"
						className="absolute inset-y-0 w-px bg-foreground/30"
						style={{ left: `${floorAt * 100}%` }}
					/>
				</div>
			) : null}
			<div className="flex items-baseline justify-between gap-2">
				<span
					className="text-2xs text-foreground-muted tabular-nums"
					id={captionId}
				>
					{measured && maxSecs > 0
						? `${t("voiceClipsUsed", {
								used: clipSeconds(usedSecs),
								max: maxSecs,
							})} · ${t("voiceClipCount", { count: clipCount })}`
						: t("voiceClipCount", { count: clipCount })}
				</span>
				{statusText ? (
					<span
						className={cn(
							"shrink-0 text-2xs tabular-nums",
							state === "room" ? "text-foreground-muted" : "text-warning",
						)}
						role="status"
					>
						{statusText}
					</span>
				) : null}
			</div>
		</div>
	);
}

export interface VoiceClipListProps {
	/** A build is running — every row locks so a second edit cannot race it. */
	busy: boolean;
	clips: readonly SavedVoiceClip[];
	/** Drop the clip at `index`. The caller rebuilds the voice from what is left
	 *  (and, when nothing is left, deletes the voice). */
	onRemove: (index: number) => void;
	t: TranslateFn;
}

/**
 * The clips a voice is made of, in the order they were welded.
 *
 * A list rather than a single card because the combined clip the engines load is
 * NOT decomposable — these rows are the only record of what went into it, and
 * removing one is a rebuild from the survivors.
 */
export function VoiceClipList({
	busy,
	clips,
	onRemove,
	t,
}: VoiceClipListProps) {
	if (clips.length === 0) {
		return null;
	}
	return (
		// Named so the list is announced as a group rather than as loose rows; the
		// count is the one thing that describes it, and it is already localized.
		<ul
			aria-label={t("voiceClipCount", { count: clips.length })}
			className="flex list-none flex-col gap-0.5 p-0"
		>
			{clips.map((clip, index) => (
				<li
					className="flex min-w-0 items-center gap-2"
					// The path alone is not unique: the same source added twice welds
					// twice, and both parts resolve to the same stored file.
					key={`${clip.path}:${index}`}
				>
					<HugeiconsIcon
						aria-hidden="true"
						className="size-3.5 shrink-0 text-foreground-muted"
						icon={AudioWave01Icon}
					/>
					<span
						className="min-w-0 flex-1 truncate text-body-sm text-foreground"
						dir="auto"
						title={clip.path}
					>
						{clip.name}
					</span>
					{clip.seconds > 0 ? (
						<span className="shrink-0 text-2xs text-foreground-muted tabular-nums">
							{t("cloneClipDuration", {
								seconds: clipSeconds(clip.seconds),
							})}
						</span>
					) : null}
					{/* Named after the clip it removes: five takes render five buttons,
					    and "Remove clip" five times over is neither addressable by voice
					    control nor distinguishable to a screen reader — while removing
					    the wrong row is destructive (and, at one clip, deletes the
					    voice). The tooltip inherits the same name. */}
					<IconButton
						aria-label={t("voiceRemoveClip", { name: clip.name })}
						disabled={busy}
						icon={<HugeiconsIcon icon={Delete02Icon} size={14} />}
						onClick={() => onRemove(index)}
					/>
				</li>
			))}
		</ul>
	);
}
