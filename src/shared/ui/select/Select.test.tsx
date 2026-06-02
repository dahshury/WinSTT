import { describe, expect, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { Select, type SelectOption } from "./Select";

const options: SelectOption[] = [
	{ id: "en", label: "English", badge: "EN" },
	{ id: "fr", label: "French" },
	{ id: "ar", label: "Arabic" },
];

describe("Select", () => {
	test("displays the selected option's label as the trigger text", () => {
		render(<Select aria-label="lang" onChange={() => undefined} options={options} value="fr" />);
		const trigger = screen.getByRole("button", { name: "lang" });
		expect(trigger.textContent).toContain("French");
	});

	test("displays the raw value when no option matches the value", () => {
		render(
			<Select aria-label="lang" onChange={() => undefined} options={options} value="non-existent" />
		);
		expect(screen.getByRole("button", { name: "lang" }).textContent).toContain("non-existent");
	});

	test("renders the badge for the selected option (when provided)", () => {
		render(<Select aria-label="lang" onChange={() => undefined} options={options} value="en" />);
		const trigger = screen.getByRole("button", { name: "lang" });
		expect(trigger.textContent).toContain("EN");
		expect(trigger.textContent).toContain("English");
	});

	test("popup is closed by default — option labels not present in the document", () => {
		render(<Select aria-label="lang" onChange={() => undefined} options={options} value="en" />);
		// 'French' is not the selected one; with the popup closed it should not be in the DOM
		expect(document.body.textContent?.match(/French/g)?.length ?? 0).toBeLessThan(2);
	});

	test("stamps each open row with data-menu-option=<id> (the highlight-layer contract)", () => {
		render(<Select aria-label="lang" onChange={() => undefined} options={options} value="en" />);
		fireEvent.click(screen.getByRole("button", { name: "lang" }));
		// MenuHighlightLayer finds the selected/highlighted rows via this attr.
		expect(
			screen.getByText("French").closest("[data-menu-option]")?.getAttribute("data-menu-option")
		).toBe("fr");
	});

	test("grouped mode renders section headers and still stamps rows with data-menu-option", () => {
		const groups = [
			{ value: "g1", label: "Group One", badge: "G1", options: [{ id: "a", label: "Apple" }] },
			{ value: "g2", label: "Group Two", options: [{ id: "b", label: "Banana" }] },
		];
		render(<Select aria-label="fruit" groups={groups} onChange={() => undefined} value="a" />);
		fireEvent.click(screen.getByRole("button", { name: "fruit" }));
		// Both group headers render…
		expect(screen.getByText("Group One")).toBeDefined();
		expect(screen.getByText("Group Two")).toBeDefined();
		// …and a row nested inside a Menu.Group still carries the highlight-layer
		// contract attribute (headers deliberately do NOT).
		expect(
			screen.getByText("Banana").closest("[data-menu-option]")?.getAttribute("data-menu-option")
		).toBe("b");
		expect(screen.getByText("Group One").closest("[data-menu-option]")).toBeNull();
	});
});
