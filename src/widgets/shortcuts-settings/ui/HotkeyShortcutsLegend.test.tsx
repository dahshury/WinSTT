import { beforeEach, describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import { DEFAULT_SETTINGS, useSettingsStore } from "@/entities/setting";
import { HotkeyShortcutsLegend } from "./HotkeyShortcutsLegend";

beforeEach(() => {
	useSettingsStore.setState({ settings: structuredClone(DEFAULT_SETTINGS) });
});

describe("HotkeyShortcutsLegend", () => {
	test("shows only shortcuts implemented by the native runtime", () => {
		render(
			<IntlProvider>
				<HotkeyShortcutsLegend />
			</IntlProvider>,
		);

		expect(screen.getByText("Skip AI post-processing")).toBeDefined();
		expect(screen.getByText("Alt")).toBeDefined();
		expect(screen.getByText("S")).toBeDefined();
		expect(screen.queryByText("Stop reading")).toBeNull();
	});
});
