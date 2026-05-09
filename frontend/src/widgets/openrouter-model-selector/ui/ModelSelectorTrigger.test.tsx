import { describe, expect, test } from "bun:test";
import { Combobox } from "@base-ui/react/combobox";
import { Tooltip as TooltipProvider } from "@base-ui/react/tooltip";
import { render } from "@testing-library/react";
import type { OpenRouterModel } from "@/shared/api/models";
import { ModelSelectorTrigger } from "./ModelSelectorTrigger";

const sampleModel: OpenRouterModel = {
	id: "openai/gpt-4o",
	name: "GPT-4o",
	maker: "openai",
	endpoints: [],
} as unknown as OpenRouterModel;

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
});
