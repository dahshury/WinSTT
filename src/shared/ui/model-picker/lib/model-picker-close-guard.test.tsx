import { describe, expect, test } from "bun:test";
import { act, render, screen } from "@testing-library/react";
import { useState } from "react";
import { useModelPickerCloseGuard } from "./model-picker-close-guard";

function CloseGuardHarness() {
	const [open, setOpen] = useState(true);
	useModelPickerCloseGuard({ setOpen });
	return <div data-testid="state">{open ? "open" : "closed"}</div>;
}

describe("useModelPickerCloseGuard", () => {
	test("closes the selector when the window blurs", () => {
		const { unmount } = render(<CloseGuardHarness />);

		expect(screen.getByTestId("state").textContent).toBe("open");

		act(() => {
			window.dispatchEvent(new Event("blur"));
		});

		expect(screen.getByTestId("state").textContent).toBe("closed");
		unmount();
	});
});
