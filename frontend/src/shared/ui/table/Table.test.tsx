import { describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
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
