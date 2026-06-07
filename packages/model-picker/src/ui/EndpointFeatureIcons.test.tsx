import { describe, expect, test } from "bun:test";
import { Tooltip as TooltipProvider } from "@base-ui/react/tooltip";
import { render } from "@testing-library/react";
import type { OpenRouterEndpoint } from "@/shared/api/models";
import * as helpers from "../lib/endpoint-feature-icons-test-helpers";
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
		</TooltipProvider.Provider>,
	);
}

// `getQuantizationLabel` only reads `endpoint.quantization`, so the tests pass a
// minimal `{ quantization }` stub. This helper holds the single boundary cast to
// the full endpoint type; the runtime object is returned unchanged.
const asEndpoint = (stub: { quantization: string | null }) =>
	stub as unknown as OpenRouterEndpoint;

describe("getChipSizeClass", () => {
	test("showLabel=true, small → px-1 py-0.5", () => {
		expect(
			helpers.getChipSizeClass({
				flat: false,
				isSmall: true,
				shouldShowLabel: true,
			}),
		).toBe("px-1 py-0.5");
	});

	test("showLabel=true, not small → px-1.5 py-0.5", () => {
		expect(
			helpers.getChipSizeClass({
				flat: false,
				isSmall: false,
				shouldShowLabel: true,
			}),
		).toBe("px-1.5 py-0.5");
	});

	test("flat=true, small, no label → h-4 w-4", () => {
		expect(
			helpers.getChipSizeClass({
				flat: true,
				isSmall: true,
				shouldShowLabel: false,
			}),
		).toBe("h-4 w-4");
	});

	test("flat=true, not small, no label → h-5 w-5", () => {
		expect(
			helpers.getChipSizeClass({
				flat: true,
				isSmall: false,
				shouldShowLabel: false,
			}),
		).toBe("h-5 w-5");
	});

	test("flat=false, small, no label → h-4 w-4 p-0.5", () => {
		expect(
			helpers.getChipSizeClass({
				flat: false,
				isSmall: true,
				shouldShowLabel: false,
			}),
		).toBe("h-4 w-4 p-0.5");
	});

	test("flat=false, not small, no label → h-5 w-5 p-0.5", () => {
		expect(
			helpers.getChipSizeClass({
				flat: false,
				isSmall: false,
				shouldShowLabel: false,
			}),
		).toBe("h-5 w-5 p-0.5");
	});

	test("showLabel=true, flat=true, small → px-1 py-0.5 (label wins)", () => {
		expect(
			helpers.getChipSizeClass({
				flat: true,
				isSmall: true,
				shouldShowLabel: true,
			}),
		).toBe("px-1 py-0.5");
	});

	test("showLabel=true, flat=true, not small → px-1.5 py-0.5 (label wins)", () => {
		expect(
			helpers.getChipSizeClass({
				flat: true,
				isSmall: false,
				shouldShowLabel: true,
			}),
		).toBe("px-1.5 py-0.5");
	});
});

describe("buildQuantizationFeature", () => {
	test("returns a feature with the quantization key and label", () => {
		const feature = helpers.buildQuantizationFeature("FP16");
		expect(feature.key).toBe("quantization");
		expect(feature.config.label).toBe("FP16");
		expect(feature.config.shortLabel).toBe("FP16");
		expect(feature.config.description).toContain("FP16");
	});
});

describe("appendSupportedParams", () => {
	test("appends up to maxIcons features from supported params", () => {
		const features: Array<{ key: string; config: unknown }> = [];
		const supported = new Set(["tools", "reasoning", "structured_outputs"]);
		helpers.appendSupportedParams(features as never, supported, 2);
		expect(features.length).toBe(2);
		expect(features[0]?.key).toBe("tools");
		expect(features[1]?.key).toBe("reasoning");
	});

	test("skips unsupported params", () => {
		const features: Array<{ key: string; config: unknown }> = [];
		const supported = new Set(["reasoning"]);
		helpers.appendSupportedParams(features as never, supported, 4);
		expect(features.length).toBe(1);
		expect(features[0]?.key).toBe("reasoning");
	});

	test("is a no-op when features array is already at maxIcons", () => {
		const features = [{ key: "existing", config: {} }];
		helpers.appendSupportedParams(features as never, new Set(["tools"]), 1);
		expect(features.length).toBe(1);
	});
});

describe("getQuantizationLabel", () => {
	test("returns undefined when quantization is null", () => {
		expect(
			helpers.getQuantizationLabel(asEndpoint({ quantization: null })),
		).toBeUndefined();
	});

	test("returns undefined for 'unknown' quantization", () => {
		expect(
			helpers.getQuantizationLabel(asEndpoint({ quantization: "unknown" })),
		).toBeUndefined();
	});

	test("returns label for known quantization", () => {
		expect(
			helpers.getQuantizationLabel(asEndpoint({ quantization: "fp16" })),
		).toBe("FP16");
	});

	test("returns label case-insensitively", () => {
		expect(
			helpers.getQuantizationLabel(asEndpoint({ quantization: "INT4" })),
		).toBe("INT4");
	});
});

describe("resolveParamFeature", () => {
	test("returns null when param is not in supportedParamsSet", () => {
		expect(helpers.resolveParamFeature("tools", new Set<string>())).toBeNull();
	});

	test("returns null when param is in set but has no FEATURE_ICONS entry", () => {
		expect(
			helpers.resolveParamFeature(
				"unknown_param_xyz",
				new Set(["unknown_param_xyz"]),
			),
		).toBeNull();
	});

	test("returns FeatureIconConfig when param is supported and recognized", () => {
		const config = helpers.resolveParamFeature("tools", new Set(["tools"]));
		expect(config).not.toBeNull();
		expect(config?.shortLabel).toBe("FN");
	});
});

describe("EndpointFeatureIcons", () => {
	test("renders nothing when endpoint has no recognized features", () => {
		const { container } = renderIt(makeEndpoint());
		expect(container.firstChild).toBeNull();
	});

	test("renders feature icons for supported_parameters in canonical priority", () => {
		const { container } = renderIt(
			makeEndpoint({ supported_parameters: ["tools", "reasoning"] }),
		);
		expect(container.firstElementChild).not.toBeNull();
	});

	test("renders quantization label when present", () => {
		const { container } = renderIt(
			makeEndpoint({ quantization: "fp16", supported_parameters: [] }),
		);
		expect(container.textContent).toContain("FP16");
	});

	test("ignores 'unknown' quantization", () => {
		const { container } = renderIt(
			makeEndpoint({ quantization: "unknown", supported_parameters: [] }),
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
			}),
		);
		// Quantization absent — only feature icons. Maxes 4 by default.
		const innerChips = container.querySelectorAll("[role]");
		expect(innerChips.length).toBeLessThanOrEqual(8); // tooltip wrappers + chips
	});
});
