import { expect, mock, test } from "bun:test";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { EditableListCombobox } from "./EditableListCombobox";

test("adds an icon-aware suggestion while preserving freeform creation", async () => {
	const onChange = mock((_next: string[]) => undefined);
	render(
		<EditableListCombobox
			cancelAriaLabel="Cancel"
			createLabel={(entry) => `Add ${entry}`}
			editAriaLabel={(entry) => `Edit ${entry}`}
			emptyLabel="No denied apps"
			inputAriaLabel="Denied apps"
			normalize={(value) => value.trim().toLowerCase()}
			onChange={onChange}
			removeAriaLabel={(entry) => `Remove ${entry}`}
			saveAriaLabel="Save"
			suggestions={[
				{
					label: "AI Prompt",
					leading: <img alt="" src="data:image/png;base64,app-icon" />,
					trailing: <span>chatgpt.exe</span>,
					value: "chatgpt.exe",
				},
			]}
			summaryLabel={(count) => `${count} denied`}
			value={[]}
		/>,
	);

	await act(async () => {
		fireEvent.click(screen.getByRole("button", { name: "Denied apps" }));
		await new Promise<void>((resolve) =>
			requestAnimationFrame(() => resolve()),
		);
	});
	expect(screen.getByText("AI Prompt")).toBeDefined();
	expect(
		document.querySelector('img[src="data:image/png;base64,app-icon"]'),
	).not.toBeNull();

	await act(async () => {
		fireEvent.click(screen.getByText("AI Prompt"));
		await new Promise<void>((resolve) =>
			requestAnimationFrame(() => resolve()),
		);
	});
	expect(onChange).toHaveBeenCalledWith(["chatgpt.exe"]);

	// A non-suggested executable can still be entered through the create row.
	await act(async () => {
		fireEvent.click(screen.getByRole("button", { name: "Denied apps" }));
		await new Promise<void>((resolve) =>
			requestAnimationFrame(() => resolve()),
		);
	});
	fireEvent.change(screen.getByRole("combobox", { name: "Denied apps" }), {
		target: { value: "custom.exe" },
	});
	expect(screen.getByText("Add custom.exe")).toBeDefined();
});
