import { beforeEach, describe, expect, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import {
	DEFAULT_SETTINGS,
	useSettingsStore,
	useSettingsTabStore,
} from "@/entities/setting";
import { useSettingsHydrationStore } from "@/features/update-settings";
import { SettingsPage } from "./SettingsPage";

function renderSettingsPage() {
	return render(
		<IntlProvider>
			<SettingsPage />
		</IntlProvider>,
	);
}

describe("SettingsPage", () => {
	beforeEach(() => {
		useSettingsStore.setState({ settings: DEFAULT_SETTINGS, isLoaded: false });
		useSettingsHydrationStore.getState().reset();
		useSettingsTabStore.setState({ activeTab: "recording" });
	});

	test("renders without crashing", () => {
		const { container } = renderSettingsPage();
		expect(container).not.toBeNull();
	});

	test("keeps the settings shell visible while backend settings hydrate", () => {
		useSettingsHydrationStore.setState({ error: null, status: "loading" });

		renderSettingsPage();

		expect(screen.getByRole("tab", { name: /recording/i })).toBeDefined();
		expect(
			screen
				.getAllByRole("status")
				.some((status) => status.textContent?.includes("Loading")),
		).toBe(true);
		expect(screen.queryByText("Recording Mode")).toBeNull();
	});

	test("renders settings content when backend settings are unavailable in browser mode", () => {
		useSettingsStore.setState({ settings: DEFAULT_SETTINGS, isLoaded: true });
		useSettingsHydrationStore.setState({ error: null, status: "unavailable" });

		renderSettingsPage();

		expect(screen.getByText("Recording Mode")).toBeDefined();
	});

	test("renders settings transfer controls in the sidebar header", () => {
		renderSettingsPage();

		expect(screen.getByTestId("settings-export-button")).toBeDefined();
		expect(screen.getByTestId("settings-import-button")).toBeDefined();
		expect(screen.queryByTestId("settings-update-button")).toBeNull();
	});

	test("requires confirmation before importing settings", () => {
		renderSettingsPage();

		fireEvent.click(screen.getByTestId("settings-import-button"));

		expect(screen.getByText("Restore settings?")).toBeDefined();
		expect(screen.getByText("Restore")).toBeDefined();
	});

	test("surfaces backend hydration errors instead of mounting default-backed panels", () => {
		useSettingsHydrationStore.setState({
			error: "settings backend failed",
			status: "error",
		});

		renderSettingsPage();

		expect(screen.getByRole("alert").textContent).toContain(
			"settings backend failed",
		);
		expect(screen.queryByText("Recording Mode")).toBeNull();
	});
});
