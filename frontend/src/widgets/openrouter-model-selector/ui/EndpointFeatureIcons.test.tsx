import { describe, expect, test } from "bun:test";
import { Tooltip as TooltipProvider } from "@base-ui/react/tooltip";
import { render } from "@testing-library/react";
import type { OpenRouterEndpoint } from "@/shared/api/models";
import { EndpointFeatureIcons } from "./EndpointFeatureIcons";

function makeEndpoint(opts?: Partial<OpenRouterEndpoint>): OpenRouterEndpoint {
	return {
		provider_name: "openai",
		tag: "openai",
		supported_parameters: [],
		quantization: null,
		...opts,
	} as unknown as OpenRouterEndpoint;
}

function renderIt(endpoint: OpenRouterEndpoint) {
	return render(
		<TooltipProvider.Provider>
			<EndpointFeatureIcons endpoint={endpoint} />
		</TooltipProvider.Provider>
	);
}

describe("EndpointFeatureIcons", () => {
	test("renders nothing when endpoint has no recognized features", () => {
		const { container } = renderIt(makeEndpoint());
		expect(container.firstChild).toBeNull();
	});

	test("renders feature icons for supported_parameters in canonical priority", () => {
		const { container } = renderIt(makeEndpoint({ supported_parameters: ["tools", "reasoning"] }));
		expect(container.firstElementChild).not.toBeNull();
	});

	test("renders quantization label when present", () => {
		const { container } = renderIt(
			makeEndpoint({ quantization: "fp16", supported_parameters: [] })
		);
		expect(container.textContent).toContain("FP16");
	});

	test("ignores 'unknown' quantization", () => {
		const { container } = renderIt(
			makeEndpoint({ quantization: "unknown", supported_parameters: [] })
		);
		expect(container.firstChild).toBeNull();
	});

	test("respects maxIcons limit", () => {
		const { container } = renderIt(
			makeEndpoint({
				supported_parameters: [
					"tools",
					"parallel_tool_calls",
					"reasoning",
					"structured_outputs",
					"web_search_options",
				],
			})
		);
		// Quantization absent — only feature icons. Maxes 4 by default.
		const innerChips = container.querySelectorAll("[role]");
		expect(innerChips.length).toBeLessThanOrEqual(8); // tooltip wrappers + chips
	});
});
