import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { SurfaceProvider, useSurface } from "@/shared/lib/surface";
import { SettingSection } from "./SettingSection";

function SurfaceProbe() {
	const level = useSurface();
	return <span data-testid="surface-level">{level}</span>;
}

describe("SettingSection", () => {
	test("renders title and children", () => {
		render(
			<SettingSection title="Audio">
				<div data-testid="ch">child</div>
			</SettingSection>,
		);
		expect(screen.getByText("Audio")).toBeDefined();
		expect(screen.getByTestId("ch")).toBeDefined();
	});

	test("renders description as an info pill instead of inline text", () => {
		render(
			<SettingSection description="Audio configuration help" title="Audio">
				<div>child</div>
			</SettingSection>,
		);
		expect(screen.queryByText("Audio configuration help")).toBeNull();
		expect(screen.getByRole("button", { name: "More info" })).toBeDefined();
	});

	test("does not render a Toggle when onToggle is not provided", () => {
		render(
			<SettingSection title="Audio">
				<div>x</div>
			</SettingSection>,
		);
		expect(screen.queryByRole("switch")).toBeNull();
	});

	test("renders a Toggle when onToggle is provided", () => {
		render(
			<SettingSection onToggle={() => undefined} title="LLM" toggled>
				<div>x</div>
			</SettingSection>,
		);
		const toggle = screen.getByRole("switch", { name: "Toggle LLM" });
		expect(toggle.getAttribute("aria-checked")).toBe("true");
	});

	test("clicking the toggle invokes onToggle with the inverse value", () => {
		const onToggle = mock(() => undefined);
		render(
			<SettingSection onToggle={onToggle} title="LLM" toggled={false}>
				<div>x</div>
			</SettingSection>,
		);
		fireEvent.click(screen.getByRole("switch"));
		expect(onToggle).toHaveBeenCalledTimes(1);
	});

	test("re-provides a +1 surface level to its body (so nested controls keep elevation)", () => {
		// Flattening removed the card chrome but MUST preserve the surface
		// context lift, or every ElevatedSurface control inside loses a step of
		// contrast. On a surface-2 substrate the body context must be surface-3.
		render(
			<SurfaceProvider value={2}>
				<SettingSection title="Audio">
					<SurfaceProbe />
				</SettingSection>
			</SurfaceProvider>,
		);
		expect(screen.getByTestId("surface-level").textContent).toBe("3");
	});

	test("divided mode stacks rows without in-section separators", () => {
		const { container } = render(
			<SettingSection divided title="Audio">
				<div>First</div>
				<div>Second</div>
			</SettingSection>,
		);

		expect(container.querySelector(".divide-y")).toBeNull();
		expect(container.querySelector(".divide-surface-1")).toBeNull();
	});

	test("dims content when section has a toggle that is off (pointer-events disabled)", () => {
		const { container } = render(
			<SettingSection onToggle={() => undefined} title="LLM" toggled={false}>
				<div data-testid="content">x</div>
			</SettingSection>,
		);
		const wrappers = container.querySelectorAll("div");
		// Find the wrapper of the content
		const contentParent = screen.getByTestId("content")
			.parentElement as HTMLElement;
		expect(contentParent.className).toContain("pointer-events-none");
		expect(wrappers.length).toBeGreaterThan(0);
	});
});
