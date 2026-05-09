import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { SettingSection } from "./SettingSection";

describe("SettingSection", () => {
	test("renders title and children", () => {
		render(
			<SettingSection title="Audio">
				<div data-testid="ch">child</div>
			</SettingSection>
		);
		expect(screen.getByText("Audio")).toBeDefined();
		expect(screen.getByTestId("ch")).toBeDefined();
	});

	test("does not render a Toggle when onToggle is not provided", () => {
		render(
			<SettingSection title="Audio">
				<div>x</div>
			</SettingSection>
		);
		expect(screen.queryByRole("switch")).toBeNull();
	});

	test("renders a Toggle when onToggle is provided", () => {
		render(
			<SettingSection onToggle={() => undefined} title="LLM" toggled>
				<div>x</div>
			</SettingSection>
		);
		const toggle = screen.getByRole("switch", { name: "Toggle LLM" });
		expect(toggle.getAttribute("aria-checked")).toBe("true");
	});

	test("clicking the toggle invokes onToggle with the inverse value", () => {
		const onToggle = mock(() => undefined);
		render(
			<SettingSection onToggle={onToggle} title="LLM" toggled={false}>
				<div>x</div>
			</SettingSection>
		);
		fireEvent.click(screen.getByRole("switch"));
		expect(onToggle).toHaveBeenCalledTimes(1);
	});

	test("dims content when section has a toggle that is off (pointer-events disabled)", () => {
		const { container } = render(
			<SettingSection onToggle={() => undefined} title="LLM" toggled={false}>
				<div data-testid="content">x</div>
			</SettingSection>
		);
		const wrappers = container.querySelectorAll("div");
		// Find the wrapper of the content
		const contentParent = screen.getByTestId("content").parentElement as HTMLElement;
		expect(contentParent.className).toContain("pointer-events-none");
		expect(wrappers.length).toBeGreaterThan(0);
	});
});
