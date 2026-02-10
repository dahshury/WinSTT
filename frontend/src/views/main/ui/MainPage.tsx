"use client";

import { Mic01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useTranslations } from "next-intl";
import { useSettingsStore } from "@/features/update-settings";
import { AudioDisplay } from "@/widgets/audio-display";
import { StatusBar } from "@/widgets/status-bar";

export function MainPage() {
	const isListenMode = useSettingsStore((s) => s.settings.general?.recordingMode) === "listen";
	const updateGeneral = useSettingsStore((s) => s.updateGeneralSettings);
	const t = useTranslations("mainPage");
	const th = useTranslations("hotkey");

	console.log("[MainPage] Rendering, isListenMode=", isListenMode);

	return (
		<div className="flex h-full flex-col">
			<div className={`flex flex-1 flex-col overflow-hidden ${isListenMode ? "" : "p-1.5"}`}>
				<AudioDisplay />
			</div>

			{isListenMode && (
				<>
					{/* Drag strip — dedicated titlebar-drag region above canvas */}
					<div className="titlebar-drag absolute top-0 right-0 left-0 z-30 flex h-5 items-center justify-center">
						<div className="pointer-events-none flex gap-[3px]">
							<div className="size-[3px] rounded-full bg-white/[0.08]" />
							<div className="size-[3px] rounded-full bg-white/[0.08]" />
							<div className="size-[3px] rounded-full bg-white/[0.08]" />
						</div>
					</div>

					<button
						className="titlebar-no-drag absolute top-1 right-1 z-40 flex items-center gap-1.5 rounded-md px-2 py-1 opacity-[0.15] transition-opacity duration-200 hover:bg-white/10 hover:opacity-100 focus-visible:opacity-100"
						onClick={() => updateGeneral({ recordingMode: "ptt" })}
						title={th("switchToPtt")}
						type="button"
					>
						<HugeiconsIcon className="text-white/60" icon={Mic01Icon} size={14} />
						<span className="font-medium text-[11px] text-white/60">{t("pttButton")}</span>
					</button>
				</>
			)}

			{!isListenMode && <StatusBar />}
		</div>
	);
}
