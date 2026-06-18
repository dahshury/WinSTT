import { describe, expect, test } from "bun:test";
import { Combobox } from "@base-ui/react/combobox";
import { Tooltip as TooltipProvider } from "@base-ui/react/tooltip";
import { asInvalid } from "@test/lib/cast";
import {
	fireEvent,
	render,
	renderHook,
	screen,
} from "../test/render-with-intl";
import type { OpenRouterEndpoint, OpenRouterModel } from "@/shared/api/models";
import { useOpenedFlag } from "../core/Collapsible";
import * as components from "../lib/model-list-content-virtualized-components";
import * as utils from "../lib/model-list-content-virtualized-utils";
import type { VirtualizedItem } from "../lib/model-list-content-virtualized-utils";
import { InlineModelMeta } from "../lib/model-list-meta-chips";
import { ModelListContentVirtualized } from "./ModelListContentVirtualized";

const helpers = {
	...components,
	...utils,
	useProvidersOpenedFlag: useOpenedFlag,
};

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
			</TooltipProvider.Provider>,
		);
		expect(container.firstElementChild).not.toBeNull();
	});
});

/* ── Pure helper unit tests ─────────────────────────────────────────── */

const makeEndpoint = (
	overrides: Partial<OpenRouterEndpoint> = {},
): OpenRouterEndpoint =>
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
		expect(
			helpers.hasModelEndpoints(
				makeModel({ endpoints: asInvalid<never>(undefined) }),
			),
		).toBe(false);
	});
});

describe("getEndpointProviderSlug", () => {
	test("returns tag when present", () => {
		expect(
			helpers.getEndpointProviderSlug(
				makeEndpoint({ tag: "ti", provider_name: "Pn" }),
			),
		).toBe("ti");
	});

	test("falls back to provider_name when tag empty", () => {
		expect(
			helpers.getEndpointProviderSlug(
				makeEndpoint({ tag: "", provider_name: "Together" }),
			),
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
		expect(helpers.findSelectedProvider(eps, "together")?.provider_name).toBe(
			"Together",
		);
	});

	test("matches by provider_name", () => {
		expect(helpers.findSelectedProvider(eps, "DeepInfra")?.tag).toBe(
			"deepinfra",
		);
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
		const m = makeModel({ endpoints: asInvalid<never>(undefined) });
		expect(helpers.getCachedUniqueEndpoints(m)).toEqual([]);
	});
});

describe("computeVariantClasses", () => {
	test("null when no variant", () => {
		expect(helpers.computeVariantClasses(makeModel({}))).toBeNull();
	});

	test("returns class object when variant set", () => {
		const result = helpers.computeVariantClasses(
			makeModel({ variant: "free" }),
		);
		expect(result).not.toBeNull();
		expect(typeof result?.bg).toBe("string");
	});
});

describe("computeHeaderPricing", () => {
	test("null when hasProviders is true", () => {
		expect(
			helpers.computeHeaderPricing(makeModel({}), [makeEndpoint()], true),
		).toBeNull();
	});

	test("null when no endpoints", () => {
		expect(helpers.computeHeaderPricing(makeModel({}), [], false)).toBeNull();
	});

	test("returns pricing tier from first endpoint", () => {
		const result = helpers.computeHeaderPricing(
			makeModel({}),
			[makeEndpoint({ pricing: { prompt: "0", completion: "0" } as never })],
			false,
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
				"deepinfra",
			),
		).toBeNull();
	});

	test("returns matched provider when flag set", () => {
		const ep = makeEndpoint({ provider_name: "Together", tag: "together" });
		expect(
			helpers.computeSelectedProvider(
				[ep],
				{ isSelected: false, isProviderSelected: true },
				"together",
			),
		).toBe(ep);
	});
});

