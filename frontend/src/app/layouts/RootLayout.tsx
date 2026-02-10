"use client";

import type { ReactNode } from "react";
import { useSettingsStore } from "@/features/update-settings";
import { IntlProvider } from "../providers/IntlProvider";
import { IpcProvider } from "../providers/IpcProvider";
import { TitleBar } from "./TitleBar";

export function RootLayout({ children }: { children: ReactNode }) {
	const isListenMode = useSettingsStore((s) => s.settings.general?.recordingMode) === "listen";

	console.log("[RootLayout] Rendering, isListenMode=", isListenMode);

	return (
		<IntlProvider>
			<IpcProvider>
				<div className="noise-overlay flex h-screen flex-col">
					{!isListenMode && <TitleBar />}
					<main className="flex-1 overflow-hidden">{children}</main>
				</div>
			</IpcProvider>
		</IntlProvider>
	);
}
