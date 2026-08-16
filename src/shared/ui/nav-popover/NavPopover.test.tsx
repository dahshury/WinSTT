import { describe, expect, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { FilterIcon, LanguageSkillIcon } from "@hugeicons/core-free-icons";
import { NavList, NavRow } from "./NavList";
import { NavPopover } from "./NavPopover";

function Harness() {
	return (
		<NavPopover
			dataSlot="test-menu"
			renderRoot={(push) => (
				<NavList ariaLabel="Filters">
					<NavRow
						icon={FilterIcon}
						label="Kind"
						onOpen={push}
						value="Any"
						viewId="kind"
					/>
					<NavRow
						badge={2}
						icon={LanguageSkillIcon}
						label="Language"
						onOpen={push}
						viewId="language"
					/>
				</NavList>
			)}
			rootTitle="Sort & filter"
			rootTrailing={<button type="button">Clear all</button>}
			trigger={(props) => (
				<button {...props} type="button">
					Open
				</button>
			)}
			views={[
				{
					id: "kind",
					render: () => (
						<button data-nav-initial-focus type="button">
							Audio
						</button>
					),
					title: "Kind",
				},
				{
					id: "language",
					render: () => <button type="button">English</button>,
					title: "Language",
				},
			]}
			widthPx={300}
		/>
	);
}

function open() {
	fireEvent.click(screen.getByRole("button", { name: "Open" }));
}

const row = (name: RegExp) => screen.getByRole("button", { name });

describe("NavPopover", () => {
	test("the root view lists every dimension with its current value", () => {
		render(<Harness />);
		open();

		expect(row(/^Kind/).textContent).toContain("Any");
		// The badge stands in for a value chip on multi-select dimensions.
		expect(row(/^Language/).textContent).toContain("2");
	});

	test("clicking a row drills into its view and the back button returns", () => {
		render(<Harness />);
		open();
		fireEvent.click(row(/^Kind/));

		expect(screen.getByRole("button", { name: "Audio" })).not.toBeNull();
		// The outgoing root is aria-hidden, so it is gone from the a11y tree.
		expect(screen.queryByRole("button", { name: /^Language/ })).toBeNull();

		fireEvent.click(
			screen.getByRole("button", { name: "Back to Sort & filter" }),
		);
		expect(row(/^Language/)).not.toBeNull();
	});

	test("Escape unwinds one level before it closes the popover", () => {
		render(<Harness />);
		open();
		fireEvent.click(row(/^Kind/));

		const trigger = screen.getByRole("button", { name: "Open" });
		fireEvent.keyDown(document.activeElement ?? document.body, {
			key: "Escape",
		});
		// Back at the root rather than dismissed.
		expect(row(/^Kind/)).not.toBeNull();
		expect(screen.queryByRole("button", { name: "Audio" })).toBeNull();
		expect(trigger.hasAttribute("data-popup-open")).toBe(true);

		fireEvent.keyDown(document.activeElement ?? document.body, {
			key: "Escape",
		});
		// The popup keeps its node while the close transition runs (which never
		// completes under happy-dom), so assert the open state, not the markup.
		expect(trigger.hasAttribute("data-popup-open")).toBe(false);
	});

	test("arrow keys walk the root list and drill in", () => {
		render(<Harness />);
		open();

		const kind = row(/^Kind/);
		kind.focus();
		fireEvent.keyDown(kind, { key: "ArrowDown" });
		expect(document.activeElement).toBe(row(/^Language/));

		fireEvent.keyDown(row(/^Language/), { key: "ArrowUp" });
		expect(document.activeElement).toBe(row(/^Kind/));

		fireEvent.keyDown(row(/^Kind/), { key: "ArrowRight" });
		expect(screen.getByRole("button", { name: "Audio" })).not.toBeNull();
	});

	test("ArrowLeft backs out of a view", () => {
		render(<Harness />);
		open();
		fireEvent.click(row(/^Language/));
		expect(screen.getByRole("button", { name: "English" })).not.toBeNull();

		fireEvent.keyDown(screen.getByRole("button", { name: "English" }), {
			key: "ArrowLeft",
		});
		expect(row(/^Kind/)).not.toBeNull();
	});

	test("focus lands on the view's initial target and returns to its row", () => {
		render(<Harness />);
		open();
		fireEvent.click(row(/^Kind/));
		expect(document.activeElement).toBe(
			screen.getByRole("button", { name: "Audio" }),
		);

		fireEvent.click(
			screen.getByRole("button", { name: "Back to Sort & filter" }),
		);
		expect(document.activeElement).toBe(row(/^Kind/));
	});

	test("a view with no initial target focuses its back button", () => {
		render(<Harness />);
		open();
		fireEvent.click(row(/^Language/));

		expect(document.activeElement).toBe(
			screen.getByRole("button", { name: "Back to Sort & filter" }),
		);
	});
});
