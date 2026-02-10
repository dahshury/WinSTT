"use client";

import { memo, useEffect, useRef, useState } from "react";
import { useTranscriptionStore } from "@/features/live-transcription";
import { useSettingsStore } from "@/features/update-settings";

const VISIBLE_COUNT = 3;
const FADE_OPACITIES = [1, 0.4, 0.15];

/** Items start fading after this many ms since their timestamp. */
const FADE_AFTER_MS = 5000;
/** Items are fully transparent after this many ms. */
const GONE_AFTER_MS = 8000;

function timeFade(timestamp: number, now: number): number {
	const age = now - timestamp;
	if (age < FADE_AFTER_MS) {
		return 1;
	}
	if (age > GONE_AFTER_MS) {
		return 0;
	}
	return 1 - (age - FADE_AFTER_MS) / (GONE_AFTER_MS - FADE_AFTER_MS);
}

export const SubtitleOverlay = memo(function SubtitleOverlay() {
	const items = useTranscriptionStore((s) => s.items);
	const currentRealtime = useTranscriptionStore((s) => s.currentRealtime);
	const isListenMode = useSettingsStore((s) => s.settings.general?.recordingMode) === "listen";
	const scrollRef = useRef<HTMLDivElement>(null);
	const [now, setNow] = useState(Date.now);

	// Tick every 500ms so time-based fading updates smoothly.
	useEffect(() => {
		const id = setInterval(() => setNow(Date.now()), 500);
		return () => clearInterval(id);
	}, []);

	// Auto-scroll to bottom in listen mode when content changes.
	// items.length and currentRealtime are intentional triggers (not used in the body).
	// biome-ignore lint/correctness/useExhaustiveDependencies: intentional scroll triggers
	useEffect(() => {
		if (isListenMode && scrollRef.current) {
			scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
		}
	}, [isListenMode, items.length, currentRealtime]);

	if (isListenMode) {
		const hasContent = items.length > 0 || currentRealtime;
		if (!hasContent) {
			return null;
		}

		return (
			<div
				className="titlebar-no-drag absolute inset-0 flex flex-col justify-end overflow-y-auto"
				ref={scrollRef}
				style={{
					maskImage: "linear-gradient(to bottom, transparent 0%, black 40%)",
					WebkitMaskImage: "linear-gradient(to bottom, transparent 0%, black 40%)",
				}}
			>
				<div className="flex flex-col items-center gap-0.5 px-5 pt-12 pb-3">
					{items.map((item) => {
						const tf = timeFade(item.timestamp, now);
						if (tf <= 0) {
							return null;
						}
						return (
							<p
								className="max-w-full text-center font-sans text-[13px] text-foreground leading-snug"
								key={item.id}
								style={{ opacity: tf, transition: "opacity 300ms ease-out" }}
							>
								{item.text}
							</p>
						);
					})}
					{currentRealtime && (
						<p className="max-w-full text-center font-sans text-[13px] text-foreground/60 italic leading-snug">
							{currentRealtime}
						</p>
					)}
				</div>
			</div>
		);
	}

	// Normal mode — show last 3 items with discrete opacity + time-based fade
	const visibleItems = items.slice(-VISIBLE_COUNT);
	const hasContent = visibleItems.length > 0 || currentRealtime;

	if (!hasContent) {
		return null;
	}

	return (
		<div
			className="pointer-events-none absolute inset-x-0 bottom-0 flex flex-col items-center justify-end gap-0.5 px-5 pt-8 pb-2"
			style={{
				background: "linear-gradient(to bottom, transparent 0%, rgba(0,0,0,0.55) 100%)",
			}}
		>
			{visibleItems.map((item, i) => {
				const age = visibleItems.length - 1 - i;
				const positionOpacity = FADE_OPACITIES[age] ?? 0.1;
				const tf = timeFade(item.timestamp, now);
				const opacity = Math.min(positionOpacity, tf);
				if (opacity <= 0) {
					return null;
				}
				return (
					<p
						className="max-w-full text-center font-sans text-[13px] text-foreground leading-snug"
						key={item.id}
						style={{ opacity, transition: "opacity 300ms ease-out" }}
					>
						{item.text}
					</p>
				);
			})}
			{currentRealtime && (
				<p className="max-w-full text-center font-sans text-[13px] text-foreground/60 italic leading-snug">
					{currentRealtime}
				</p>
			)}
		</div>
	);
});
