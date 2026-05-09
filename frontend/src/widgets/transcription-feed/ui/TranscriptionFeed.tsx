"use client";

import { ScrollArea } from "@base-ui/react/scroll-area";
import { useTranslations } from "next-intl";
import { useConnectionStore } from "@/entities/connection";
import { useSettingsStore } from "@/entities/setting";
import { TranscriptionLine } from "@/entities/transcription";
import { useTranscriptionStore } from "@/features/live-transcription";
import { useAutoScroll } from "../lib/use-auto-scroll";

export function TranscriptionFeed() {
	const items = useTranscriptionStore((s) => s.items);
	const currentRealtime = useTranscriptionStore((s) => s.currentRealtime);
	const showInApp = useSettingsStore((s) => s.settings.general?.showInAppLiveTranscription ?? true);
	const liveText = showInApp ? currentRealtime : "";
	const connectionStatus = useConnectionStore((s) => s.connectionStatus);
	const scrollRef = useAutoScroll<HTMLDivElement>([items.length, liveText]);

	return (
		<ScrollArea.Root className="flex flex-1 flex-col rounded-lg border border-border bg-surface-secondary">
			<ScrollArea.Viewport
				className="h-full"
				ref={scrollRef}
				style={{
					WebkitMaskImage: "linear-gradient(to bottom, transparent 0%, black 20%)",
				}}
			>
				<ScrollArea.Content className="flex flex-1 flex-col p-2">
					{items.map((item, index) => (
						<TranscriptionLine index={index} item={item} key={item.id} />
					))}
					{liveText && (
						<TranscriptionLine
							index={items.length}
							item={{
								id: "realtime",
								type: "realtime",
								text: liveText,
								timestamp: 0,
							}}
						/>
					)}
					{items.length === 0 && !liveText && (
						<EmptyState connected={connectionStatus === "connected"} />
					)}
				</ScrollArea.Content>
			</ScrollArea.Viewport>
			<ScrollArea.Scrollbar className="pointer-events-none m-1 flex w-1 justify-center rounded opacity-0 transition-opacity duration-150 data-[hovering]:pointer-events-auto data-[scrolling]:pointer-events-auto data-[hovering]:opacity-100 data-[scrolling]:opacity-100 data-[scrolling]:duration-0">
				<ScrollArea.Thumb className="w-full rounded bg-foreground-dim" />
			</ScrollArea.Scrollbar>
		</ScrollArea.Root>
	);
}

function EmptyState({ connected }: { connected: boolean }) {
	const t = useTranslations("transcription");

	return (
		<div className="flex flex-1 flex-col items-center justify-center gap-3 py-8">
			{/* Stylized waveform icon */}
			<div className="flex items-end gap-0.5 opacity-20" style={{ height: "24px" }}>
				{[8, 16, 24, 20, 12, 18, 10, 22, 14].map((h) => (
					<div
						className="w-0.5 rounded-[1px] bg-foreground-muted"
						key={`empty-bar-${h}`}
						style={{ height: `${h}px` }}
					/>
				))}
			</div>
			<p className="font-mono text-foreground-dim text-xs">
				{connected ? t("waiting") : t("serverOffline")}
			</p>
		</div>
	);
}
