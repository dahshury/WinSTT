import { describe, expect, test } from "bun:test";
import { Tooltip as TooltipProvider } from "@base-ui/react/tooltip";
import { render } from "@testing-library/react";
import type { OpenRouterEndpoint, OpenRouterModel } from "@/shared/api/models";
import {
	__openrouter_model_selector_test_helpers__ as helpers,
	OpenRouterModelSelector,
} from "./OpenRouterModelSelector";

describe("OpenRouterModelSelector", () => {
	test("renders without crashing for empty model list", () => {
		const { container } = render(
			<TooltipProvider.Provider>
				<OpenRouterModelSelector models={[]} onChange={() => undefined} value="" />
			</TooltipProvider.Provider>
		);
		expect(container.firstElementChild).not.toBeNull();
	});

	test("renders the disabled state", () => {
		const { container } = render(
			<TooltipProvider.Provider>
				<OpenRouterModelSelector disabled models={[]} onChange={() => undefined} value="" />
			</TooltipProvider.Provider>
		);
		expect(container.firstElementChild).not.toBeNull();
	});
});

// --- Tests for pure helpers ---

function makeElement(
	tag: string,
	attrs: Record<string, string> = {},
	dataset: Record<string, string> = {}
): HTMLElement {
	const el = document.createElement(tag);
	for (const [k, v] of Object.entries(attrs)) {
		el.setAttribute(k, v);
	}
	for (const [k, v] of Object.entries(dataset)) {
		el.dataset[k] = v;
	}
	return el;
}

function makeModel(overrides: Partial<OpenRouterModel> = {}): OpenRouterModel {
	return {
		id: "openai/gpt-4o",
		name: "GPT-4o",
		maker: "openai",
		...overrides,
	} as OpenRouterModel;
}

function makeEndpoint(overrides: Partial<OpenRouterEndpoint> = {}): OpenRouterEndpoint {
	return {
		name: "endpoint",
		model_name: "GPT-4o",
		context_length: 128_000,
		pricing: {} as OpenRouterEndpoint["pricing"],
		provider_name: "deepinfra",
		tag: "deepinfra",
		...overrides,
	} as OpenRouterEndpoint;
}

