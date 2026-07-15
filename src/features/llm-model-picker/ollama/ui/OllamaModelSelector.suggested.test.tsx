import { beforeEach, describe, expect, mock, test } from "bun:test";
import {
	fireEvent,
	render,
	screen,
} from "@/shared/ui/model-picker/test/render-with-intl";
import type { RecommendedOllamaModel } from "@/shared/api/models";
import { OllamaModelSelector } from "./OllamaModelSelector";
import type { OllamaSuggestionsProp } from "./ollama-selector-types";

const GB = 1024 ** 3;

function recommended(
	overrides: Partial<RecommendedOllamaModel> & { name: string },
): RecommendedOllamaModel {
	return {
		displayName: overrides.name,
		paramSize: "1B",
		sizeBytes: GB,
		description: "",
		family: "llama",
		...overrides,
	};
}

/** Verdict stub: fits anything under `limit`; per-name score overrides drive
 *  the proxy-ranking assertions. */
function makeSuggestions({
	limit = 10 * GB,
	scores = {},
}: {
	limit?: number;
	scores?: Record<string, number>;
} = {}): OllamaSuggestionsProp {
	return {
		fits: (sizeBytes) => sizeBytes <= 0 || sizeBytes < limit,
		score: (input) => scores[input.name] ?? 0.5,
	};
}

const REC_MODELS = [
	recommended({
		name: "llama3.2:1b",
		displayName: "Small Llama",
		sizeBytes: 1 * GB,
	}),
	recommended({
		name: "llama3.1:70b",
		displayName: "Huge Llama",
		paramSize: "70B",
		sizeBytes: 40 * GB,
	}),
];

function renderSelector({
	suggestions,
	uiStorageKey,
}: {
	suggestions?: OllamaSuggestionsProp | undefined;
	uiStorageKey?: string | undefined;
}) {
	return render(
		<OllamaModelSelector
			inline
			models={[]}
			onChange={mock(() => undefined)}
			recommendedModels={REC_MODELS}
			suggestions={suggestions}
			uiStorageKey={uiStorageKey}
			value=""
		/>,
	);
}

beforeEach(() => {
	window.localStorage.clear();
});

describe("OllamaModelSelector suggested filter", () => {
	test("hides recommended models with no fitting quant (default ON) and shows the chip", () => {
		renderSelector({ suggestions: makeSuggestions() });
		expect(screen.getByText("Small Llama")).toBeDefined();
		expect(screen.queryByText("Huge Llama")).toBeNull();
		expect(
			document.querySelector('[data-slot="suggested-filter-chip"]'),
		).not.toBeNull();
	});

	test("keeps GPT-OSS and its disabled MXFP4 badge visible when it will not fit", () => {
		render(
			<OllamaModelSelector
				inline
				models={[]}
				onChange={mock(() => undefined)}
				recommendedModels={[
					recommended({
						name: "gpt-oss:20b",
						displayName: "GPT-OSS 20B",
						family: "gpt",
						paramSize: "20B",
						sizeBytes: 14 * GB,
					}),
				]}
				suggestions={makeSuggestions({ limit: 10 * GB })}
				value=""
			/>,
		);

		expect(screen.getByText("GPT-OSS 20B")).toBeDefined();
		const badge = screen.getByLabelText("Select MXFP4 precision");
		expect(badge.getAttribute("aria-disabled")).toBe("true");
	});

	test("without a host verdict the flag is inert and the chip hidden", () => {
		renderSelector({});
		expect(screen.getByText("Huge Llama")).toBeDefined();
		expect(
			document.querySelector('[data-slot="suggested-filter-chip"]'),
		).toBeNull();
	});

	test("a persisted blob missing suggestedOnly defaults to ON (migration)", () => {
		const uiStorageKey = "winstt:test:ollama-suggested-migration";
		window.localStorage.setItem(
			uiStorageKey,
			JSON.stringify({
				activeRailId: "__all_authors__",
				filters: { installedOnly: false, fitsHardwareOnly: false },
				query: "",
				sortKey: null,
			}),
		);
		renderSelector({ suggestions: makeSuggestions(), uiStorageKey });
		expect(screen.queryByText("Huge Llama")).toBeNull();
	});

	test("a persisted explicit OFF is respected", () => {
		const uiStorageKey = "winstt:test:ollama-suggested-off";
		window.localStorage.setItem(
			uiStorageKey,
			JSON.stringify({
				activeRailId: "__all_authors__",
				filters: {
					installedOnly: false,
					fitsHardwareOnly: false,
					suggestedOnly: false,
				},
				query: "",
				sortKey: null,
			}),
		);
		renderSelector({ suggestions: makeSuggestions(), uiStorageKey });
		expect(screen.getByText("Huge Llama")).toBeDefined();
	});

	test("orders recommended cards by the proxy score while ON with no explicit sort", () => {
		renderSelector({
			suggestions: makeSuggestions({
				limit: 100 * GB,
				scores: { "llama3.1:70b": 0.9, "llama3.2:1b": 0.2 },
			}),
		});
		const huge = screen.getByText("Huge Llama");
		const small = screen.getByText("Small Llama");
		const order = huge.compareDocumentPosition(small);
		// Higher-scored card precedes the lower-scored one in the DOM.
		expect(order & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
	});

	test("empty state offers the hidden-count escape hatch that turns the flag off", () => {
		renderSelector({ suggestions: makeSuggestions({ limit: 1 }) });
		const hint = screen.getByText(
			"2 models hidden by Suggested — tap to show all",
		);
		fireEvent.click(hint);
		expect(screen.getByText("Small Llama")).toBeDefined();
		expect(screen.getByText("Huge Llama")).toBeDefined();
	});
});
