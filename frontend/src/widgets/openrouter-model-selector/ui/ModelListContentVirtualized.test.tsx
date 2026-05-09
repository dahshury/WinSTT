import { describe, expect, test } from "bun:test";
import { Combobox } from "@base-ui/react/combobox";
import { Tooltip as TooltipProvider } from "@base-ui/react/tooltip";
import { render } from "@testing-library/react";
import type { OpenRouterEndpoint, OpenRouterModel } from "@/shared/api/models";
import {
	__model_list_content_virtualized_test_helpers__ as helpers,
	ModelListContentVirtualized,
	type VirtualizedItem,
} from "./ModelListContentVirtualized";

describe("ModelListContentVirtualized", () => {
	test("renders empty state for empty grouped list", () => {
		const { container } = render(
			<TooltipProvider.Provider>
				<Combobox.Root items={[]}>
					<ModelListContentVirtualized
						expandedModels={new Set()}
						groupedModels={[]}
						hasActiveFilters={false}
						onSelectModel={() => undefined}
						onToggleModelExpanded={() => undefined}
						parsedModelId={undefined}
						parsedProviderSlug={undefined}
					/>
				</Combobox.Root>
			</TooltipProvider.Provider>
		);
		expect(container.firstElementChild).not.toBeNull();
	});
});

/* ── Pure helper unit tests ─────────────────────────────────────────── */

const makeEndpoint = (overrides: Partial<OpenRouterEndpoint> = {}): OpenRouterEndpoint =>
	({
		name: "default",
		model_name: "gpt-4o",
		context_length: 128_000,
		pricing: { prompt: "0", completion: "0" },
		provider_name: "DeepInfra",
		tag: "deepinfra",
		max_completion_tokens: 4096,
		...overrides,
	}) as unknown as OpenRouterEndpoint;

const makeModel = (overrides: Partial<OpenRouterModel> = {}): OpenRouterModel =>
	({
		id: "openai/gpt-4o",
		name: "GPT-4o",
		maker: "openai",
		model_name: "GPT-4o",
		context_length: 128_000,
		endpoints: [makeEndpoint()],
		...overrides,
	}) as unknown as OpenRouterModel;

describe("isPositiveNumber", () => {
	test.each<[number | null | undefined, boolean]>([
		[1, true],
		[0.5, true],
		[0, false],
		[-3, false],
		[null, false],
		[undefined, false],
	])("isPositiveNumber(%p) -> %p", (value, expected) => {
		expect(helpers.isPositiveNumber(value)).toBe(expected);
	});
});

describe("hasModelEndpoints", () => {
	test("true when endpoints array non-empty", () => {
		expect(helpers.hasModelEndpoints(makeModel())).toBe(true);
	});

	test("false when endpoints empty", () => {
		expect(helpers.hasModelEndpoints(makeModel({ endpoints: [] }))).toBe(false);
	});

	test("false when endpoints missing", () => {
		expect(helpers.hasModelEndpoints(makeModel({ endpoints: undefined as unknown as never }))).toBe(
			false
		);
	});
});

describe("getEndpointProviderSlug", () => {
	test("returns tag when present", () => {
		expect(helpers.getEndpointProviderSlug(makeEndpoint({ tag: "ti", provider_name: "Pn" }))).toBe(
			"ti"
		);
	});

	test("falls back to provider_name when tag empty", () => {
		expect(
			helpers.getEndpointProviderSlug(makeEndpoint({ tag: "", provider_name: "Together" }))
		).toBe("Together");
	});
});

describe("findSelectedProvider", () => {
	const eps = [
		makeEndpoint({ provider_name: "DeepInfra", tag: "deepinfra" }),
		makeEndpoint({ provider_name: "Together", tag: "together" }),
	];

	test("returns null with undefined slug", () => {
		expect(helpers.findSelectedProvider(eps, undefined)).toBeNull();
	});

	test("matches by tag", () => {
		expect(helpers.findSelectedProvider(eps, "together")?.provider_name).toBe("Together");
	});

	test("matches by provider_name", () => {
		expect(helpers.findSelectedProvider(eps, "DeepInfra")?.tag).toBe("deepinfra");
	});

	test("returns null when no match", () => {
		expect(helpers.findSelectedProvider(eps, "nope")).toBeNull();
	});
});

