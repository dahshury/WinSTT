import type { TranscriptionItem } from "../model/transcription";

export interface TranscriptionLineProps {
	item: TranscriptionItem;
	index: number;
}

export function TranscriptionLine({ item, index }: TranscriptionLineProps) {
	const isRealtime = item.type === "realtime";

	return (
		<div
			className="flex animate-fade-in gap-2 rounded px-3 py-1.5 motion-reduce:animate-none"
			style={{
				animationDelay: `${Math.min(index * 20, 200)}ms`,
				animationFillMode: "both",
			}}
		>
			<div
				className={`mt-1.5 h-3 w-0.5 shrink-0 rounded-full ${isRealtime ? "bg-foreground-dim" : "bg-accent opacity-60"}`}
			/>
			<span
				className={`break-words font-sans text-sm leading-relaxed ${isRealtime ? "text-foreground-muted italic" : "text-foreground"}`}
			>
				{item.text}
			</span>
		</div>
	);
}
