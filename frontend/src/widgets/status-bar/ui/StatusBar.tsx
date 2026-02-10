"use client";

import { Separator } from "@base-ui/react/separator";
import { AiAudioIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useTranslations } from "next-intl";
import { ConnectionIndicator } from "@/features/connect-server";
import { useListenStore } from "@/features/listen-mode";
import { useDownloadStore } from "@/features/model-download";
import { HotkeyDisplay } from "@/features/push-to-talk";
import { useSettingsStore } from "@/features/update-settings";

/** Strip driver/loopback suffixes: "LG TV (NVIDIA …) [Loopback]" → "LG TV" */
const DEVICE_SUFFIX_RE = /\s*[([].*/;
function shortDeviceName(name: string): string {
	return name.replace(DEVICE_SUFFIX_RE, "").trim() || name;
}

export function StatusBar() {
	const currentModel = useSettingsStore((s) => s.settings.model?.model);
	const recordingMode = useSettingsStore((s) => s.settings.general?.recordingMode ?? "ptt");
	const isListening = useListenStore((s) => s.isListening);
	const listenDeviceName = useListenStore((s) => s.deviceName);
	const isDownloading = useDownloadStore((s) => s.isDownloading);
	const t = useTranslations("statusBar");

	return (
		<div
			className={[
				"flex shrink-0 items-center justify-between overflow-hidden whitespace-nowrap border-border border-t bg-surface-primary px-2 py-1 font-mono",
				isDownloading && "pointer-events-none opacity-50",
			]
				.filter(Boolean)
				.join(" ")}
		>
			<ConnectionIndicator />
			<div className="flex items-center gap-1.5">
				{recordingMode === "listen" ? (
					<span className="inline-flex max-w-[120px] items-center gap-1.5 text-[10px]">
						{isListening && (
							<span className="inline-block size-1.5 shrink-0 animate-pulse rounded-full bg-success" />
						)}
						<span className={`truncate ${isListening ? "text-success" : "text-foreground-dim"}`}>
							{listenDeviceName ? shortDeviceName(listenDeviceName) : t("loopbackIdle")}
						</span>
					</span>
				) : (
					<HotkeyDisplay />
				)}
				{currentModel && (
					<>
						<Separator className="h-3 w-px bg-border" orientation="vertical" />
						<span className="flex items-center gap-1 text-[10px] text-foreground-dim">
							<HugeiconsIcon
								aria-hidden="true"
								color="var(--color-foreground-dim)"
								icon={AiAudioIcon}
								size={11}
							/>
							<span className="truncate">{currentModel}</span>
						</span>
					</>
				)}
			</div>
		</div>
	);
}