describe("computeSelectionFlags", () => {
	test("isSelected when ids match and no provider", () => {
		expect(helpers.computeSelectionFlags("a", "a", undefined)).toEqual({
			isSelected: true,
			isProviderSelected: false,
		});
	});

	test("isProviderSelected when ids match and slug present", () => {
		expect(helpers.computeSelectionFlags("a", "a", "deepinfra")).toEqual({
			isSelected: false,
			isProviderSelected: true,
		});
	});

	test("neither when ids differ", () => {
		expect(helpers.computeSelectionFlags("a", "b", "deepinfra")).toEqual({
			isSelected: false,
			isProviderSelected: false,
		});
	});
});

describe("computeModelEndpoints / getCachedUniqueEndpoints", () => {
	test("returns hasEndpoints true and unique list", () => {
		const m = makeModel({
			endpoints: [
				makeEndpoint({ provider_name: "A" }),
				makeEndpoint({ provider_name: "A" }),
				makeEndpoint({ provider_name: "B" }),
			],
		});
		const result = helpers.computeModelEndpoints(m);
		expect(result.hasEndpoints).toBe(true);
		expect(result.uniqueEndpoints).toHaveLength(2);
	});

	test("empty endpoints -> false / []", () => {
		const m = makeModel({ endpoints: [] });
		expect(helpers.computeModelEndpoints(m)).toEqual({
			hasEndpoints: false,
			uniqueEndpoints: [],
		});
	});

	test("getCachedUniqueEndpoints caches via WeakMap", () => {
		const m = makeModel();
		const a = helpers.getCachedUniqueEndpoints(m);
		const b = helpers.getCachedUniqueEndpoints(m);
		expect(a).toBe(b);
	});

	test("getCachedUniqueEndpoints with missing endpoints returns []", () => {
		const m = makeModel({ endpoints: undefined as unknown as never });
		expect(helpers.getCachedUniqueEndpoints(m)).toEqual([]);
	});
});

describe("computeVariantClasses", () => {
	test("null when no variant", () => {
		expect(helpers.computeVariantClasses(makeModel({ variant: undefined }))).toBeNull();
	});

	test("returns class object when variant set", () => {
		const result = helpers.computeVariantClasses(makeModel({ variant: "free" }));
		expect(result).not.toBeNull();
		expect(typeof result?.bg).toBe("string");
	});
});

describe("computeHeaderPricing", () => {
	test("null when hasProviders is true", () => {
		expect(helpers.computeHeaderPricing([makeEndpoint()], true)).toBeNull();
	});

	test("null when no endpoints", () => {
		expect(helpers.computeHeaderPricing([], false)).toBeNull();
	});

	test("returns pricing tier from first endpoint", () => {
		const result = helpers.computeHeaderPricing(
			[makeEndpoint({ pricing: { prompt: "0", completion: "0" } as never })],
			false
		);
		expect(result?.tier).toBe("free");
	});
});

describe("computeSelectedProvider", () => {
	test("returns null when not provider-selected", () => {
		expect(
			helpers.computeSelectedProvider(
				[makeEndpoint()],
				{ isSelected: true, isProviderSelected: false },
				"deepinfra"
			)
		).toBeNull();
	});

	test("returns matched provider when flag set", () => {
		const ep = makeEndpoint({ provider_name: "Together", tag: "together" });
		expect(
			helpers.computeSelectedProvider(
				[ep],
				{ isSelected: false, isProviderSelected: true },
				"together"
			)
		).toBe(ep);
	});
});

