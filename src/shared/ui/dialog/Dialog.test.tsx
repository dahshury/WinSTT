import { describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { DialogFooter } from "./Dialog";

describe("DialogFooter", () => {
	test("groups two or more actions into a connected toolbar", () => {
		render(
			<DialogFooter>
				<button type="button">Cancel</button>
				<button type="button">Save</button>
			</DialogFooter>,
		);

		const toolbar = screen.getByRole("toolbar", { name: "Dialog actions" });
		expect(toolbar.className).toContain("rounded-md");
		expect(toolbar.textContent).toContain("Cancel");
		expect(toolbar.textContent).toContain("Save");
	});

	test("unwraps fragments before deciding whether to group actions", () => {
		render(
			<DialogFooter>
				<>
					<button type="button">Hide</button>
					<button type="button">Stop</button>
				</>
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
