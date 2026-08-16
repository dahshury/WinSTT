import { describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { DialogFooter } from "./Dialog";

describe("DialogFooter", () => {
	test("groups two or more actions into a spaced toolbar", () => {
		render(
			<DialogFooter>
				<button type="button">Cancel</button>
				<button type="button">Save</button>
			</DialogFooter>,
		);

		const toolbar = screen.getByRole("toolbar", { name: "Dialog actions" });
		// Spaced, not joined: a connected segment control reads as "pick one of
		// these", which is the wrong signal for Cancel-vs-Save.
		expect(toolbar.className).toContain("gap-2");
		expect(toolbar.className).not.toContain("divide-x");
		expect(toolbar.textContent).toContain("Cancel");
		expect(toolbar.textContent).toContain("Save");
	});

	test("puts leading content before the action group", () => {
		render(
			<DialogFooter leading={<span>Heads up</span>}>
				<button type="button">Cancel</button>
				<button type="button">Save</button>
			</DialogFooter>,
		);

		expect(screen.getByText("Heads up")).toBeDefined();
		expect(
			screen.getByRole("toolbar", { name: "Dialog actions" }),
		).toBeDefined();
	});

	test("unwraps fragments before deciding whether to group actions", () => {
		render(
			<DialogFooter>
				<button type="button">Hide</button>
				<button type="button">Stop</button>
			</DialogFooter>,
		);

		expect(
			screen.getByRole("toolbar", { name: "Dialog actions" }),
		).toBeDefined();
	});

	test("does not create a toolbar for a single action", () => {
		render(
			<DialogFooter>
				<button type="button">Close</button>
			</DialogFooter>,
		);

		expect(screen.queryByRole("toolbar")).toBeNull();
	});
});
