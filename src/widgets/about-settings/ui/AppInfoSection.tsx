import type { AboutAppInfo } from "@/shared/api/ipc-client";

// Fallback app metadata shown while the real values are fetched from the backend
// (see AboutSettingsPanel). The app name / version / copyright are now rendered
// inline by UpdatesSection, which superseded the standalone AppInfoSection.
export const EMPTY_APP_INFO: AboutAppInfo = {
	copyright: "",
	version: "",
};
