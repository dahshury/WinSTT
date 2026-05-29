import { describe, expect, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from "./Table";

function ExampleTable() {
	return (
		<Table>
			<TableHeader>
				<TableRow>
					<TableHead>Name</TableHead>
					<TableHead>Status</TableHead>
				</TableRow>
			</TableHeader>
			<TableBody>
				<TableRow index={0}>
					<TableCell>alpha</TableCell>
					<TableCell>ok</TableCell>
				</TableRow>
				<TableRow index={1}>
					<TableCell>beta</TableCell>
					<TableCell>err</TableCell>
				</TableRow>
			</TableBody>
		</Table>
	);
}

describe("Table", () => {
	test("renders a real <table> element with rows and cells", () => {
		render(<ExampleTable />);
		const table = screen.getByRole("table");
		expect(table.tagName.toLowerCase()).toBe("table");
		expect(screen.getAllByRole("row")).toHaveLength(3);
		expect(screen.getAllByRole("columnheader")).toHaveLength(2);
		expect(screen.getAllByRole("cell")).toHaveLength(4);
	});

	test("exposes header and body content via accessible roles", () => {
		render(<ExampleTable />);
		expect(screen.getByRole("columnheader", { name: "Name" })).toBeDefined();
		expect(screen.getByRole("cell", { name: "beta" })).toBeDefined();
	});

	test("TableEmpty spans the configured number of columns", () => {
		render(
			<Table>
				<TableBody>
					<TableEmpty colSpan={3}>no entries</TableEmpty>
				</TableBody>
			</Table>
		);
		const cell = screen.getByRole("cell", { name: "no entries" });
		expect(cell.getAttribute("colspan")).toBe("3");
	});
});

describe("Table proximity-hover backdrop", () => {
	function presentationOf(container: HTMLElement): HTMLElement {
		const el = container.querySelector('[role="presentation"]');
		if (!el) {
			throw new Error("presentation container not found");
		}
		return el as HTMLElement;
	}

	test("hovering marks the row under the cursor active and mounts the hover backdrop", () => {
		const { container } = render(<ExampleTable />);
		const wrapper = presentationOf(container);
		// onMouseEnter bumps the AnimatePresence session + re-measures item rects.
		fireEvent.mouseEnter(wrapper);
		// happy-dom getBoundingClientRect is all-zeros, so localY = clientY(0) -
		// containerTop(0) = 0 lands inside body row 0's buffered range (-2..2) →
		// activeIndex becomes 0, which renders the <motion.div> backdrop and adds
		// `is-active` to that row.
		fireEvent.mouseMove(wrapper, { clientY: 0 });
		const rows = screen.getAllByRole("row");
		// rows[0] = header row (no index, never active); rows[1] = body index 0.
		expect(rows[1]?.className).toContain("is-active");
		expect(rows[0]?.className).not.toContain("is-active");
	});

	test("mouseLeave clears the active row", () => {
		const { container } = render(<ExampleTable />);
		const wrapper = presentationOf(container);
		fireEvent.mouseMove(wrapper, { clientY: 0 });
		expect(screen.getAllByRole("row")[1]?.className).toContain("is-active");
		fireEvent.mouseLeave(wrapper);
		expect(screen.getAllByRole("row")[1]?.className).not.toContain("is-active");
	});
});

describe("TableRow ref forwarding", () => {
	test("invokes a function ref with the <tr> element", () => {
		let captured: HTMLTableRowElement | null = null;
		render(
			<Table>
				<TableBody>
					<TableRow
						index={0}
						ref={(node) => {
							if (node) {
								captured = node;
							}
						}}
					>
						<TableCell>x</TableCell>
					</TableRow>
				</TableBody>
			</Table>
		);
		expect((captured as HTMLTableRowElement | null)?.tagName.toLowerCase()).toBe("tr");
	});

	test("populates an object ref's `current` with the <tr> element", () => {
		const ref = { current: null as HTMLTableRowElement | null };
		render(
			<Table>
				<TableBody>
					<TableRow index={0} ref={ref}>
						<TableCell>y</TableCell>
					</TableRow>
				</TableBody>
			</Table>
		);
		expect(ref.current?.tagName.toLowerCase()).toBe("tr");
	});
});