describe("computeModelHeaderState", () => {
	test("aggregates flags, endpoints and pricing", () => {
		const m = makeModel({
			variant: "free",
			endpoints: [makeEndpoint({ pricing: { prompt: "0", completion: "0" } as never })],
		});
		const state = helpers.computeModelHeaderState(m, m.id, undefined, false);
		expect(state.hasEndpoints).toBe(true);
		expect(state.isSelected).toBe(true);
		expect(state.isProviderSelected).toBe(false);
		expect(state.variantClasses).not.toBeNull();
		expect(state.pricingInfo?.tier).toBe("free");
	});

	test("provider selected branch", () => {
		const m = makeModel({
			endpoints: [makeEndpoint({ provider_name: "Together", tag: "together" })],
		});
		const state = helpers.computeModelHeaderState(m, m.id, "together", true);
		expect(state.isProviderSelected).toBe(true);
		expect(state.selectedProvider?.provider_name).toBe("Together");
		expect(state.pricingInfo).toBeNull();
	});
});

describe("isAnyModelSelected", () => {
	test.each<[{ isSelected: boolean; isProviderSelected: boolean }, boolean]>([
		[{ isSelected: true, isProviderSelected: false }, true],
		[{ isSelected: false, isProviderSelected: true }, true],
		[{ isSelected: false, isProviderSelected: false }, false],
	])("flags %p -> %p", (flags, expected) => {
		expect(helpers.isAnyModelSelected(flags)).toBe(expected);
	});
});

describe("getModelCardClassName", () => {
	test("includes selected classes when any flag set", () => {
		const cls = helpers.getModelCardClassName({ isSelected: true, isProviderSelected: false });
		expect(cls).toContain("border-accent/50");
	});

	test("omits selected ring when neither flag set", () => {
		const cls = helpers.getModelCardClassName({ isSelected: false, isProviderSelected: false });
		expect(cls).not.toContain("ring-accent/30");
	});
});

describe("getProviderCardClassName", () => {
	test("selected adds accent ring", () => {
		expect(helpers.getProviderCardClassName(true)).toContain("ring-accent/30");
	});

	test("idle has base only", () => {
		expect(helpers.getProviderCardClassName(false)).not.toContain("ring-accent/30");
	});
});

describe("getSelectionDotClassName", () => {
	test("selected dot has bg-accent", () => {
		expect(helpers.getSelectionDotClassName(true)).toContain("bg-accent");
	});

	test("idle dot is transparent", () => {
		expect(helpers.getSelectionDotClassName(false)).toContain("bg-transparent");
	});
});

describe("getNonFreeBaseTextColor", () => {
	test("foreground-secondary when fallback flag true", () => {
		expect(helpers.getNonFreeBaseTextColor(true)).toBe("text-foreground-secondary");
	});

	test("foreground when fallback flag false", () => {
		expect(helpers.getNonFreeBaseTextColor(false)).toBe("text-foreground");
	});
});

describe("getPricingBaseTextColor", () => {
	test("free returns emerald colors", () => {
		expect(
			helpers.getPricingBaseTextColor({ tier: "free", label: "Free", className: "x" }, true)
		).toContain("emerald");
	});

	test("non-free delegates to non-free helper", () => {
		expect(
			helpers.getPricingBaseTextColor({ tier: "low", label: "$0.1", className: "x" }, false)
		).toBe("text-foreground");
	});
});

describe("getPricingExtraClass", () => {
	test("returns false for free tier", () => {
		expect(helpers.getPricingExtraClass({ tier: "free", label: "Free", className: "x" })).toBe(
			false
		);
	});

	test("returns className for non-free", () => {
		expect(
			helpers.getPricingExtraClass({ tier: "high", label: "$10", className: "rose-thing" })
		).toBe("rose-thing");
	});
});

describe("getPricingClassName", () => {
	test("merges base + tier color", () => {
		const cls = helpers.getPricingClassName({ tier: "free", label: "Free", className: "x" }, true);
		expect(cls).toContain("font-semibold");
		expect(cls).toContain("emerald");
	});

	test("non-free includes tier className", () => {
		const cls = helpers.getPricingClassName(
			{ tier: "medium", label: "$1", className: "amber-class" },
			false
		);
		expect(cls).toContain("amber-class");
	});
});

