import { describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import { HotkeySettingsPanel } from "./HotkeySettingsPanel";

describe("HotkeySettingsPanel", () => {
	test("renders without crashing and shows the hotkey recorder", () => {
		const { container } = render(
			<IntlProvider>
				<HotkeySettingsPanel />
			</IntlProvider>
		);
		expect(container.firstElementChild).not.toBeNull();
		// HotkeyRecorder renders at least one button
		expect(screen.getAllByRole("button").length).toBeGreaterThan(0);
	});
});
