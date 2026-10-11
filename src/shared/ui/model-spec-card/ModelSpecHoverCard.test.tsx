import { afterEach, describe, expect, test } from "bun:test";
import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import { setModelPickerWindowOpen } from "@/shared/api/model-picker-window-state";
import { ModelPicker } from "@/shared/ui/model-picker/core/ModelPicker";
import { ModelSpecHoverCard } from "./ModelSpecHoverCard";
import type { ModelSpec } from "./types";

const spec: ModelSpec = {
	name: "Test model",
	description: "Selected model details",
	features: [],
	facts: [],
	stats: [],
};

function trigger(delay = 0) {
	return (
		<ModelSpecHoverCard delay={delay} spec={spec}>
			<span data-testid="model-summary">Test model</span>
		</ModelSpecHoverCard>
	);
}

function hover() {
	const anchor = screen.getByTestId("model-summary");
	fireEvent.pointerEnter(anchor);
	fireEvent.mouseEnter(anchor);
}

async function settleHover(ms = 60) {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, ms));
	});
}

afterEach(() => {
	act(() => setModelPickerWindowOpen(false));
});

describe("model selector hover suppression", () => {
	test("opening a detached picker dismisses a visible card and blocks further hover", async () => {
		render(<IntlProvider>{trigger()}</IntlProvider>);
		hover();
		await screen.findByText("Selected model details");

		act(() => setModelPickerWindowOpen(true));
		expect(screen.queryByText("Selected model details") === null).toBe(true);
		hover();
		await settleHover();
		expect(screen.queryByText("Selected model details") === null).toBe(true);

		act(() => setModelPickerWindowOpen(false));
		await settleHover();
		expect(screen.queryByText("Selected model details") === null).toBe(true);
		fireEvent.mouseLeave(screen.getByTestId("model-summary"));
		hover();
		await screen.findByText("Selected model details");
	});

	test("opening during the hover delay prevents the pending card from appearing", async () => {
		render(<IntlProvider>{trigger(40)}</IntlProvider>);
		hover();
		act(() => setModelPickerWindowOpen(true));
		await settleHover(100);
		expect(screen.queryByText("Selected model details") === null).toBe(true);
		act(() => setModelPickerWindowOpen(false));
		await settleHover();
		expect(screen.queryByText("Selected model details") === null).toBe(true);
	});

	test("an inline picker suppresses only its trigger's hover card", async () => {
		const picker = (open: boolean) => (
			<IntlProvider>
				<ModelPicker
					items={["test"]}
					list={<div>Picker models</div>}
					open={open}
					trigger={trigger()}
				/>
			</IntlProvider>
		);
		const { rerender } = render(picker(false));
		hover();
		await screen.findByText("Selected model details");
		rerender(picker(true));
		await waitFor(() => {
			expect(screen.queryByText("Selected model details") === null).toBe(true);
		});
		hover();
		await settleHover();
		expect(screen.queryByText("Selected model details") === null).toBe(true);
		rerender(picker(false));
		fireEvent.mouseLeave(screen.getByTestId("model-summary"));
		hover();
		await screen.findByText("Selected model details");
	});
});