describe("getPricingLabel", () => {
	test("returns 'Free' for free tier", () => {
		expect(helpers.getPricingLabel({ tier: "free", label: "ignored", className: "x" })).toBe(
			"Free"
		);
	});

	test("returns label for non-free", () => {
		expect(helpers.getPricingLabel({ tier: "low", label: "$0.1", className: "x" })).toBe("$0.1");
	});
});

describe("getProvidersRowState / getProvidersGridTemplateRows", () => {
	test("open state", () => {
		expect(helpers.getProvidersRowState(true)).toBe("open");
		expect(helpers.getProvidersGridTemplateRows(true)).toBe("1fr");
	});

	test("closed state", () => {
		expect(helpers.getProvidersRowState(false)).toBe("closed");
		expect(helpers.getProvidersGridTemplateRows(false)).toBe("0fr");
	});
});

describe("getExpandAriaLabel", () => {
	test("expanded uses 'Hide'", () => {
		expect(helpers.getExpandAriaLabel(true, 3)).toBe("Hide 3 hosting providers");
	});

	test("collapsed uses 'Show'", () => {
		expect(helpers.getExpandAriaLabel(false, 1)).toBe("Show 1 hosting providers");
	});
});

describe("getExpandButtonClassName / getChevronClassName", () => {
	test("expanded button gets text-accent", () => {
		expect(helpers.getExpandButtonClassName(true)).toContain("text-accent");
	});

	test("collapsed button omits standalone text-accent token", () => {
		// Collapsed contains only hover:text-accent, expanded adds plain text-accent.
		const cls = helpers.getExpandButtonClassName(false);
		expect(cls).not.toMatch(/(?<![:-])text-accent\b/);
	});

	test("expanded chevron rotates", () => {
		expect(helpers.getChevronClassName(true)).toContain("rotate-90");
	});

	test("collapsed chevron does not rotate", () => {
		expect(helpers.getChevronClassName(false)).not.toContain("rotate-90");
	});
});

describe("getProviderCountTooltip", () => {
	test("singular for 1", () => {
		expect(helpers.getProviderCountTooltip(1)).toContain("1 provider hosts");
	});

	test("plural for >1", () => {
		expect(helpers.getProviderCountTooltip(4)).toContain("4 providers host");
	});
});

describe("getSelectionState", () => {
	test.each<[boolean, boolean, "selected" | "provider" | "none"]>([
		[true, false, "selected"],
		[false, true, "provider"],
		[false, false, "none"],
		[true, true, "selected"],
	])("isSelected=%p providerSelected=%p -> %p", (sel, prov, expected) => {
		expect(helpers.getSelectionState(sel, prov).kind).toBe(expected);
	});
});

describe("getSelectionProviderTooltip", () => {
	test("with name returns 'Provider: name'", () => {
		expect(helpers.getSelectionProviderTooltip("Together")).toBe("Provider: Together");
	});

	test("without name returns generic", () => {
		expect(helpers.getSelectionProviderTooltip(undefined)).toBe("Provider selected");
	});
});

