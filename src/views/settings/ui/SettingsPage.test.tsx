import { beforeEach, describe, expect, test } from "bun:test";
import { act, fireEvent, render, screen } from "@testing-library/react";
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

function settingsShell(): HTMLElement {
	const shell = document.querySelector<HTMLElement>(".settings-window-shell");
	if (!shell) {
		throw new Error("settings shell did not render");
	}
	return shell;
}

async function nextAnimationFrame(): Promise<void> {
	await act(async () => {
		await new Promise((resolve) => requestAnimationFrame(resolve));
	});
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

	test("renders settings content when backend settings are unavailable in browser mode", async () => {
		useSettingsStore.setState({ settings: DEFAULT_SETTINGS, isLoaded: true });
		useSettingsHydrationStore.setState({ error: null, status: "unavailable" });

		renderSettingsPage();

		expect(await screen.findByText("Recording Mode")).toBeDefined();
	});

	test("renders settings transfer controls in the About tab", async () => {
		useSettingsStore.setState({ settings: DEFAULT_SETTINGS, isLoaded: true });
		useSettingsHydrationStore.setState({ error: null, status: "unavailable" });
		renderSettingsPage();

		expect(screen.queryByTestId("settings-export-button")).toBeNull();
		expect(screen.queryByTestId("settings-import-button")).toBeNull();
		fireEvent.click(screen.getByRole("tab", { name: /about/i }));

		expect(
			await screen.findByRole("button", { name: "Export settings" }),
		).toBeDefined();
		expect(
			await screen.findByRole("button", { name: "Import settings" }),
		).toBeDefined();
		expect(screen.queryByTestId("settings-update-button")).toBeNull();
	});

	test("requires confirmation before importing settings", async () => {
		useSettingsStore.setState({ settings: DEFAULT_SETTINGS, isLoaded: true });
		useSettingsHydrationStore.setState({ error: null, status: "unavailable" });
		renderSettingsPage();

		fireEvent.click(screen.getByRole("tab", { name: /about/i }));
		fireEvent.click(
			await screen.findByRole("button", { name: "Import settings" }),
		);

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

	test("replays the modal open animation after the kept-alive window closes", async () => {
		useSettingsStore.setState({ settings: DEFAULT_SETTINGS, isLoaded: true });
		useSettingsHydrationStore.setState({ error: null, status: "unavailable" });
		document.documentElement.style.setProperty("--modal-close-dur", "1ms");

		try {
			renderSettingsPage();
			await nextAnimationFrame();

			expect(settingsShell().className).toContain("t-modal");
			expect(settingsShell().className).toContain("is-open");

			fireEvent.click(screen.getByRole("button", { name: "Close" }));

			expect(settingsShell().className).toContain("is-closing");

			await act(async () => {
				await new Promise((resolve) => setTimeout(resolve, 5));
			});

			expect(settingsShell().className).not.toContain("is-open");
			expect(settingsShell().className).not.toContain("is-closing");

			act(() => {
				window.dispatchEvent(new FocusEvent("focus"));
			});
			await nextAnimationFrame();

			expect(settingsShell().className).toContain("is-open");
		} finally {
			document.documentElement.style.removeProperty("--modal-close-dur");
		}
	});
});
