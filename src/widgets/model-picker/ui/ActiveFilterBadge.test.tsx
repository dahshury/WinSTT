import { describe, expect, mock, test } from "bun:test";
import { Tooltip as TooltipProvider } from "@base-ui/react/tooltip";
import { fireEvent, render, screen } from "@testing-library/react";
import { ActiveFilterBadge } from "./ActiveFilterBadge";

function renderBadge(opts?: Partial<Parameters<typeof ActiveFilterBadge>[0]>) {
	const onRemove = mock(() => undefined);
	const utils = render(
		<TooltipProvider.Provider>
			<ActiveFilterBadge
				label="Variant"
				onRemove={onRemove}
				value="nitro"
				{...opts}
			/>
		</TooltipProvider.Provider>,
	);
	return { ...utils, onRemove };
}

describe("ActiveFilterBadge", () => {
	test("renders label:value combination as the value button's aria-label", () => {
		renderBadge();
		expect(
			screen.getByRole("button", { name: "Variant: nitro" }),
		).toBeDefined();
	});

	test("renders a remove button", () => {
		renderBadge();
		expect(
			screen.getByRole("button", { name: /remove filter: variant nitro/i }),
		).toBeDefined();
	});

	test("clicking the remove button calls onRemove", () => {
		const { onRemove } = renderBadge();
		fireEvent.click(screen.getByRole("button", { name: /remove filter/i }));
		expect(onRemove).toHaveBeenCalledTimes(1);
	});
});