describe("OpenRouterModelSelector helpers", () => {
	describe("nodeRoleIsPopup", () => {
		test.each([
			["menu", true],
			["menuitem", true],
			["tooltip", true],
			["dialog", false],
			["", false],
		])("role=%p → %p", (role, expected) => {
			const node = makeElement("div", role ? { role } : {});
			expect(helpers.nodeRoleIsPopup(node)).toBe(expected);
		});

		test("missing role attribute returns false", () => {
			expect(helpers.nodeRoleIsPopup(makeElement("div"))).toBe(false);
		});
	});

	describe("nodeSlotIsPopup", () => {
		test("returns true when data-slot is the popup slot", () => {
			const el = makeElement("div", {}, { slot: "model-filters-menu-content" });
			expect(helpers.nodeSlotIsPopup(el)).toBe(true);
		});

		test("returns false for other slot values", () => {
			const el = makeElement("div", {}, { slot: "something-else" });
			expect(helpers.nodeSlotIsPopup(el)).toBe(false);
		});

		test("returns false for missing data-slot", () => {
			expect(helpers.nodeSlotIsPopup(makeElement("div"))).toBe(false);
		});
	});

	describe("nodeMatchesPopupSelector", () => {
		test("matches own popup reference", () => {
			const popup = makeElement("div");
			expect(helpers.nodeMatchesPopupSelector(popup, popup)).toBe(true);
		});

		test("matches role-based popup", () => {
			const node = makeElement("div", { role: "menu" });
			expect(helpers.nodeMatchesPopupSelector(node, null)).toBe(true);
		});

		test("matches slot-based popup", () => {
			const node = makeElement("div", {}, { slot: "model-filters-menu-content" });
			expect(helpers.nodeMatchesPopupSelector(node, null)).toBe(true);
		});

		test("returns false when no condition matches", () => {
			const node = makeElement("div", { role: "presentation" });
			expect(helpers.nodeMatchesPopupSelector(node, null)).toBe(false);
		});
	});

	describe("walkAncestors", () => {
		test("returns empty array for null start", () => {
			expect(helpers.walkAncestors(null)).toEqual([]);
		});

		test("walks the chain including the start element", () => {
			const grandparent = makeElement("div");
			const parent = makeElement("div");
			const child = makeElement("span");
			grandparent.appendChild(parent);
			parent.appendChild(child);
			const chain = helpers.walkAncestors(child);
			expect(chain).toEqual([child, parent, grandparent]);
		});
	});

	describe("isInsideMenuPopup", () => {
		test("returns true when click landed in own popup", () => {
			const popup = makeElement("div");
			const inner = makeElement("span");
			popup.appendChild(inner);
			expect(helpers.isInsideMenuPopup(inner, popup)).toBe(true);
		});

		test("returns true when ancestor has popup role", () => {
			const popup = makeElement("div", { role: "menu" });
			const inner = makeElement("span");
			popup.appendChild(inner);
			expect(helpers.isInsideMenuPopup(inner, null)).toBe(true);
		});

		test("returns false for null target", () => {
			expect(helpers.isInsideMenuPopup(null, null)).toBe(false);
		});

		test("returns false when no ancestor matches", () => {
			const root = makeElement("div");
			const child = makeElement("span");
			root.appendChild(child);
			expect(helpers.isInsideMenuPopup(child, null)).toBe(false);
		});
	});

	describe("applyExclusion", () => {
		test("returns models unchanged when config is undefined", () => {
			const models = [makeModel()];
			expect(helpers.applyExclusion(models, undefined)).toBe(models);
		});

		test("delegates to filterModelsForFallback when config provided", () => {
			const models = [makeModel({ id: "openai/gpt-4o" }), makeModel({ id: "anthropic/c" })];
			const result = helpers.applyExclusion(models, {
				excludedModelId: "openai/gpt-4o",
				excludeAllProviders: true,
				excludedProviderSlug: undefined,
			});
			expect(result.find((m) => m.id === "openai/gpt-4o")).toBeUndefined();
		});
	});

	describe("applyDisabledFilter", () => {
		test("returns models unchanged when disabledIds is undefined", () => {
			const models = [makeModel()];
			expect(helpers.applyDisabledFilter(models, undefined)).toBe(models);
		});

		test("returns models unchanged when disabledIds is empty", () => {
			const models = [makeModel()];
			expect(helpers.applyDisabledFilter(models, [])).toBe(models);
		});

		test("filters out disabled ids", () => {
			const models = [makeModel({ id: "a" }), makeModel({ id: "b" }), makeModel({ id: "c" })];
			const filtered = helpers.applyDisabledFilter(models, ["b"]);
			expect(filtered.map((m) => m.id)).toEqual(["a", "c"]);
		});
	});

	describe("applyModelFilters", () => {
		test("composes both filters", () => {
			const models = [makeModel({ id: "a" }), makeModel({ id: "b" })];
			const result = helpers.applyModelFilters(models, undefined, ["a"]);
			expect(result.map((m) => m.id)).toEqual(["b"]);
		});

		test("no-op when neither config nor disabledIds is provided", () => {
			const models = [makeModel()];
			expect(helpers.applyModelFilters(models, undefined, undefined)).toBe(models);
		});
	});

	describe("endpointMatchesProviderSlug", () => {
		test.each([
			["deepinfra", "deepinfra", true],
			["openai", "openai", true],
			["deepinfra", "openai", false],
		])("(%p, %p) → %p", (providerName, slug, expected) => {
			const ep = makeEndpoint({ provider_name: providerName, tag: "different" });
			expect(helpers.endpointMatchesProviderSlug(ep, slug)).toBe(expected);
		});

		test("matches by tag when provider_name differs", () => {
			const ep = makeEndpoint({ provider_name: "x", tag: "y" });
			expect(helpers.endpointMatchesProviderSlug(ep, "y")).toBe(true);
		});
	});

	describe("selectEndpointFromList", () => {
		test("returns first matching endpoint", () => {
			const eps = [
				makeEndpoint({ provider_name: "a", tag: "a" }),
				makeEndpoint({ provider_name: "b", tag: "b" }),
			];
			expect(helpers.selectEndpointFromList(eps, "b")?.tag).toBe("b");
		});

		test("returns null when nothing matches", () => {
			const eps = [makeEndpoint({ provider_name: "a", tag: "a" })];
			expect(helpers.selectEndpointFromList(eps, "z")).toBeNull();
		});
	});

	describe("findEndpointForProviderSlug", () => {
		test("returns null for missing model", () => {
			expect(helpers.findEndpointForProviderSlug(undefined, "x")).toBeNull();
		});

		test("returns null for missing slug", () => {
			expect(helpers.findEndpointForProviderSlug(makeModel(), undefined)).toBeNull();
		});

		test("returns null when model has no endpoints", () => {
			expect(helpers.findEndpointForProviderSlug(makeModel(), "x")).toBeNull();
		});

		test("returns the matched endpoint", () => {
			const ep = makeEndpoint({ provider_name: "deepinfra", tag: "deepinfra" });
			const model = makeModel({ endpoints: [ep] });
			expect(helpers.findEndpointForProviderSlug(model, "deepinfra")).toBe(ep);
		});
	});

	describe("shouldBlockSelection", () => {
		test("returns false when no exclusion config", () => {
			expect(helpers.shouldBlockSelection("a", "b", undefined)).toBe(false);
		});

		test("returns false when modelId is undefined", () => {
			expect(
				helpers.shouldBlockSelection(undefined, undefined, {
					excludedModelId: "a",
					excludeAllProviders: true,
					excludedProviderSlug: undefined,
				})
			).toBe(false);
		});

		test("returns true when (modelId, slug) is excluded", () => {
			expect(
				helpers.shouldBlockSelection("a", undefined, {
					excludedModelId: "a",
					excludeAllProviders: true,
					excludedProviderSlug: undefined,
				})
			).toBe(true);
		});
	});

	describe("resolveSelectionValue", () => {
		test("returns combined model+provider selection when modelId provided", () => {
			expect(helpers.resolveSelectionValue("openai/gpt-4o", "deepinfra", null)).toBe(
				"openai/gpt-4o@deepinfra"
			);
		});

		test("returns modelId only when no provider", () => {
			expect(helpers.resolveSelectionValue("openai/gpt-4o", undefined, null)).toBe("openai/gpt-4o");
		});

		test("falls back to defaultModelId when modelId is missing", () => {
			expect(helpers.resolveSelectionValue(undefined, undefined, "openrouter/auto")).toBe(
				"openrouter/auto"
			);
		});

		test("returns empty string when nothing is set", () => {
			expect(helpers.resolveSelectionValue(undefined, undefined, null)).toBe("");
		});
	});

	describe("splitTokenAtSeparator", () => {
		test("splits modelId@provider", () => {
			expect(helpers.splitTokenAtSeparator("openai/gpt-4o@deepinfra")).toEqual({
				modelId: "openai/gpt-4o",
				providerSlug: "deepinfra",
			});
		});

		test("returns just modelId when no @", () => {
			expect(helpers.splitTokenAtSeparator("openai/gpt-4o")).toEqual({
				modelId: "openai/gpt-4o",
			});
		});

		test("undefined providerSlug for trailing @", () => {
			expect(helpers.splitTokenAtSeparator("openai/gpt-4o@")).toEqual({
				modelId: "openai/gpt-4o",
				providerSlug: undefined,
			});
		});
	});

	describe("parseSelectionToken", () => {
		test("returns null for null token", () => {
			expect(helpers.parseSelectionToken(null)).toBeNull();
		});

		test("returns null for empty string", () => {
			expect(helpers.parseSelectionToken("")).toBeNull();
		});

		test("parses a valid token", () => {
			expect(helpers.parseSelectionToken("a@b")).toEqual({ modelId: "a", providerSlug: "b" });
		});
	});

	describe("buildScrollRequestForModel", () => {
		test("starts nonce at 1 when prev is null", () => {
			const req = helpers.buildScrollRequestForModel(null, makeModel({ maker: "openai" }));
			expect(req).toEqual({ maker: "openai", modelId: "openai/gpt-4o", nonce: 1 });
		});

		test("increments nonce monotonically", () => {
			const prev = { maker: "openai", nonce: 7 };
			const req = helpers.buildScrollRequestForModel(prev, makeModel({ maker: "anthropic" }));
			expect(req.nonce).toBe(8);
			expect(req.maker).toBe("anthropic");
		});
	});

	describe("buildScrollRequestForProvider", () => {
		test("starts nonce at 1 when prev is null", () => {
			expect(helpers.buildScrollRequestForProvider(null, "openai")).toEqual({
				maker: "openai",
				nonce: 1,
			});
		});

		test("increments nonce", () => {
			expect(helpers.buildScrollRequestForProvider({ maker: "x", nonce: 5 }, "openai")).toEqual({
				maker: "openai",
				nonce: 6,
			});
		});
	});
});
