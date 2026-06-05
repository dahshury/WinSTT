import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { ClearableTextField } from "./ClearableTextField";

describe("ClearableTextField", () => {
	test("renders a clear button only while the field has a value", () => {
		const onValueChange = mock((_next: string) => undefined);
		const { rerender } = render(
			<ClearableTextField
				clearLabel="Clear search"
				onValueChange={onValueChange}
				placeholder="Search"
				value=""
			/>
		);

		expect(screen.queryByRole("button", { name: "Clear search" })).toBeNull();

		rerender(
			<ClearableTextField
				clearLabel="Clear search"
				onValueChange={onValueChange}
				placeholder="Search"
				value="whisper"
			/>
		);

		expect(screen.getByRole("button", { name: "Clear search" })).toBeDefined();
	});

	test("clears immediately without animation layers", () => {
		const onValueChange = mock((_next: string) => undefined);
		const { container } = render(
			<ClearableTextField
				clearLabel="Clear search"
				onValueChange={onValueChange}
				placeholder="Search"
				value="whisper"
			/>
		);

		expect(container.querySelector(".t-clear-mirror")).toBeNull();
		expect(container.querySelector(".t-clear-glow")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
		expect(onValueChange).toHaveBeenCalledWith("");
	});
});
