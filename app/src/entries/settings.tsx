import { Tooltip } from "@base-ui/react/tooltip";
import { StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { HtmlLang } from "@/app/layouts/HtmlLang";
import { IntlProvider } from "@/app/providers/IntlProvider";
import "@/app/styles/fonts.css";
import "@/app/styles/globals.css";
import { useConnectionListener } from "@/features/connect-server";
import { useDownloadListener } from "@/features/model-download";
import { useSyncActiveModel } from "@/features/sync-active-model";
import { useSyncSettings } from "@/features/update-settings";
import { SettingsPage } from "@/views/settings";

const container = document.getElementById("root");
if (!container) {
	throw new Error("[settings] #root element missing");
}

/**
 * Settings-window data bootstrap. The settings window is a SEPARATE webview and does NOT
 * mount the main window's `IpcProvider` (which also runs action hooks — push-to-talk, the
 * transcription feed, recording-sound — that must stay single-instance in the main pill).
 * But it still needs the data-loading hooks, above all `useSyncSettings` which calls
 * `settingsLoad()` to hydrate the settings store (set `isLoaded`). Without it the store
 * never hydrates (Tauri webviews don't share localStorage), `SettingsPage` reads
 * `isLoaded === false`, and the whole window renders blank. Run ONLY the safe data hooks.
 */
function SettingsBootstrap() {
	useSyncSettings(); // settingsLoad() -> hydrate store + write-back on change (THE blank fix)
	useSyncActiveModel(); // active-model reconcile for the model tab
	useDownloadListener(); // per-quant download progress for the model tab
	useConnectionListener(); // server/runtime status for the badges
	return <SettingsPage />;
}

createRoot(container).render(
	<StrictMode>
		<HtmlLang />
		<Suspense fallback={null}>
			<IntlProvider>
				<Tooltip.Provider closeDelay={0} delay={400}>
					<SettingsBootstrap />
				</Tooltip.Provider>
			</IntlProvider>
		</Suspense>
	</StrictMode>
);
