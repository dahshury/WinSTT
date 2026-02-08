"use client";

import { WaveformBars } from "@/features/audio-visualizer";
import { useTranscriptionStore } from "@/features/live-transcription";

const VISIBLE_COUNT = 3;
const FADE_OPACITIES = [1, 0.4, 0.15];

export function AudioDisplay() {
	const items = useTranscriptionStore((s) => s.items);
	const currentRealtime = useTranscriptionStore((s) => s.currentRealtime);

	const visibleItems = items.slice(-VISIBLE_COUNT);
	const hasContent = visibleItems.length > 0 || currentRealtime;

	return (
		<div className="relative flex flex-1 flex-col items-center justify-center overflow-hidden rounded-lg border border-border bg-surface-secondary">
			<WaveformBars />

			{/* Subtitle overlay with gradient backdrop */}
			{hasContent && (
				<div
					className="pointer-events-none absolute inset-x-0 bottom-0 flex flex-col items-center justify-end gap-0.5 px-5 pt-8 pb-2"
					style={{
						background: "linear-gradient(to bottom, transparent 0%, rgba(0,0,0,0.55) 100%)",
					}}
				>
					{visibleItems.map((item, i) => {
						const age = visibleItems.length - 1 - i;
						const opacity = FADE_OPACITIES[age] ?? 0.1;
						return (
							<p
								className="max-w-full text-center font-sans text-[13px] text-white leading-snug"
								key={item.id}
								style={{ opacity, transition: "opacity 300ms ease-out" }}
							>
								{item.text}
							</p>
						);
					})}
					{currentRealtime && (
						<p className="max-w-full text-center font-sans text-[13px] text-white/60 italic leading-snug">
							{currentRealtime}
						</p>
					)}
				</div>
			)}
		</div>
	);
}
