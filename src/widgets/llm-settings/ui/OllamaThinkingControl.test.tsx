import { describe, expect, mock, test } from "bun:test";
import {
	fireEvent,
	render,
	screen,
} from "@/widgets/model-picker/test/render-with-intl";
import { OllamaThinkingControl } from "./OllamaThinkingControl";

// Switcher renders each label twice (an aria-hidden width-reserving ghost + the
// visible label), so look options up via getAllByText and their button.
function present(label: string): boolean {
	return screen.queryAllByText(label).length > 0;
}
function buttonFor(label: string): HTMLButtonElement | null {
	return screen.getAllByText(label)[0]?.closest("button") ?? null;
}

describe("OllamaThinkingControl", () => {
	test("levels mode renders Low/Medium/High with NO Off (gpt-oss can't stop reasoning)", () => {
		render(
			<OllamaThinkingControl
				mode="levels"
				onChange={() => undefined}
				value="medium"
			/>,
		);
		for (const label of ["Low", "Medium", "High"]) {
			expect(present(label)).toBe(true);
		}
		expect(present("Off")).toBe(false);
	});

	test("levels mode renders a stored 'off' as Low selected (matches the off→low wire mapping)", () => {
		render(
			<OllamaThinkingControl
				mode="levels"
				onChange={() => undefined}
				value="off"
			/>,
		);
		const low = buttonFor("Low");
		expect(low?.getAttribute("data-pressed")).not.toBeNull();
	});

	test("toggle mode renders only On/Off — no Low/Medium/High", () => {
		render(
			<OllamaThinkingControl
				mode="toggle"
				onChange={() => undefined}
				value="off"
			/>,
		);
		expect(present("On")).toBe(true);
		expect(present("Off")).toBe(true);
		expect(present("Low")).toBe(false);
		expect(present("Medium")).toBe(false);
		expect(present("High")).toBe(false);
	});

	test("toggle 'On' maps a fresh enable to a think-true effort (medium)", () => {
		const onChange = mock((_: string) => undefined);
		render(
			<OllamaThinkingControl mode="toggle" onChange={onChange} value="off" />,
		);
		const on = buttonFor("On");
		expect(on).not.toBeNull();
		fireEvent.click(on as HTMLButtonElement);
		expect(onChange).toHaveBeenCalledWith("medium");
	});

	test("always-on mode renders a read-only indicator, no toggle", () => {
		render(
			<OllamaThinkingControl
				mode="always-on"
				onChange={() => undefined}
				value="off"
			/>,
		);
		expect(present("Always on")).toBe(true);
		expect(
			document.querySelector('[data-slot="ollama-thinking-always-on"]'),
		).not.toBeNull();
		expect(present("On")).toBe(false);
	});

	test("none mode renders nothing", () => {
		const { container } = render(
			<OllamaThinkingControl
				mode="none"
				onChange={() => undefined}
				value="off"
			/>,
		);
		expect(container.textContent).toBe("");
	});
});
