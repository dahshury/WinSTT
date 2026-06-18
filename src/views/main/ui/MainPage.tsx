import { Mic01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useTranslations } from "use-intl";
import { useSettingsStore } from "@/entities/setting";
import { useTranscriptionStore } from "@/entities/transcription";
import { useVisualizerStore } from "@/features/audio-visualizer";
import { shouldUseListenSurface } from "@/features/listen-mode";
import { settingsSave } from "@/shared/api/ipc-client";
import { cn } from "@/shared/lib/cn";
import { useTouchActivation } from "@/shared/lib/use-touch-activation";
import { Button } from "@/shared/ui/button";
import { Tooltip } from "@/shared/ui/tooltip";
import { AudioDisplay } from "@/widgets/audio-display";
import { StatusBar } from "@/widgets/status-bar";

export function MainPage() {
	const general = useSettingsStore((s) => s.settings.general);
	const isListenMode = general?.recordingMode === "listen";
	const audioLevel = useVisualizerStore((s) => s.audioLevel);
	const isSpeaking = useVisualizerStore((s) => s.isSpeaking);
	const liveText = useTranscriptionStore((s) => s.currentRealtime);
	const hasEphemeral = useTranscriptionStore((s) => s.ephemeral !== null);
	const listenSurfaceActive = shouldUseListenSurface({
		audioLevel,
		hasEphemeral,
		isListenMode,
		isSpeaking,
		liveText,
	});
	const updateGeneral = useSettingsStore((s) => s.updateGeneralSettings);
	const t = useTranslations("mainPage");
	const th = useTranslations("hotkey");
	const switchToPtt = () => {
		updateGeneral({ recordingMode: "ptt" });
		if (general) {
			void settingsSave({ general: { ...general, recordingMode: "ptt" } });
		}
	};
	const pttActivation = useTouchActivation(switchToPtt);

	return (
		<div className="relative flex h-full flex-col">
			<div
				className={`flex flex-1 flex-col overflow-hidden ${listenSurfaceActive ? "" : "p-1.5"}`}
			>
				<AudioDisplay listenSurfaceActive={listenSurfaceActive} />
			</div>

			{listenSurfaceActive && (
				<>
					{/* Drag strip — dedicated titlebar-drag region above canvas */}
					<div className="titlebar-drag absolute top-0 right-0 left-0 z-titlebar flex h-5 items-center justify-center">
						<div className="pointer-events-none flex gap-[3px]">
							<div className="size-[3px] rounded-full bg-overlay-foreground/[0.08]" />
							<div className="size-[3px] rounded-full bg-overlay-foreground/[0.08]" />
							<div className="size-[3px] rounded-full bg-overlay-foreground/[0.08]" />
						</div>
					</div>
				</>
			)}

			{isListenMode && (
				<Tooltip content={th("switchToPtt")}>
					<Button
						aria-label={th("switchToPtt")}
						className={cn(
							"titlebar-no-drag absolute right-1 z-titlebar-float gap-1.5 rounded-md px-2 py-1 transition-opacity duration-200",
							listenSurfaceActive
								? "top-1 opacity-[0.15] hover:bg-overlay-foreground/10 hover:opacity-100"
								: "bottom-7 border border-border bg-surface-3 text-foreground-secondary shadow-sm opacity-70 hover:bg-surface-4 hover:opacity-100",
						)}
						{...pttActivation}
					>
						<HugeiconsIcon
							className={
								listenSurfaceActive ? "text-overlay-foreground/60" : undefined
							}
							icon={Mic01Icon}
							size={14}
						/>
						<span
							className={cn(
								"font-medium text-xs-tight",
								listenSurfaceActive && "text-overlay-foreground/60",
							)}
						>
							{t("pttButton")}
						</span>
					</Button>
				</Tooltip>
			)}

			{!listenSurfaceActive && <StatusBar />}
		</div>
	);
}
