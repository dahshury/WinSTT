import { Button as BaseButton } from "@base-ui/react/button";
import { Slider as BaseSlider } from "@base-ui/react/slider";
import {
	setTtsVolume,
	toggleTtsMuted,
	useTtsPlaybackStore,
} from "../model/tts-playback-store";
import { CHIP_SHADOW, GLASS_SURFACE } from "./overlay-shell.shared";

/**
 * Speaker glyph for the volume toggle. Shows sound waves when audible and a
 * cross ("×") over the cone when muted (or at zero volume).
 */
function VolumeGlyph({ muted, size }: { muted: boolean; size: number }) {
	return (
		<svg
			aria-hidden="true"
			fill="none"
			height={size}
			stroke="currentColor"
			strokeLinecap="round"
			strokeLinejoin="round"
			strokeWidth={2}
			viewBox="0 0 24 24"
			width={size}
			xmlns="http://www.w3.org/2000/svg"
		>
			<path d="M11 5 6 9H3v6h3l5 4z" fill="currentColor" stroke="none" />
			{muted ? (
				<>
					<line x1="16" x2="22" y1="9" y2="15" />
					<line x1="22" x2="16" y1="9" y2="15" />
				</>
			) : (
				<>
					<path d="M15.5 8.8a4.5 4.5 0 0 1 0 6.4" />
					<path d="M18 6.5a8 8 0 0 1 0 11" />
				</>
			)}
		</svg>
	);
}

/**
 * Volume control for the TTS read-aloud island — a mute-toggle capsule plus a
 * volume slider that expands on hover / focus (adapted from the media-player
 * reference's expandable volume). The slider shows the *effective* level
 * (`muted ? 0 : volume`); dragging it up while muted unmutes, so it behaves like
 * a familiar player. Mute / volume are mirrored to the Web Audio gain via the
 * store helpers.
 */
export function TtsVolumeControl() {
	const volume = useTtsPlaybackStore((s) => s.volume);
	const muted = useTtsPlaybackStore((s) => s.muted);
	const effectiveVolume = muted ? 0 : volume;
	// Treat a zeroed slider as "muted" for the glyph even when the mute latch is
	// off, so the icon never claims sound while silent.
	const displayMuted = muted || volume <= 0;

	const onVolumeChange = (next: number) => {
		// Dragging up from a muted state unmutes first, then applies the level.
		if (muted && next > 0) {
			toggleTtsMuted();
		}
		setTtsVolume(next);
	};

	return (
		<div className="group/volume pointer-events-auto flex items-center">
			<BaseButton
				aria-label={displayMuted ? "Unmute" : "Mute"}
				className={`relative flex size-[18px] shrink-0 items-center justify-center rounded-full text-overlay-foreground/75 transition-colors hover:text-overlay-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-overlay-foreground/40 ${GLASS_SURFACE} ${CHIP_SHADOW}`}
				onClick={toggleTtsMuted}
				style={{ boxSizing: "border-box" }}
				type="button"
			>
				<VolumeGlyph muted={displayMuted} size={11} />
			</BaseButton>
			<div className="h-5 w-0 overflow-hidden opacity-0 transition-[width,opacity] duration-200 ease-out group-focus-within/volume:w-14 group-focus-within/volume:opacity-100 group-hover/volume:w-14 group-hover/volume:opacity-100">
				<div className="h-full pl-2">
					<BaseSlider.Root
						aria-label="Volume"
						className="group/vol relative flex h-full touch-none select-none items-center"
						max={1}
						min={0}
						onValueChange={(next) => onVolumeChange(next)}
						step={0.01}
						value={effectiveVolume}
					>
						<BaseSlider.Control className="relative flex h-full w-full cursor-pointer items-center outline-none">
							<BaseSlider.Track className="relative flex h-full w-full items-center">
								<div className="relative h-1 w-full overflow-hidden rounded-full bg-overlay-foreground/15">
									<div
										aria-hidden="true"
										className="absolute inset-y-0 left-0 rounded-full bg-overlay-foreground/80"
										style={{
											width: `${Math.min(100, Math.max(0, effectiveVolume * 100))}%`,
										}}
									/>
								</div>
								<BaseSlider.Thumb className="size-2 rounded-full bg-overlay-foreground opacity-0 shadow-glass-chip transition-opacity duration-150 group-hover/vol:opacity-100 group-data-[dragging]/vol:opacity-100 has-[:focus-visible]:opacity-100" />
							</BaseSlider.Track>
						</BaseSlider.Control>
					</BaseSlider.Root>
				</div>
			</div>
		</div>
	);
}