describe("buildVirtualItems / appendModelEntries", () => {
	test("flattens grouped models with single endpoint into model rows only", () => {
		const m1 = makeModel({ id: "openai/m1" });
		const m2 = makeModel({ id: "openai/m2" });
		const items = helpers.buildVirtualItems([["openai", [m1, m2]]], new Set());
		expect(items).toHaveLength(2);
		expect(items.every((i) => i.type === "model")).toBe(true);
	});

	test("models with multiple providers add a providers row", () => {
		const m = makeModel({
			id: "openai/multi",
			endpoints: [makeEndpoint({ provider_name: "A" }), makeEndpoint({ provider_name: "B" })],
		});
		const items = helpers.buildVirtualItems([["openai", [m]]], new Set(["openai/multi"]));
		expect(items).toHaveLength(2);
		expect(items[0]?.type).toBe("model");
		expect(items[1]?.type).toBe("providers");
		const head = items[0];
		if (head?.type === "model") {
			expect(head.isExpanded).toBe(true);
			expect(head.hasProviders).toBe(true);
		}
	});

	test("appendModelEntries returns next index correctly", () => {
		const items: VirtualizedItem[] = [];
		const m = makeModel({
			id: "openai/multi2",
			endpoints: [makeEndpoint({ provider_name: "A" }), makeEndpoint({ provider_name: "B" })],
		});
		const next = helpers.appendModelEntries(items, 0, m, 0, new Set());
		expect(next).toBe(2);
		expect(items).toHaveLength(2);
	});

	test("empty groupedModels returns []", () => {
		expect(helpers.buildVirtualItems([], new Set())).toEqual([]);
	});
});

describe("findActiveVirtualIndex", () => {
	const handle = {
		getItemOffset: (i: number) => i * 10,
		getItemSize: () => 10,
	};

	test("returns first item whose end exceeds offset", () => {
		// items[2] spans 20..30; threshold = 26; 30 > 26 -> index 2
		expect(helpers.findActiveVirtualIndex(handle, 5, 25)).toBe(2);
	});

	test("returns last index when offset is beyond all items", () => {
		expect(helpers.findActiveVirtualIndex(handle, 5, 999)).toBe(4);
	});

	test("returns 0 when offset is at top", () => {
		expect(helpers.findActiveVirtualIndex(handle, 5, 0)).toBe(0);
	});
});

describe("findIndexByModelId / findIndexByMaker / findScrollTargetIndex", () => {
	const items: VirtualizedItem[] = [
		{
			type: "model",
			model: makeModel({ id: "a/1", maker: "a" }),
			groupIndex: 0,
			index: 0,
			isExpanded: false,
			hasProviders: false,
		},
		{
			type: "model",
			model: makeModel({ id: "b/2", maker: "b" }),
			groupIndex: 1,
			index: 1,
			isExpanded: false,
			hasProviders: false,
		},
	];

	test("findIndexByModelId returns -1 for undefined", () => {
		expect(helpers.findIndexByModelId(items, undefined)).toBe(-1);
	});

	test("findIndexByModelId locates model", () => {
		expect(helpers.findIndexByModelId(items, "b/2")).toBe(1);
	});

	test("findIndexByModelId returns -1 when missing", () => {
		expect(helpers.findIndexByModelId(items, "missing")).toBe(-1);
	});

	test("findIndexByMaker locates first model in group", () => {
		expect(helpers.findIndexByMaker(items, "b")).toBe(1);
	});

	test("findIndexByMaker returns -1 when missing", () => {
		expect(helpers.findIndexByMaker(items, "z")).toBe(-1);
	});

	test("findScrollTargetIndex prefers model id", () => {
		expect(helpers.findScrollTargetIndex(items, { maker: "a", modelId: "b/2", nonce: 1 })).toBe(1);
	});

	test("findScrollTargetIndex falls back to maker", () => {
		expect(helpers.findScrollTargetIndex(items, { maker: "a", nonce: 1 })).toBe(0);
	});

	test("findScrollTargetIndex returns -1 when nothing matches", () => {
		expect(helpers.findScrollTargetIndex(items, { maker: "nope", nonce: 1 })).toBe(-1);
	});
});

describe("isFeaturedEndpointEligible / getFeaturedEndpoint", () => {
	test("ineligible when hasProviders", () => {
		expect(helpers.isFeaturedEndpointEligible([makeEndpoint()], true, true)).toBe(false);
	});

	test("ineligible when no endpoints", () => {
		expect(helpers.isFeaturedEndpointEligible([], false, false)).toBe(false);
	});

	test("eligible when single endpoint without providers", () => {
		expect(helpers.isFeaturedEndpointEligible([makeEndpoint()], true, false)).toBe(true);
	});

	test("getFeaturedEndpoint returns first endpoint when eligible", () => {
		const ep = makeEndpoint({ provider_name: "Solo" });
		expect(helpers.getFeaturedEndpoint([ep], true, false)).toBe(ep);
	});

	test("getFeaturedEndpoint returns null when ineligible", () => {
		expect(helpers.getFeaturedEndpoint([makeEndpoint()], true, true)).toBeNull();
	});

	test("getFeaturedEndpoint returns null when array empty", () => {
		expect(helpers.getFeaturedEndpoint([], false, false)).toBeNull();
	});
});

