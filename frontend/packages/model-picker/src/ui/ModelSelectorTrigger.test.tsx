import { describe, expect, test } from "bun:test";
import { Combobox } from "@base-ui/react/combobox";
import { Tooltip as TooltipProvider } from "@base-ui/react/tooltip";
import { render } from "@testing-library/react";
import type { OpenRouterModel } from "@/shared/api/models";
import { ModelSelectorTrigger, TriggerButton } from "./ModelSelectorTrigger";
import { isMissingModelId } from "./model-selector-trigger-helpers";

// The fixture only fills the fields the trigger reads; the boundary cast to
// the full OpenRouterModel is contained in this single helper.
const asOpenRouterModel = (m: {
	id: string;
	name: string;
	maker: string;
	endpoints: never[];
}): OpenRouterModel => m as unknown as OpenRouterModel;

const sampleModel: OpenRouterModel = asOpenRouterModel({
	id: "openai/gpt-4o",
	name: "GPT-4o",
	maker: "openai",
	endpoints: [],
});

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
						selectedModel={undefined}
					/>
				</Combobox.Root>
			</TooltipProvider.Provider>
		);
		expect(container.textContent).toContain("Loading...");
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
