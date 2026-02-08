import type { TranscriptionItem } from "../model/transcription";

export interface TranscriptionLineProps {
	item: TranscriptionItem;
	index: number;
}

export function TranscriptionLine({ item, index }: TranscriptionLineProps) {
	const isRealtime = item.type === "realtime";

	return (
		<div
			className="flex animate-fade-in gap-2 rounded px-3 py-1.5"
			style={{
				animationDelay: `${Math.min(index * 20, 200)}ms`,
				animationFillMode: "both",
			}}
		>
			{/* Accent bar for final transcriptions */}
			{!isRealtime && (
				<div
					className="mt-1.5 h-3 w-0.5 shrink-0 rounded-full"
					style={{ backgroundColor: "var(--color-accent)", opacity: 0.6 }}
				/>
			)}
			{isRealtime && (
				<div
					className="mt-1.5 h-3 w-0.5 shrink-0 rounded-full"
					style={{ backgroundColor: "var(--color-text-dim)" }}
				/>
			)}
			<span
				className="text-sm leading-relaxed"
				style={{
					color: isRealtime ? "var(--color-text-muted)" : "var(--color-text-primary)",
					fontFamily: "var(--font-sans)",
					fontStyle: isRealtime ? "italic" : "normal",
				}}
			>
				{item.text}
			</span>
		</div>
	);
}
