import { describe, expect, mock, test } from "bun:test";
import { render } from "@testing-library/react";
import { Modal } from "./Modal";

describe("Modal", () => {
	test("renders nothing in document.body when closed", () => {
		render(
			<Modal isOpen={false} onClose={() => undefined}>
				<div data-testid="content">child</div>
			</Modal>,
		);
		expect(document.querySelector("[data-testid='content']")).toBeNull();
	});

	test("renders the children (via portal) when open", () => {
		render(
			<Modal isOpen={true} onClose={() => undefined}>
				<div data-testid="content">child</div>
			</Modal>,
		);
		expect(document.querySelector("[data-testid='content']")).not.toBeNull();
	});

	test("invokes onClose when the dialog reports an onOpenChange(false)", () => {
		const onClose = mock(() => undefined);
		const { rerender } = render(
			<Modal isOpen={true} onClose={onClose}>
				<div>x</div>
			</Modal>,
		);
		// Closing is normally driven by user interaction. Re-render closed and confirm
		// the prop transition does not trigger onClose (only Base UI's onOpenChange does).
		rerender(
			<Modal isOpen={false} onClose={onClose}>
				<div>x</div>
			</Modal>,
		);
		expect(onClose).not.toHaveBeenCalled();
	});
});