describe("computeModelHeaderState", () => {
	test("aggregates flags, endpoints and pricing", () => {
		const m = makeModel({
			variant: "free",
			endpoints: [
				makeEndpoint({ pricing: { prompt: "0", completion: "0" } as never }),
			],
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

	test("uses model-level pricing when endpoint enrichment is absent", () => {
		const m = makeModel({
			pricing: { prompt: "0", completion: "0" } as never,
		});
		const state = helpers.computeModelHeaderState(m, m.id, undefined, false);
		expect(state.pricingInfo?.tier).toBe("free");
	});
});

describe("InlineModelMeta", () => {
	test("renders OpenRouter transcription pricing without collapsed provider counts", () => {
		const m = makeModel({
			architecture: {
				input_modalities: ["audio"],
				output_modalities: ["transcription"],
			},
			context_length: asInvalid<never>(undefined),
			endpoints: [
				makeEndpoint({ provider_name: "A", tag: "a" }),
				makeEndpoint({ provider_name: "B", tag: "b" }),
			],
			pricing: { prompt: "0.0000015", completion: "0" } as never,
		});
		const { container } = render(
			<TooltipProvider.Provider>
				<InlineModelMeta
					hasEndpoints
					hasProviders
					model={m}
					pricingInfo={null}
					uniqueEndpoints={m.endpoints ?? []}
				/>
			</TooltipProvider.Provider>,
		);
		const text = container.textContent ?? "";
		expect(text).toContain("$1.50 per 1M input tokens");
		expect(text).toContain("Transcription");
		expect(text).not.toContain("2 providers");
	});

	test("renders duration-priced transcription models as hourly equivalents", () => {
		const cases = [
			{
				expected: "$0.96/h",
				id: "google/chirp-3",
				name: "Google: Chirp 3",
				pricing: { prompt: "0.016", completion: "0" },
			},
			{
				expected: "$0.36/h",
				id: "microsoft/mai-transcribe-1.5",
				name: "Microsoft: MAI-Transcribe 1.5",
				pricing: { prompt: "0.36", completion: "0" },
			},
			{
				expected: "$0.18/h",
				id: "mistralai/voxtral-mini-transcribe",
				name: "Mistral: Voxtral Mini Transcribe",
				pricing: { prompt: "0.003", completion: "0" },
			},
			{
				expected: "$0.09/h",
				id: "nvidia/parakeet-tdt-0.6b-v3",
				name: "NVIDIA: Parakeet TDT 0.6B v3",
				pricing: { prompt: "0.0015", completion: "0" },
			},
			{
				expected: "$0.36/h",
				id: "openai/whisper-1",
				name: "OpenAI: Whisper 1",
				pricing: { prompt: "0.006", completion: "0" },
			},
			{
				expected: "$0.09/h",
				id: "openai/whisper-large-v3",
				name: "OpenAI: Whisper Large V3",
				pricing: { prompt: "0.0015", completion: "0" },
			},
			{
				expected: "$0.04/h",
				id: "openai/whisper-large-v3-turbo",
				name: "OpenAI: Whisper Large V3 Turbo",
				pricing: { prompt: "0.04", completion: "0" },
			},
			{
				expected: "$0.126/h",
				id: "qwen/qwen3-asr-flash-2026-02-10",
				name: "Qwen: Qwen3 ASR Flash",
				pricing: { prompt: "0.000035", completion: "0" },
			},
		] as const;

		for (const testCase of cases) {
			const m = makeModel({
				architecture: {
					input_modalities: ["audio"],
					output_modalities: ["transcription"],
				},
				context_length: asInvalid<never>(undefined),
				endpoints: [],
				id: testCase.id,
				name: testCase.name,
				pricing: testCase.pricing as never,
			});
			const { container, unmount } = render(
				<TooltipProvider.Provider>
					<InlineModelMeta
						hasEndpoints={false}
						hasProviders={false}
						model={m}
						pricingInfo={null}
						uniqueEndpoints={[]}
					/>
				</TooltipProvider.Provider>,
			);
			const text = container.textContent ?? "";
			expect(text).toContain(testCase.expected);
			expect(text).not.toContain("per 1M input tokens");
			expect(text).not.toContain("/min");
			expect(text).not.toContain("/s");
			unmount();
		}
	});

	test("keeps token-priced transcription models on token pricing", () => {
		const m = makeModel({
			architecture: {
				input_modalities: ["audio"],
				output_modalities: ["transcription"],
			},
			context_length: 128_000,
			endpoints: [],
			id: "openai/gpt-4o-transcribe",
			name: "OpenAI: GPT-4o Transcribe",
			pricing: { prompt: "0.0000025", completion: "0.00001" } as never,
		});
		const { container } = render(
			<TooltipProvider.Provider>
				<InlineModelMeta
					hasEndpoints={false}
					hasProviders={false}
					model={m}
					pricingInfo={null}
					uniqueEndpoints={[]}
				/>
			</TooltipProvider.Provider>,
		);
		const text = container.textContent ?? "";
		expect(text).toContain("$2.50 input / $10.00 output per 1M tokens");
		expect(text).not.toContain("/h");
		expect(text).not.toContain("/min");
		expect(text).not.toContain("/s");
	});

	test("renders model-level OpenRouter capability badges without endpoints", () => {
		const m = makeModel({
			context_length: asInvalid<never>(undefined),
			endpoints: [],
			supported_parameters: ["structured_outputs"],
			variant: "thinking",
		});
		const { container } = render(
			<TooltipProvider.Provider>
				<InlineModelMeta
					hasEndpoints={false}
					hasProviders={false}
					model={m}
					pricingInfo={null}
					uniqueEndpoints={[]}
				/>
			</TooltipProvider.Provider>,
		);
		expect(
			container.querySelector('[data-feature-key="reasoning"]'),
		).not.toBeNull();
		expect(
			container.querySelector('[data-feature-key="structured_outputs"]'),
		).not.toBeNull();
	});

	test("merges featured endpoint quantization with model-level capabilities", () => {
		const endpoints = [
			makeEndpoint({
				quantization: "fp16",
				supported_parameters: [],
			}),
		];
		const m = makeModel({
			context_length: asInvalid<never>(undefined),
			endpoints,
			supported_parameters: ["structured_outputs"],
		});
		const { container } = render(
			<TooltipProvider.Provider>
				<InlineModelMeta
					hasEndpoints
					hasProviders={false}
					model={m}
					pricingInfo={null}
					uniqueEndpoints={endpoints}
				/>
			</TooltipProvider.Provider>,
		);
		expect(container.textContent).toContain("FP16");
		expect(
			container.querySelector('[data-feature-key="structured_outputs"]'),
		).not.toBeNull();
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
		const cls = helpers.getModelCardClassName({
			isSelected: true,
			isProviderSelected: false,
		});
		expect(cls).toContain("border-accent/55");
	});

	test("omits selected ring when neither flag set", () => {
		const cls = helpers.getModelCardClassName({
			isSelected: false,
			isProviderSelected: false,
		});
		expect(cls).not.toContain("ring-accent/30");
	});
});

describe("getProviderCardClassName", () => {
	test("selected adds accent ring", () => {
		expect(helpers.getProviderCardClassName(true)).toContain("ring-accent/40");
	});

	test("idle has base only", () => {
		expect(helpers.getProviderCardClassName(false)).not.toContain(
			"ring-accent/30",
		);
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
	test("returns muted foreground regardless of the fallback flag (true)", () => {
		expect(helpers.getNonFreeBaseTextColor(true)).toBe("text-foreground-muted");
	});

	test("returns muted foreground regardless of the fallback flag (false)", () => {
		expect(helpers.getNonFreeBaseTextColor(false)).toBe(
			"text-foreground-muted",
		);
	});
});

describe("getPricingBaseTextColor", () => {
	test("free returns the semantic free-pricing color", () => {
		expect(
			helpers.getPricingBaseTextColor(
				{ tier: "free", label: "Free", className: "x" },
				true,
			),
		).toContain("model-free");
	});

	test("non-free delegates to non-free helper", () => {
		expect(
			helpers.getPricingBaseTextColor(
				{ tier: "low", label: "$0.1", className: "x" },
				false,
			),
		).toBe("text-foreground-muted");
	});
});

describe("getPricingExtraClass", () => {
	test("returns false for free tier", () => {
		expect(
			helpers.getPricingExtraClass({
				tier: "free",
				label: "Free",
				className: "x",
			}),
		).toBe(false);
	});

	test("returns className for non-free", () => {
		expect(
			helpers.getPricingExtraClass({
				tier: "high",
				label: "$10",
				className: "rose-thing",
			}),
		).toBe("rose-thing");
	});
});

describe("getPricingClassName", () => {
	test("merges base + tier color", () => {
		const cls = helpers.getPricingClassName(
			{ tier: "free", label: "Free", className: "x" },
			true,
		);
		expect(cls).toContain("font-semibold");
		expect(cls).toContain("model-free");
	});

	test("non-free includes tier className", () => {
		const cls = helpers.getPricingClassName(
			{ tier: "medium", label: "$1", className: "amber-class" },
			false,
		);
		expect(cls).toContain("amber-class");
	});
});

describe("getPricingLabel", () => {
	test("returns 'Free' for free tier", () => {
		expect(
			helpers.getPricingLabel({
				tier: "free",
				label: "ignored",
				className: "x",
			}),
		).toBe("Free");
	});

	test("returns label for non-free", () => {
		expect(
			helpers.getPricingLabel({ tier: "low", label: "$0.1", className: "x" }),
		).toBe("$0.1");
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
		expect(helpers.getExpandAriaLabel(true, 3)).toBe(
			"Hide 3 hosting providers",
		);
	});

	test("collapsed uses 'Show'", () => {
		expect(helpers.getExpandAriaLabel(false, 1)).toBe(
			"Show 1 hosting providers",
		);
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
		expect(helpers.getSelectionProviderTooltip("Together")).toBe(
			"Provider: Together",
		);
	});

	test("without name returns generic", () => {
		expect(helpers.getSelectionProviderTooltip(undefined)).toBe(
			"Provider selected",
		);
	});
});

describe("buildVirtualItems / appendModelEntries", () => {
	test("prefixes each maker group with a sticky header, then its model rows", () => {
		const m1 = makeModel({ id: "openai/m1" });
		const m2 = makeModel({ id: "openai/m2" });
		const items = helpers.buildVirtualItems([["openai", [m1, m2]]], new Set());
		expect(items).toHaveLength(3);
		expect(items[0]?.type).toBe("header");
		expect(items.slice(1).every((i) => i.type === "model")).toBe(true);
	});

	test("omits maker headers when addSectionHeaders is false (sorted view)", () => {
		const m1 = makeModel({ id: "openai/m1" });
		const m2 = makeModel({ id: "openai/m2" });
		const items = helpers.buildVirtualItems(
			[["openai", [m1, m2]]],
			new Set(),
			undefined,
			false,
		);
		expect(items).toHaveLength(2);
		expect(items.every((i) => i.type === "model")).toBe(true);
	});

	test("models with multiple providers add a providers row", () => {
		const m = makeModel({
			id: "openai/multi",
			endpoints: [
				makeEndpoint({ provider_name: "A" }),
				makeEndpoint({ provider_name: "B" }),
			],
		});
		const items = helpers.buildVirtualItems(
			[["openai", [m]]],
			new Set(["openai/multi"]),
		);
		expect(items).toHaveLength(3);
		expect(items[0]?.type).toBe("header");
		expect(items[1]?.type).toBe("model");
		expect(items[2]?.type).toBe("providers");
		const head = items[1];
		if (head?.type === "model") {
			expect(head.isExpanded).toBe(true);
			expect(head.hasProviders).toBe(true);
		}
	});

	test("appendModelEntries returns next index correctly", () => {
		const items: VirtualizedItem[] = [];
		const m = makeModel({
			id: "openai/multi2",
			endpoints: [
				makeEndpoint({ provider_name: "A" }),
				makeEndpoint({ provider_name: "B" }),
			],
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
	const multiProviderModel = makeModel({
		id: "openai/multi",
		maker: "openai",
		endpoints: [
			makeEndpoint({ provider_name: "DeepInfra", tag: "deepinfra" }),
			makeEndpoint({ provider_name: "Together", tag: "together" }),
		],
	});
	const items: VirtualizedItem[] = [
		{
			type: "model",
			model: makeModel({ id: "a/1", maker: "a" }),
			groupIndex: 0,
			index: 0,
			isExpanded: false,
			hasProviders: false,
			sectionId: "a",
		},
		{
			type: "model",
			model: makeModel({ id: "b/2", maker: "b" }),
			groupIndex: 1,
			index: 1,
			isExpanded: false,
			hasProviders: false,
			sectionId: "b",
		},
		{
			type: "providers",
			model: multiProviderModel,
			endpoints: multiProviderModel.endpoints ?? [],
			index: 2,
			isOpen: true,
			sectionId: "openai",
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
		expect(
			helpers.findScrollTargetIndex(items, {
				maker: "a",
				modelId: "b/2",
				nonce: 1,
			}),
		).toBe(1);
	});

	test("findScrollTargetIndex prefers provider row when provider slug is selected", () => {
		expect(
			helpers.findScrollTargetIndex(items, {
				maker: "openai",
				modelId: "openai/multi",
				nonce: 1,
				providerSlug: "deepinfra",
			}),
		).toBe(2);
	});

	test("findScrollTargetIndex falls back to maker", () => {
		expect(helpers.findScrollTargetIndex(items, { maker: "a", nonce: 1 })).toBe(
			0,
		);
	});

	test("findScrollTargetIndex returns -1 when nothing matches", () => {
		expect(
			helpers.findScrollTargetIndex(items, { maker: "nope", nonce: 1 }),
		).toBe(-1);
	});
});

describe("getScrollTargetOffset", () => {
	test("keeps section headers flush to the top", () => {
		const items = helpers.buildVirtualItems(
			[["openai", [makeModel({ id: "openai/a" })]]],
			new Set(),
		);
		expect(helpers.getScrollTargetOffset(items, 0)).toBe(0);
	});

	test("offsets model and provider rows below the sticky header", () => {
		const model = makeModel({
			id: "openai/multi-offset",
			endpoints: [
				makeEndpoint({ provider_name: "A", tag: "a" }),
				makeEndpoint({ provider_name: "B", tag: "b" }),
			],
		});
		const items = helpers.buildVirtualItems(
			[["openai", [model]]],
			new Set([model.id]),
		);
		expect(helpers.getScrollTargetOffset(items, 1)).toBe(
			-helpers.GROUP_HEADER_SCROLL_OFFSET_PX,
		);
		expect(helpers.getScrollTargetOffset(items, 2)).toBe(
			-helpers.GROUP_HEADER_SCROLL_OFFSET_PX,
		);
	});
});

describe("isFeaturedEndpointEligible / getFeaturedEndpoint", () => {
	test("ineligible when hasProviders", () => {
		expect(
			helpers.isFeaturedEndpointEligible([makeEndpoint()], true, true),
		).toBe(false);
	});

	test("ineligible when no endpoints", () => {
		expect(helpers.isFeaturedEndpointEligible([], false, false)).toBe(false);
	});

	test("eligible when single endpoint without providers", () => {
		expect(
			helpers.isFeaturedEndpointEligible([makeEndpoint()], true, false),
		).toBe(true);
	});

	test("getFeaturedEndpoint returns first endpoint when eligible", () => {
		const ep = makeEndpoint({ provider_name: "Solo" });
		expect(helpers.getFeaturedEndpoint([ep], true, false)).toBe(ep);
	});

	test("getFeaturedEndpoint returns null when ineligible", () => {
		expect(
			helpers.getFeaturedEndpoint([makeEndpoint()], true, true),
		).toBeNull();
	});

	test("getFeaturedEndpoint returns null when array empty", () => {
		expect(helpers.getFeaturedEndpoint([], false, false)).toBeNull();
	});
});

describe("shouldRenderInlineMeta / shouldShowStatsRow", () => {
	test("inline meta true when context length present", () => {
		expect(helpers.shouldRenderInlineMeta(1024, null, null, undefined)).toBe(
			true,
		);
	});

	test("inline meta true when pricing present", () => {
		expect(
			helpers.shouldRenderInlineMeta(
				null,
				{ tier: "free", label: "Free", className: "x" },
				null,
				undefined,
			),
		).toBe(true);
	});

	test("inline meta true when featured endpoint present", () => {
		expect(
			helpers.shouldRenderInlineMeta(null, null, makeEndpoint(), undefined),
		).toBe(true);
	});

	test("inline meta true when modalities non-empty", () => {
		expect(
			helpers.shouldRenderInlineMeta(null, null, null, ["text", "image"]),
		).toBe(true);
	});

	test("inline meta false when nothing present", () => {
		expect(helpers.shouldRenderInlineMeta(null, null, null, undefined)).toBe(
			false,
		);
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
		expect(
			helpers.isProviderSelected(m, "deepinfra", "openai/x", "deepinfra"),
		).toBe(true);
	});

	test("false when slug differs", () => {
		expect(
			helpers.isProviderSelected(m, "deepinfra", "openai/x", "together"),
		).toBe(false);
	});

	test("false when id differs", () => {
		expect(
			helpers.isProviderSelected(m, "deepinfra", "other/x", "deepinfra"),
		).toBe(false);
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
		expect(typeof helpers.resolveMakerIconSrc("zzz-no-such-maker")).toBe(
			"string",
		);
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

describe("useProvidersOpenedFlag", () => {
	test("starts false when isOpen is false", () => {
		const { result } = renderHook(() => helpers.useProvidersOpenedFlag(false));
		expect(result.current).toBe(false);
	});

	test("starts true when isOpen is true", () => {
		const { result } = renderHook(() => helpers.useProvidersOpenedFlag(true));
		expect(result.current).toBe(true);
	});

	test("latches true once opened (stays true when closed again)", () => {
		let isOpen = true;
		const { result, rerender } = renderHook(() =>
			helpers.useProvidersOpenedFlag(isOpen),
		);
		expect(result.current).toBe(true);
		isOpen = false;
		rerender();
		// Once it was true, it stays true (the latch pattern)
		expect(result.current).toBe(true);
	});

	test("transitions from false to true when isOpen becomes true", () => {
		let isOpen = false;
		const { result, rerender } = renderHook(() =>
			helpers.useProvidersOpenedFlag(isOpen),
		);
		expect(result.current).toBe(false);
		isOpen = true;
		rerender();
		expect(result.current).toBe(true);
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

describe("resolveActiveMaker", () => {
	const items: VirtualizedItem[] = [
		{
			type: "model",
			model: makeModel({ maker: "openai" }),
			groupIndex: 0,
			index: 0,
			isExpanded: false,
			hasProviders: false,
			sectionId: "openai",
		},
		{
			type: "model",
			model: makeModel({ maker: "anthropic" }),
			groupIndex: 1,
			index: 1,
			isExpanded: false,
			hasProviders: false,
			sectionId: "anthropic",
		},
	];

	test("returns maker at given index", () => {
		expect(helpers.resolveActiveMaker(items, 0)).toBe("openai");
		expect(helpers.resolveActiveMaker(items, 1)).toBe("anthropic");
	});

	test("returns null when index out of bounds", () => {
		expect(helpers.resolveActiveMaker(items, 99)).toBeNull();
	});

	test("returns null when items is empty", () => {
		expect(helpers.resolveActiveMaker([], 0)).toBeNull();
	});
});

describe("shouldNotifyMaker", () => {
	test("returns true when makers differ", () => {
		expect(helpers.shouldNotifyMaker("openai", "anthropic")).toBe(true);
	});

	test("returns false when makers are the same", () => {
		expect(helpers.shouldNotifyMaker("openai", "openai")).toBe(false);
	});

	test("returns true when transitioning from null to string", () => {
		expect(helpers.shouldNotifyMaker("openai", null)).toBe(true);
	});

	test("returns false when both null", () => {
		expect(helpers.shouldNotifyMaker(null, null)).toBe(false);
	});
});

describe("isNewScrollNonce", () => {
	test("returns true when lastNonce is null", () => {
		expect(helpers.isNewScrollNonce(null, 1)).toBe(true);
	});

	test("returns true when nonce differs from lastNonce", () => {
		expect(helpers.isNewScrollNonce(1, 2)).toBe(true);
	});

	test("returns false when nonce equals lastNonce", () => {
		expect(helpers.isNewScrollNonce(5, 5)).toBe(false);
	});
});

describe("applyVirtualScrollMakerUpdate", () => {
	const makeVirtualItem = (maker: string, idx: number): VirtualizedItem => ({
		type: "model",
		model: makeModel({ maker, id: `${maker}/m${idx}` }),
		groupIndex: idx,
		index: idx,
		isExpanded: false,
		hasProviders: false,
		sectionId: maker,
	});

	const makeHandle = (offsets: number[], sizes: number[]) => ({
		getItemOffset: (i: number) => offsets[i] ?? 0,
		getItemSize: (i: number) => sizes[i] ?? 50,
	});

	test("returns lastNotifiedMaker unchanged when handle is null", () => {
		const items = [makeVirtualItem("openai", 0)];
		const result = helpers.applyVirtualScrollMakerUpdate(
			null,
			items,
			0,
			"openai",
			undefined,
		);
		expect(result).toBe("openai");
	});

	test("returns lastNotifiedMaker unchanged when virtualItems is empty", () => {
		const handle = makeHandle([], []);
		const result = helpers.applyVirtualScrollMakerUpdate(
			handle,
			[],
			0,
			null,
			undefined,
		);
		expect(result).toBeNull();
	});

	test("calls onActiveMakerChange and returns new maker when it changes", () => {
		const items = [
			makeVirtualItem("anthropic", 0),
			makeVirtualItem("openai", 1),
		];
		const handle = makeHandle([0, 100], [100, 100]);
		let notified: string | null = "not-called";
		const result = helpers.applyVirtualScrollMakerUpdate(
			handle,
			items,
			0,
			"openai",
			(m) => {
				notified = m;
			},
		);
		expect(result).toBe("anthropic");
		expect(notified).toBe("anthropic");
	});

	test("does not call onActiveMakerChange when maker did not change", () => {
		const items = [makeVirtualItem("openai", 0)];
		const handle = makeHandle([0], [100]);
		let called = false;
		const result = helpers.applyVirtualScrollMakerUpdate(
			handle,
			items,
			0,
			"openai",
			() => {
				called = true;
			},
		);
		expect(result).toBe("openai");
		expect(called).toBe(false);
	});
});

describe("applyScrollToMakerRequest", () => {
	const makeVirtualItem = (
		maker: string,
		id: string,
		idx: number,
	): VirtualizedItem => ({
		type: "model",
		model: makeModel({ maker, id }),
		groupIndex: idx,
		index: idx,
		isExpanded: false,
		hasProviders: false,
	});

	test("returns lastNonce unchanged when request is null", () => {
		expect(helpers.applyScrollToMakerRequest(null, 5, [], undefined)).toBe(5);
	});

	test("returns lastNonce unchanged when nonce is already processed", () => {
		const request = { maker: "openai", nonce: 3 };
		expect(helpers.applyScrollToMakerRequest(request, 3, [], undefined)).toBe(
			3,
		);
	});

	test("calls scrollToIndex with correct index and offset, then returns new nonce", () => {
		const items = [makeVirtualItem("openai", "openai/gpt-4o", 0)];
		const request = { maker: "openai", modelId: "openai/gpt-4o", nonce: 2 };
		const scrolled: Array<{ index: number; offset: number | undefined }> = [];
		const result = helpers.applyScrollToMakerRequest(
			request,
			null,
			items,
			(index, opts) => {
				scrolled.push({ index, offset: opts?.offset });
			},
		);
		expect(result).toBe(2);
		expect(scrolled[0]).toEqual({
			index: 0,
			offset: -helpers.GROUP_HEADER_SCROLL_OFFSET_PX,
		});
	});

	test("scrolls provider selections to the providers row", () => {
		const model = makeModel({
			id: "openai/multi-scroll",
			endpoints: [
				makeEndpoint({ provider_name: "A", tag: "a" }),
				makeEndpoint({ provider_name: "B", tag: "b" }),
			],
		});
		const items = helpers.buildVirtualItems(
			[["openai", [model]]],
			new Set([model.id]),
		);
		const request = {
			maker: "openai",
			modelId: model.id,
			nonce: 4,
			providerSlug: "b",
		};
		const scrolled: Array<{ index: number; offset: number | undefined }> = [];
		const result = helpers.applyScrollToMakerRequest(
			request,
			null,
			items,
			(index, opts) => {
				scrolled.push({ index, offset: opts?.offset });
			},
		);

		expect(result).toBe(4);
		expect(scrolled[0]).toEqual({
			index: 2,
			offset: -helpers.GROUP_HEADER_SCROLL_OFFSET_PX,
		});
	});

	test("does not consume a request before scrollToIndex is ready", () => {
		const items = [makeVirtualItem("openai", "openai/gpt-4o", 0)];
		const request = { maker: "openai", modelId: "openai/gpt-4o", nonce: 2 };
		const result = helpers.applyScrollToMakerRequest(
			request,
			null,
			items,
			undefined,
		);
		expect(result).toBeNull();
	});

	test("does not scroll when targetIndex < 0", () => {
		const items = [makeVirtualItem("anthropic", "anthropic/c", 0)];
		const request = { maker: "nobody", nonce: 1 };
		let scrollCalled = false;
		const result = helpers.applyScrollToMakerRequest(
			request,
			null,
			items,
			() => {
				scrollCalled = true;
			},
		);
		expect(result).toBeNull();
		expect(scrollCalled).toBe(false);
	});
});

/* ── Component render tests ─────────────────────────────────────────── */

describe("VirtualizedRow", () => {
	const { VirtualizedRow } = helpers;

	test("renders model row when item type is model", () => {
		const m = makeModel({ id: "openai/vr1" });
		const item: VirtualizedItem = {
			type: "model",
			model: m,
			groupIndex: 0,
			index: 0,
			isExpanded: false,
			hasProviders: false,
		};
		const { container } = render(
			<TooltipProvider.Provider>
				<Combobox.Root items={[m.id]}>
					<VirtualizedRow
						item={item}
						onSelectModel={() => undefined}
						onToggleModelExpanded={() => undefined}
						parsedModelId={undefined}
						parsedProviderSlug={undefined}
					/>
				</Combobox.Root>
			</TooltipProvider.Provider>,
		);
		expect(container.firstChild).not.toBeNull();
	});

	test("renders providers row when item type is providers", () => {
		const m = makeModel({ id: "openai/vr2" });
		const item: VirtualizedItem = {
			type: "providers",
			model: m,
			endpoints: [makeEndpoint({ provider_name: "A" })],
			isOpen: false,
			index: 1,
		};
		const { container } = render(
			<TooltipProvider.Provider>
				<Combobox.Root items={[m.id]}>
					<VirtualizedRow
						item={item}
						onSelectModel={() => undefined}
						onToggleModelExpanded={() => undefined}
						parsedModelId={undefined}
						parsedProviderSlug={undefined}
					/>
				</Combobox.Root>
			</TooltipProvider.Provider>,
		);
		expect(container.firstChild).not.toBeNull();
	});

	test("provider row selection emits provider slug instead of display name", () => {
		const m = makeModel({ id: "openai/vr3" });
		const item: VirtualizedItem = {
			type: "providers",
			model: m,
			endpoints: [
				makeEndpoint({
					provider_name: "Together AI",
					tag: "together",
				}),
			],
			isOpen: true,
			index: 1,
		};
		type SelectedModel = {
			modelId: string | undefined;
			providerSlug?: string;
		};
		let selected: SelectedModel | null = null;
		render(
			<TooltipProvider.Provider>
				<Combobox.Root items={[m.id]}>
					<VirtualizedRow
						item={item}
						onSelectModel={(modelId, providerSlug) => {
							selected =
								providerSlug === undefined
									? { modelId }
									: { modelId, providerSlug };
						}}
						onToggleModelExpanded={() => undefined}
						parsedModelId={undefined}
						parsedProviderSlug={undefined}
					/>
				</Combobox.Root>
			</TooltipProvider.Provider>,
		);

		fireEvent.click(screen.getByText("Together AI"));

		expect(selected as unknown as SelectedModel).toEqual({
			modelId: "openai/vr3",
			providerSlug: "together",
		});
	});
});
