import { describe, expect, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import { CONTEXT_PLAYGROUND_ENABLED } from "@/shared/config/debug-flags";
import { TrayMenu } from "./TrayMenu";

describe("TrayMenu", () => {
	test("renders without crashing", () => {
		const { container } = render(
			<IntlProvider>
				<TrayMenu />
			</IntlProvider>,
		);
		expect(container.firstElementChild).not.toBeNull();
	});

	test("renders window actions and debug context when enabled", () => {
		const { container } = render(
			<IntlProvider>
				<TrayMenu />
			</IntlProvider>,
		);
		const text = container.textContent ?? "";

		expect(text).not.toContain("Open Logs Folder");
		expect(text).not.toContain("Save Diagnostic Bundle");
		if (CONTEXT_PLAYGROUND_ENABLED) {
			expect(text).toContain("Context Playground (debug)");
		} else {
			expect(text).not.toContain("Context Playground");
		}
		expect(text).not.toContain("Ctrl");
		expect(text).not.toContain("Shift");
		expect(text).toContain("Show Window");
		expect(text).toContain("Settings");
		expect(text).toContain("Show WindowW");
		expect(text).toContain("Settings,");
		expect(text).toContain("Transcribe File...T");
		expect(text).toContain("QuitQ");
	});

	test("opens microphone selector as a tray popover", () => {
		const { container } = render(
			<IntlProvider>
				<TrayMenu />
			</IntlProvider>,
		);

		expect(container.textContent?.match(/System Default/g)?.length ?? 0).toBe(
			1,
		);
		fireEvent.click(screen.getByText("System Default"));
		expect(
			container.textContent?.match(/System Default/g)?.length ?? 0,
		).toBeGreaterThan(1);
		expect(container.firstElementChild?.className).toContain("w-[440px]");
		expect(container.firstElementChild?.className).toContain(
			"flex-row-reverse",
		);
	});
});
