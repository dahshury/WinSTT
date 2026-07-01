import { Tooltip } from "@base-ui/react/tooltip";
import { StrictMode, Suspense, useEffect } from "react";
import { renderReactRoot } from "@/app/lib/render-react-root";
import { HtmlLang } from "@/app/layouts/HtmlLang";
import { IntlProvider } from "@/app/providers/IntlProvider";
import "@/app/styles/fonts.css";
import "@/app/styles/globals.css";
import { useGpuInfo } from "@/entities/connection";
import { useConnectionListener } from "@/features/connect-server";
import { useDownloadListener } from "@/features/model-download";
import { useRealtimePreviewFallback } from "@/features/realtime-preview-fallback";
import { useSyncActiveModel } from "@/features/sync-active-model";
import { useSyncSettings } from "@/features/update-settings";
import { diagBeacon, installWebviewDiag } from "@/shared/lib/winstt-diag";
import { SettingsPage } from "@/views/settings";
// Deep import (not via the widget barrel) ON PURPOSE: the barrel re-exports the
// heavy, lazily-loaded History panel, and pulling it into this always-mounted
// bootstrap would defeat that code-split. This module only carries the
// lightweight store + IPC sync, so the History panel chunk stays lazy.
import { useTranscriptionHistorySync } from "@/widgets/transcription-history-settings/api/use-history-sync";

installWebviewDiag("settings");

const container = document.getElementById("root");
if (!container) {
	throw new Error("[settings] #root element missing");
}

/**
 * Settings-window data bootstrap. The settings window is a SEPARATE webview and does NOT
 * mount the main window's `IpcProvider` (which also runs action hooks — push-to-talk, the
 * transcription feed, recording-sound — that must stay single-instance in the main pill).
 * But it still needs the data-loading hooks, above all `useSyncSettings` which calls
 * `settingsLoad()` to reconcile the local settings cache with the backend store and
 * release the settings panels once the canonical snapshot is known. Run ONLY the
 * safe data hooks.
 */
// Fire the lifecycle beacon ONCE per window process — not on every re-render. The bootstrap
// re-renders many times while the store hydrates (each data hook's state update), and emitting
// the beacon in the render body flooded winstt.log with identical "render reached" lines.
let settingsBeaconSent = false;

export function SettingsBootstrap() {
	useSyncSettings(); // settingsLoad() -> backend hydration gate + write-back on change
	useSyncActiveModel(); // active-model reconcile for the model tab
	useRealtimePreviewFallback(); // cached realtime model or main-model preview fallback
	useDownloadListener(); // per-quant download progress for the model tab
	useConnectionListener(); // server/runtime status for the badges
	useGpuInfo(); // GPU details for the model tab device/fit surfaces
	// Hydrate + live-sync transcription/transform history at the window root so
	// the store stays current while the user is on other tabs and the History
	// tab's stats read warm caches on every revisit (no per-visit refetch).
	useTranscriptionHistorySync();
	useEffect(() => {
		if (!settingsBeaconSent) {
			settingsBeaconSent = true;
			diagBeacon("settings", "SettingsBootstrap render reached");
		}
	}, []);
	return <SettingsPage />;
}

renderReactRoot(
	container,
	<StrictMode>
		<HtmlLang />
		<Suspense fallback={null}>
			<IntlProvider>
				<Tooltip.Provider closeDelay={0} delay={400}>
					<SettingsBootstrap />
				</Tooltip.Provider>
			</IntlProvider>
		</Suspense>
	</StrictMode>,
);
