"use client";

import { Tooltip } from "@base-ui/react/tooltip";
import type { ReactNode } from "react";
import { useSettingsStore } from "@/entities/setting";
import { SwapFailureToast } from "@/features/swap-notifications";
import { TransformToast } from "@/features/transform-notifications";
import { TtsPlaybackMount } from "@/features/tts-playback";
import { SurfaceProvider } from "@/shared/lib/surface";
import { IntlProvider } from "../providers/IntlProvider";
import { IpcProvider } from "../providers/IpcProvider";
import { TitleBar } from "./TitleBar";

export function RootLayout({ children }: { children: ReactNode }) {
	const isListenMode = useSettingsStore((s) => s.settings.general?.recordingMode) === "listen";

	return (
		<IntlProvider>
			<Tooltip.Provider closeDelay={0} delay={400}>
				<IpcProvider>
					<SurfaceProvider value={1}>
						<div className="noise-overlay flex h-screen flex-col bg-surface-1">
							{!isListenMode && <TitleBar />}
							<main className="flex-1 overflow-hidden">{children}</main>
							<TransformToast />
							<SwapFailureToast />
							<TtsPlaybackMount />
						</div>
					</SurfaceProvider>
				</IpcProvider>
			</Tooltip.Provider>
		</IntlProvider>
	);
}
