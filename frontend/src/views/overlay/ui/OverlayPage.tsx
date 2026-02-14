"use client";

import { WaveformBars } from "@/features/audio-visualizer";

export function OverlayPage() {
	return (
		<div className="relative h-screen w-screen overflow-hidden rounded-lg bg-black/60 backdrop-blur-md">
			{/* Semi-transparent background with blur */}
			<div className="absolute inset-0 bg-gradient-to-t from-black/40 to-black/20" />

			{/* Waveform visualizer */}
			<div className="relative z-10 h-full w-full">
				<WaveformBars />
			</div>
		</div>
	);
}
