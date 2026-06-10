import { Tooltip } from "@base-ui/react/tooltip";
import { StrictMode, Suspense, useEffect } from "react";
import { renderReactRoot } from "@/app/lib/render-react-root";
import { HtmlLang } from "@/app/layouts/HtmlLang";
import { IntlProvider } from "@/app/providers/IntlProvider";
import "@/app/styles/fonts.css";
import "@/app/styles/globals.css";
import { useConnectionStore } from "@/entities/connection";
import { useConnectionListener } from "@/features/connect-server";
import { useDownloadListener } from "@/features/model-download";
import { useRealtimePreviewFallback } from "@/features/realtime-preview-fallback";
import { useSyncActiveModel } from "@/features/sync-active-model";
import { useSyncSettings } from "@/features/update-settings";
import { gpuGetInfo } from "@/shared/api/ipc-client";
import { diagBeacon, installWebviewDiag } from "@/shared/lib/winstt-diag";
import { SettingsPage } from "@/views/settings";

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

function SettingsBootstrap() {
	const setGpuInfo = useConnectionStore((s) => s.setGpuInfo);
	useSyncSettings(); // settingsLoad() -> backend hydration gate + write-back on change
	useSyncActiveModel(); // active-model reconcile for the model tab
	useRealtimePreviewFallback(); // cached realtime model or main-model preview fallback
	useDownloadListener(); // per-quant download progress for the model tab
	useConnectionListener(); // server/runtime status for the badges
	useEffect(() => {
		let cancelled = false;
		gpuGetInfo().then((info) => {
			if (!cancelled) {
				setGpuInfo(info);
			}
		});
		return () => {
			cancelled = true;
		};
	}, [setGpuInfo]);
	if (!settingsBeaconSent) {
		settingsBeaconSent = true;
		diagBeacon("settings", "SettingsBootstrap render reached");
	}
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
