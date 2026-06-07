import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render } from "@testing-library/react";
import { ConfirmDialog } from "./ConfirmDialog";

function renderDialog(opts?: Partial<Parameters<typeof ConfirmDialog>[0]>) {
	const onConfirm = mock(() => undefined);
	const onOpenChange = mock(() => undefined);
	const utils = render(
		<ConfirmDialog
			description="Are you sure?"
			onConfirm={onConfirm}
			onOpenChange={onOpenChange}
			open={opts?.open ?? true}
			title="Confirm Delete"
			{...opts}
		/>,
	);
	return { ...utils, onConfirm, onOpenChange };
}

describe("ConfirmDialog", () => {
	test("renders title and description when open", () => {
		renderDialog();
		expect(document.body.textContent).toContain("Confirm Delete");
		expect(document.body.textContent).toContain("Are you sure?");
	});

	test("does not render dialog content when open=false", () => {
		renderDialog({ open: false });
		expect(document.body.textContent).not.toContain("Confirm Delete");
	});

	test("default cancel and confirm labels", () => {
		renderDialog();
		// By default, Cancel and Delete labels appear
		expect(document.body.textContent).toContain("Cancel");
		expect(document.body.textContent).toContain("Delete");
	});

	test("respects custom cancelLabel and confirmLabel", () => {
		renderDialog({ cancelLabel: "Nope", confirmLabel: "Yes, do it" });
		expect(document.body.textContent).toContain("Nope");
		expect(document.body.textContent).toContain("Yes, do it");
	});

	test("clicking the confirm button invokes onConfirm and then closes the dialog", () => {
		const { onConfirm, onOpenChange } = renderDialog({ confirmLabel: "Run" });
		const confirmBtn = Array.from(document.querySelectorAll("button")).find(
			(b) => (b.textContent ?? "").includes("Run"),
		);
		expect(confirmBtn).toBeDefined();
		fireEvent.click(confirmBtn!);
		expect(onConfirm).toHaveBeenCalledTimes(1);
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});
});
