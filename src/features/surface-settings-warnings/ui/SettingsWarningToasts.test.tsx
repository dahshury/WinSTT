import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import { useSettingsHydrationStore } from "@/entities/setting";
import { SettingsWarningToasts } from "./SettingsWarningToasts";

afterEach(() => {
	cleanup();
	useSettingsHydrationStore.getState().reset();
});

function renderToasts() {
	return render(
		<IntlProvider>
			<SettingsWarningToasts />
		</IntlProvider>,
	);
}

describe("SettingsWarningToasts", () => {
	test("renders nothing when there are no warnings", () => {
		const { container } = renderToasts();
		expect(container.querySelector('[role="alert"]')).toBeNull();
	});

	test("interpolates the detail into the defaulted-sections warning", () => {
		useSettingsHydrationStore
			.getState()
			.pushWarning("defaulted-sections", "Recording, Output");
		renderToasts();
		expect(screen.getByText(/Recording, Output/)).toBeTruthy();
	});

	test("interpolates the detail into the hotkey-rewrite warning", () => {
		useSettingsHydrationStore
			.getState()
			.pushWarning("hotkey-rewrite", "Ctrl+Space");
		renderToasts();
		expect(screen.getByText(/Ctrl\+Space/)).toBeTruthy();
	});

	test("renders the detail-free save-failed warning", () => {
		useSettingsHydrationStore.getState().pushWarning("save-failed");
		renderToasts();
		expect(screen.getByRole("alert")).toBeTruthy();
	});

	test("dismissing a warning removes it from the store and the DOM", () => {
		useSettingsHydrationStore.getState().pushWarning("save-failed");
		renderToasts();
		fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
		expect(useSettingsHydrationStore.getState().warnings).toHaveLength(0);
		expect(screen.queryByRole("alert")).toBeNull();
	});
});
