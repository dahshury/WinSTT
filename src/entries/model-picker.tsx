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
import { diagBeacon, installWebviewDiag } from "@/shared/lib/winstt-diag";
import { ModelPickerPage } from "@/views/model-picker";

installWebviewDiag("model-picker");

const container = document.getElementById("root");
if (!container) {
	throw new Error("[model-picker] #root element missing");
}

/**
 * Model-picker data bootstrap. Like the settings window, this is a separate webview that does
 * NOT mount the main `IpcProvider` (which would also run main-only action hooks). It still needs
 * the settings store hydrated (`useSyncSettings` -> `settingsLoad`) so the picker knows the
 * selected model/device, plus the active-model + download + connection listeners for the badges.
 * Without this the store never hydrates (Tauri webviews don't share localStorage) and the picker
 * renders empty/blank. The catalog list self-loads via the catalog store.
 */
// Fire the lifecycle beacon ONCE per window process — not on every re-render (see the
// settings entry for the same fix). The store hydration triggers many re-renders.
let modelPickerBeaconSent = false;

function ModelPickerBootstrap() {
	useSyncSettings();
	useSyncActiveModel();
	useDownloadListener();
	useConnectionListener();
	if (!modelPickerBeaconSent) {
		modelPickerBeaconSent = true;
		diagBeacon("model-picker", "ModelPickerBootstrap render reached");
	}
	return <ModelPickerPage />;
}

createRoot(container).render(
	<StrictMode>
		<HtmlLang />
		<Suspense fallback={null}>
			<IntlProvider>
				<ModelPickerBootstrap />
			</IntlProvider>
		</Suspense>
	</StrictMode>
);