describe("shouldRenderInlineMeta / shouldShowStatsRow", () => {
	test("inline meta true when context length present", () => {
		expect(helpers.shouldRenderInlineMeta(1024, null, null)).toBe(true);
	});

	test("inline meta true when pricing present", () => {
		expect(
			helpers.shouldRenderInlineMeta(null, { tier: "free", label: "Free", className: "x" }, null)
		).toBe(true);
	});

	test("inline meta true when featured endpoint present", () => {
		expect(helpers.shouldRenderInlineMeta(null, null, makeEndpoint())).toBe(true);
	});

	test("inline meta false when nothing present", () => {
		expect(helpers.shouldRenderInlineMeta(null, null, null)).toBe(false);
	});

	test("stats row true when context length positive", () => {
		expect(helpers.shouldShowStatsRow(100, null)).toBe(true);
	});

	test("stats row true when max out positive", () => {
		expect(helpers.shouldShowStatsRow(null, 50)).toBe(true);
	});

	test("stats row false when both null", () => {
		expect(helpers.shouldShowStatsRow(null, null)).toBe(false);
	});
});

describe("isProviderSelected", () => {
	const m = makeModel({ id: "openai/x" });

	test("true when ids and slug match", () => {
		expect(helpers.isProviderSelected(m, "deepinfra", "openai/x", "deepinfra")).toBe(true);
	});

	test("false when slug differs", () => {
		expect(helpers.isProviderSelected(m, "deepinfra", "openai/x", "together")).toBe(false);
	});

	test("false when id differs", () => {
		expect(helpers.isProviderSelected(m, "deepinfra", "other/x", "deepinfra")).toBe(false);
	});
});

describe("resolveMakerIconSrc", () => {
	test("undefined maker returns null", () => {
		expect(helpers.resolveMakerIconSrc(undefined)).toBeNull();
	});

	test("known maker returns a string path", () => {
		expect(typeof helpers.resolveMakerIconSrc("openai")).toBe("string");
	});

	test("unknown maker still falls back to a string", () => {
		expect(typeof helpers.resolveMakerIconSrc("zzz-no-such-maker")).toBe("string");
	});
});

describe("getEmptyStateLabel / getEmptyStateBody", () => {
	test("filtered label", () => {
		expect(helpers.getEmptyStateLabel(true)).toBe("No models found");
	});

	test("unfiltered label", () => {
		expect(helpers.getEmptyStateLabel(false)).toBe("Unable to load models");
	});

	test("filtered body suggests adjusting", () => {
		expect(helpers.getEmptyStateBody(true)).toContain("filters");
	});

	test("unfiltered body mentions connection", () => {
		expect(helpers.getEmptyStateBody(false)).toContain("connection");
	});
});

describe("getRowKey", () => {
	test("model item -> model-<id>", () => {
		const item: VirtualizedItem = {
			type: "model",
			model: makeModel({ id: "openai/k1" }),
			groupIndex: 0,
			index: 0,
			isExpanded: false,
			hasProviders: false,
		};
		expect(helpers.getRowKey(item)).toBe("model-openai/k1");
	});

	test("providers item -> providers-<id>", () => {
		const item: VirtualizedItem = {
			type: "providers",
			model: makeModel({ id: "openai/k2" }),
			endpoints: [makeEndpoint()],
			isOpen: true,
			index: 1,
		};
		expect(helpers.getRowKey(item)).toBe("providers-openai/k2");
	});
});
