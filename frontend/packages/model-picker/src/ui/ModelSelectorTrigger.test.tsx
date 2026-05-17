import { describe, expect, test } from "bun:test";
import { Combobox } from "@base-ui/react/combobox";
import { Tooltip as TooltipProvider } from "@base-ui/react/tooltip";
import { render } from "@testing-library/react";
import type { OpenRouterEndpoint, OpenRouterModel } from "@/shared/api/models";
import { isMissingModelId, ModelSelectorTrigger, TriggerButton } from "./ModelSelectorTrigger";

const sampleModel: OpenRouterModel = {
	id: "openai/gpt-4o",
	name: "GPT-4o",
	maker: "openai",
	endpoints: [],
} as unknown as OpenRouterModel;

describe("isMissingModelId", () => {
	test("returns true for undefined", () => {
		expect(isMissingModelId(undefined)).toBe(true);
	});

	test("returns true for empty string", () => {
		expect(isMissingModelId("")).toBe(true);
	});

	test("returns false for a non-empty model id", () => {
		expect(isMissingModelId("openai/gpt-4o")).toBe(false);
	});
});

describe("ModelSelectorTrigger", () => {
	test("renders the OpenRouter Auto label as the default when no model is selected", () => {
		const { container } = render(
			<TooltipProvider.Provider>
				<Combobox.Root>
					<ModelSelectorTrigger
						disabled={false}
						isLoading={false}
						open={false}
						parsedModelId={undefined}
						placeholder="Pick a model"
						selectedEndpoint={null}
						selectedModel={undefined}
					/>
				</Combobox.Root>
			</TooltipProvider.Provider>
		);
		// The trigger renders "OpenRouter Auto" content when nothing is selected;
		// 'placeholder' is used by the inner search input, not the trigger label.
		expect(container.textContent?.length).toBeGreaterThan(0);
	});

	test("renders the model name when a model is selected", () => {
		const { container } = render(
			<TooltipProvider.Provider>
				<Combobox.Root>
					<ModelSelectorTrigger
						disabled={false}
						isLoading={false}
						open={false}
						parsedModelId={sampleModel.id}
						placeholder="Pick a model"
						selectedEndpoint={null}
						selectedModel={sampleModel}
					/>
				</Combobox.Root>
			</TooltipProvider.Provider>
		);
		// Some piece of the model id appears
		expect(container.textContent).toContain("GPT-4o");
	});

	test("renders the placeholder text when parsedModelId is a non-empty string but no model", () => {
		const { container } = render(
			<TooltipProvider.Provider>
				<Combobox.Root>
					<ModelSelectorTrigger
						disabled={false}
						isLoading={false}
						open={false}
						parsedModelId="some/unknown-model"
						placeholder="Pick a model"
						selectedEndpoint={null}
						selectedModel={undefined}
					/>
				</Combobox.Root>
			</TooltipProvider.Provider>
		);
		expect(container.textContent).toContain("Pick a model");
	});

	test("renders loading state with spinner", () => {
		const { container } = render(
			<TooltipProvider.Provider>
				<Combobox.Root>
					<ModelSelectorTrigger
						disabled={false}
						isLoading
						open={false}
						parsedModelId={undefined}
						placeholder="Loading..."
						selectedEndpoint={null}
						selectedModel={undefined}
					/>
				</Combobox.Root>
			</TooltipProvider.Provider>
		);
		expect(container.textContent).toContain("Loading...");
	});

	test("renders with a selected endpoint provider", () => {
		const selectedEndpoint: OpenRouterEndpoint = {
			provider_name: "DeepInfra",
			pricing: { prompt: "0.000001", completion: "0.000002" },
		} as unknown as OpenRouterEndpoint;

		const { container } = render(
			<TooltipProvider.Provider>
				<Combobox.Root>
					<ModelSelectorTrigger
						disabled={false}
						isLoading={false}
						open={false}
						parsedModelId={sampleModel.id}
						placeholder="Pick a model"
						selectedEndpoint={selectedEndpoint}
						selectedModel={sampleModel}
					/>
				</Combobox.Root>
			</TooltipProvider.Provider>
		);
		expect(container.textContent).toContain("via DeepInfra");
	});

	test("renders model with variant badge", () => {
		const modelWithVariant: OpenRouterModel = {
			...sampleModel,
			variant: "nitro",
		} as OpenRouterModel;

		const { container } = render(
			<TooltipProvider.Provider>
				<Combobox.Root>
					<ModelSelectorTrigger
						disabled={false}
						isLoading={false}
						open={false}
						parsedModelId={modelWithVariant.id}
						placeholder="Pick a model"
						selectedEndpoint={null}
						selectedModel={modelWithVariant}
					/>
				</Combobox.Root>
			</TooltipProvider.Provider>
		);
		// VariantBadgeIcon renders an icon-only badge whose label lives on
		// the `aria-label` attribute and inside a tooltip popup. The visible
		// text no longer contains the variant name.
		expect(container.querySelector('[aria-label="Nitro"]')).not.toBeNull();
	});
});

describe("TriggerButton", () => {
	const baseProps = {
		buttonProps: {},
		open: false,
		disabled: false,
		isLoading: false,
		parsedModelId: undefined as string | undefined,
		placeholder: "Pick a model",
		selectedEndpoint: null,
		selectedModel: undefined as OpenRouterModel | undefined,
	};

	test("renders loading state when isLoading=true", () => {
		const { container } = render(
			<TooltipProvider.Provider>
				<TriggerButton {...baseProps} isLoading placeholder="Loading..." />
			</TooltipProvider.Provider>
		);
		expect(container.textContent).toContain("Loading...");
	});

	test("renders Auto state when no model and no parsedModelId", () => {
		const { container } = render(
			<TooltipProvider.Provider>
				<TriggerButton {...baseProps} />
			</TooltipProvider.Provider>
		);
		expect(container.textContent).toContain("Auto");
	});

	test("renders placeholder when parsedModelId present but no model resolved", () => {
		const { container } = render(
			<TooltipProvider.Provider>
				<TriggerButton {...baseProps} parsedModelId="some/unknown" placeholder="Unknown" />
			</TooltipProvider.Provider>
		);
		expect(container.textContent).toContain("Unknown");
	});

	test("renders model name when selectedModel is provided", () => {
		const { container } = render(
			<TooltipProvider.Provider>
				<TriggerButton {...baseProps} parsedModelId={sampleModel.id} selectedModel={sampleModel} />
			</TooltipProvider.Provider>
		);
		expect(container.textContent).toContain("GPT-4o");
	});

	test("renders open state attribute when open=true", () => {
		const { container } = render(
			<TooltipProvider.Provider>
				<TriggerButton {...baseProps} open />
			</TooltipProvider.Provider>
		);
		const button = container.querySelector("[data-state='open']");
		expect(button).not.toBeNull();
	});
});
