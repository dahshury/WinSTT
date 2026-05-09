import { describe, expect, mock, test } from "bun:test";
import { Tooltip as TooltipProvider } from "@base-ui/react/tooltip";
import { render, screen } from "@testing-library/react";
import { ActiveFiltersBar } from "./ActiveFiltersBar";

function renderBar(props: Partial<Parameters<typeof ActiveFiltersBar>[0]>) {
	const onMakerToggle = mock(() => undefined);
	const onVariantSelect = mock(() => undefined);
	const onEndpointProviderSelect = mock(() => undefined);
	const onRemoveParameter = mock(() => undefined);
	return render(
		<TooltipProvider.Provider>
			<ActiveFiltersBar
				onEndpointProviderSelect={onEndpointProviderSelect}
				onMakerToggle={onMakerToggle}
				onRemoveParameter={onRemoveParameter}
				onVariantSelect={onVariantSelect}
				selectedEndpointProvider={null}
				selectedMakers={[]}
				selectedParameters={[]}
				selectedVariant={null}
				{...props}
			/>
		</TooltipProvider.Provider>
	);
}

describe("ActiveFiltersBar", () => {
	test("renders nothing when no filters are active", () => {
		const { container } = renderBar({});
		expect(container.firstChild).toBeNull();
	});

	test("renders maker badges when selectedMakers is non-empty", () => {
		renderBar({ selectedMakers: ["openai", "anthropic"] });
		expect(screen.getAllByRole("button").length).toBeGreaterThan(0);
	});

	test("renders a variant badge", () => {
		renderBar({ selectedVariant: "nitro" });
		expect(document.body.textContent).toContain("Nitro");
	});

	test("renders 'Standard' label for the 'none' variant", () => {
		renderBar({ selectedVariant: "none" });
		expect(document.body.textContent).toContain("Standard");
	});

	test("renders endpoint provider badge", () => {
		renderBar({ selectedEndpointProvider: "deepinfra" });
		expect(document.body.textContent?.toLowerCase()).toContain("deepinfra");
	});

	test("renders parameter badges", () => {
		renderBar({ selectedParameters: ["tools"] });
		expect(document.body.textContent).toContain("Tools");
	});
});
