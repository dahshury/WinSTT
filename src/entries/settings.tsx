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
import {
	LlmConfigPersistErrorToast,
	SmartEndpointDisabledNotice,
} from "@/widgets/llm-settings";
import { SettingsWarningToasts } from "@/features/surface-settings-warnings";
import { useSyncActiveModel } from "@/features/sync-active-model";
import { useSyncSettings } from "@/features/update-settings";
import { diagBeacon, installWebviewDiag } from "@/shared/lib/winstt-diag";
import { SettingsPage } from "@/views/settings";
import { useTranscriptionHistorySync } from "@/widgets/transcription-history-settings";

installWebviewDiag("settings");

// Warm the DEFAULT settings tab's panel chunk at window boot — before React even
// renders — so its fetch/parse overlaps the entry boot + `settingsLoad()`
// hydration instead of only starting once `canRenderSettings` flips and the
// lazy panel is first rendered. That deferred start previously added ~700ms to
// first-open content-ready (the mounted panel IS the window's reveal gate), so a
// cold open sat invisible until the chunk landed. The dynamic import is memoized
// by specifier: this primes the exact chunk the `lazy()` factory in SettingsPage
// awaits, and stays code-split (never pulled into the entry's static graph).
// Keep the specifier in sync with the default `activeTab` ("recording") in
// settings-tab-store.
void import("@/widgets/recording-settings");

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
	return (
		<>
			<SettingsPage />
			{/* Global settings-window notices — driven by zustand stores in this
			    window's process (settings-hydration + LLM-config/smart-endpoint),
			    so they mount here alongside the page rather than inside it. */}
			<SettingsWarningToasts />
			<LlmConfigPersistErrorToast />
			<SmartEndpointDisabledNotice />
		</>
	);
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
