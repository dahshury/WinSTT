import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { Pending } from "./Pending";

describe("Pending", () => {
	test("merges busy state onto the child while pending", () => {
		render(
			<Pending isPending>
				<button type="button">Submit</button>
			</Pending>,
		);

		const button = screen.getByRole("button", { name: "Submit" });
		expect(button.getAttribute("aria-busy")).toBe("true");
		expect(button.getAttribute("aria-disabled")).toBe("true");
		expect(button.getAttribute("data-pending")).toBe("");
	});

	test("leaves the child untouched when not pending", () => {
		render(
			<Pending isPending={false}>
				<button type="button">Submit</button>
			</Pending>,
		);

		const button = screen.getByRole("button", { name: "Submit" });
		expect(button.getAttribute("aria-busy")).toBeNull();
		expect(button.getAttribute("data-pending")).toBeNull();
	});

	test("suppresses the child's own click handler while pending", () => {
		const onClick = mock();
		render(
			<Pending isPending>
				<button onClick={onClick} type="button">
					Submit
				</button>
			</Pending>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Submit" }));
		expect(onClick).not.toHaveBeenCalled();
	});

	test("lets the child's click through once settled", () => {
		const onClick = mock();
		render(
			<Pending isPending={false}>
				<button onClick={onClick} type="button">
					Submit
				</button>
			</Pending>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Submit" }));
		expect(onClick).toHaveBeenCalledTimes(1);
	});
});
