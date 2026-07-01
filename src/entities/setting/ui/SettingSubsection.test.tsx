import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { SettingSubsection } from "./SettingSubsection";

describe("SettingSubsection", () => {
	test("renders title, info pill and children", () => {
		render(
			<SettingSubsection
				caption="Cleans dictated text"
				title="Dictation post-processing"
			>
				<div data-testid="ch">child</div>
			</SettingSubsection>,
		);
		expect(screen.getByText("Dictation post-processing")).toBeDefined();
		expect(screen.queryByText("Cleans dictated text")).toBeNull();
		expect(screen.getByRole("button", { name: "More info" })).toBeDefined();
		expect(screen.getByTestId("ch")).toBeDefined();
	});

	test("does not render a Toggle when onToggle is not provided", () => {
		render(
			<SettingSubsection title="Dictation">
				<div>x</div>
			</SettingSubsection>,
		);
		expect(screen.queryByRole("switch")).toBeNull();
	});

	test("renders a checked Toggle when onToggle + toggled provided", () => {
		render(
			<SettingSubsection onToggle={() => undefined} title="Transforms" toggled>
				<div>x</div>
			</SettingSubsection>,
		);
		const toggle = screen.getByRole("switch", { name: "Toggle Transforms" });
		expect(toggle.getAttribute("aria-checked")).toBe("true");
	});

	test("clicking the toggle invokes onToggle", () => {
		const onToggle = mock(() => undefined);
		render(
			<SettingSubsection onToggle={onToggle} title="Transforms" toggled={false}>
				<div>x</div>
			</SettingSubsection>,
		);
		fireEvent.click(screen.getByRole("switch"));
		expect(onToggle).toHaveBeenCalledTimes(1);
	});

	test("dims content when its own toggle is off", () => {
		render(
			<SettingSubsection
				onToggle={() => undefined}
				title="Transforms"
				toggled={false}
			>
				<div data-testid="content">x</div>
			</SettingSubsection>,
		);
		const contentParent = screen.getByTestId("content")
			.parentElement as HTMLElement;
		expect(contentParent.className).toContain("pointer-events-none");
	});

	test("busy keeps the toggle ON but blocks interaction and inerts the body", () => {
		const onToggle = mock(() => undefined);
		render(
			<SettingSubsection busy onToggle={onToggle} title="Dictation" toggled>
				<div data-testid="content">x</div>
			</SettingSubsection>,
		);
		const toggle = screen.getByRole("switch", { name: "Toggle Dictation" });
		// Stays visually ON…
		expect(toggle.getAttribute("aria-checked")).toBe("true");
		// …but interaction is blocked.
		fireEvent.click(toggle);
		expect(onToggle).not.toHaveBeenCalled();
		// …and the body is inert until the transition completes.
		const contentParent = screen.getByTestId("content")
			.parentElement as HTMLElement;
		expect(contentParent.className).toContain("pointer-events-none");
	});
});
