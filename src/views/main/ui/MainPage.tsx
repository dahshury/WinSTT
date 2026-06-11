import { Mic01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback } from "react";
import { useTranslations } from "use-intl";
import { useSettingsStore } from "@/entities/setting";
import { settingsSave } from "@/shared/api/ipc-client";
import { useTouchActivation } from "@/shared/lib/use-touch-activation";
import { Button } from "@/shared/ui/button";
import { Tooltip } from "@/shared/ui/tooltip";
import { AudioDisplay } from "@/widgets/audio-display";
import { StatusBar } from "@/widgets/status-bar";

export function MainPage() {
	const general = useSettingsStore((s) => s.settings.general);
	const isListenMode = general?.recordingMode === "listen";
	const updateGeneral = useSettingsStore((s) => s.updateGeneralSettings);
	const t = useTranslations("mainPage");
	const th = useTranslations("hotkey");
	const switchToPtt = useCallback(() => {
		updateGeneral({ recordingMode: "ptt" });
		if (general) {
			void settingsSave({ general: { ...general, recordingMode: "ptt" } });
		}
	}, [general, updateGeneral]);
	const pttActivation = useTouchActivation(switchToPtt);

	return (
		<div className="flex h-full flex-col">
			<div
				className={`flex flex-1 flex-col overflow-hidden ${isListenMode ? "" : "p-1.5"}`}
			>
				<AudioDisplay />
			</div>

			{isListenMode && (
				<>
					{/* Drag strip — dedicated titlebar-drag region above canvas */}
					<div className="titlebar-drag absolute top-0 right-0 left-0 z-titlebar flex h-5 items-center justify-center">
						<div className="pointer-events-none flex gap-[3px]">
							<div className="size-[3px] rounded-full bg-white/[0.08]" />
							<div className="size-[3px] rounded-full bg-white/[0.08]" />
							<div className="size-[3px] rounded-full bg-white/[0.08]" />
						</div>
					</div>

					<Tooltip content={th("switchToPtt")}>
						<Button
							aria-label={th("switchToPtt")}
							className="titlebar-no-drag absolute top-1 right-1 z-titlebar-float gap-1.5 rounded-md px-2 py-1 opacity-[0.15] transition-opacity duration-200 hover:bg-white/10 hover:opacity-100"
							{...pttActivation}
						>
							<HugeiconsIcon
								className="text-white/60"
								icon={Mic01Icon}
								size={14}
							/>
							<span className="font-medium text-white/60 text-xs-tight">
								{t("pttButton")}
							</span>
						</Button>
					</Tooltip>
				</>
			)}

			{!isListenMode && <StatusBar />}
		</div>
	);
}
