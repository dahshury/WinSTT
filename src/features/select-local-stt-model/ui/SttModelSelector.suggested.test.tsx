import { beforeEach, describe, expect, mock, test } from "bun:test";
import {
	fireEvent,
	render,
	screen,
} from "@/shared/ui/model-picker/test/render-with-intl";
import type { ModelInfo } from "@/entities/model-catalog";
import type { ModelSuggestion } from "@/entities/model-suggestion";
import { SttModelSelector } from "./SttModelSelector";

function model(
	overrides: Partial<ModelInfo> & Pick<ModelInfo, "id">,
): ModelInfo {
	const { id, ...modelOverrides } = overrides;
	return {
		id,
		displayName: modelOverrides.displayName ?? id,
		family: "custom",
		languages: ["en"],
		supportsLanguageDetection: false,
		sizeLabel: "100M",
		previewCapable: true,
		nativeStreaming: false,
		finalReuseSafe: false,
		onnxModelName: null,
		description: "",
		availableQuantizations: [""],
		sizeBytesByQuantization: {},
		available: true,
		errorMessage: "",
		localPath: null,
		speedScore: 0.5,
		accuracyScore: 0.5,
		...modelOverrides,
	} as ModelInfo;
}

function suggestion(overrides: Partial<ModelSuggestion> = {}): ModelSuggestion {
	return {
		visible: true,
		fittingQuants: new Set([""]),
		score: 0.5,
		bestQuant: "",
		...overrides,
	};
}

/** Suggestion lookup: everything visible except the listed ids; per-id score
 *  overrides drive the bang-for-buck ordering assertions. */
function makeGetSuggestion({
	hidden = [],
	scores = {},
}: {
	hidden?: readonly string[];
	scores?: Record<string, number>;
} = {}) {
	return (modelId: string): ModelSuggestion | null =>
		suggestion({
			visible: !hidden.includes(modelId),
			score: scores[modelId] ?? 0.5,
		});
}

beforeEach(() => {
	// Each picker kind persists its filter state — clear so the default-ON
	// Suggested flag (not a leftover from a previous test) is what renders.
	window.localStorage.clear();
});

describe("SttModelSelector suggested filter", () => {
	test("hides models whose suggestion says visible=false (default ON)", () => {
		render(
			<SttModelSelector
				currentQuantization=""
				getSuggestion={makeGetSuggestion({ hidden: ["too-big"] })}
				inline
				models={[
					model({ id: "fits", displayName: "Fits Fine" }),
					model({ id: "too-big", displayName: "Too Big" }),
				]}
				onChange={mock(() => undefined)}
				statesById={{}}
				systemInfo={null}
				value="fits"
			/>,
		);
		expect(screen.getByText("Fits Fine")).toBeDefined();
		expect(screen.queryByText("Too Big")).toBeNull();
	});

	test("without a host verdict the flag is inert and the chip hidden", () => {
		render(
			<SttModelSelector
				currentQuantization=""
				inline
				models={[
					model({ id: "fits", displayName: "Fits Fine" }),
					model({ id: "too-big", displayName: "Too Big" }),
				]}
				onChange={mock(() => undefined)}
				statesById={{}}
				systemInfo={null}
				value="fits"
			/>,
		);
		expect(screen.getByText("Too Big")).toBeDefined();
		expect(screen.queryByLabelText("Suggested")).toBeNull();
	});

	test("flattens into the bang-for-buck column with the Suggested header when no sort is active", () => {
		render(
			<SttModelSelector
				currentQuantization=""
				getSuggestion={makeGetSuggestion({
					scores: { slow: 0.2, best: 0.9, mid: 0.5 },
				})}
				inline
				models={[
					model({ id: "slow", displayName: "Slow Model" }),
					model({ id: "best", displayName: "Best Model" }),
					model({ id: "mid", displayName: "Mid Model" }),
				]}
				onChange={mock(() => undefined)}
				statesById={{}}
				systemInfo={null}
				value="best"
			/>,
		);
		// Header: "Suggested · best for your machine" (i18n-split across spans;
		// the always-visible chip also carries the word, hence the header is
		// pinned down via its unique subtitle).
		expect(screen.getByText(/best for your machine/)).toBeDefined();
		// Best-first ordering (score desc), not maker grouping.
		const names = screen.getAllByText(/Model$/).map((node) => node.textContent);
		expect(names).toEqual(["Best Model", "Mid Model", "Slow Model"]);
	});

	test("an explicit sort key overrides the Suggested ordering but not the hiding", () => {
		render(
			<SttModelSelector
				currentQuantization=""
				getSuggestion={makeGetSuggestion({
					hidden: ["too-big"],
					scores: { a: 0.9, z: 0.1 },
				})}
				inline
				models={[
					model({ id: "z", displayName: "Alpha", speedScore: 0.9 }),
					model({ id: "a", displayName: "Zulu", speedScore: 0.2 }),
					model({ id: "too-big", displayName: "Too Big", speedScore: 0.99 }),
				]}
				onChange={mock(() => undefined)}
				statesById={{}}
				systemInfo={null}
				value="a"
			/>,
		);
		// Activate the "Name" sort via the menu.
		fireEvent.click(screen.getByRole("button", { name: /Sort & filter/ }));
		fireEvent.click(screen.getByRole("button", { name: /^Sort by/ }));
		fireEvent.click(screen.getByRole("button", { name: "Name" }));
		// Header flips to the sorted label, order is A→Z, hidden stays hidden.
		expect(screen.getByText("Sorted")).toBeDefined();
		expect(screen.queryByText(/best for your machine/)).toBeNull();
		expect(screen.queryByText("Too Big")).toBeNull();
		const names = screen
			.getAllByText(/^(Alpha|Zulu)$/)
			.map((node) => node.textContent);
		expect(names).toEqual(["Alpha", "Zulu"]);
	});

	test("the chip disables the filter with one tap and shares menu state", () => {
		render(
			<SttModelSelector
				currentQuantization=""
				getSuggestion={makeGetSuggestion({ hidden: ["too-big"] })}
				inline
				models={[
					model({ id: "fits", displayName: "Fits Fine" }),
					model({ id: "too-big", displayName: "Too Big" }),
				]}
				onChange={mock(() => undefined)}
				statesById={{}}
				systemInfo={null}
				value="fits"
			/>,
		);
		const chip = screen.getByLabelText("Suggested");
		expect(chip.getAttribute("aria-pressed")).toBe("true");
		fireEvent.click(chip);
		expect(chip.getAttribute("aria-pressed")).toBe("false");
		expect(screen.getByText("Too Big")).toBeDefined();
	});

	test("empty state offers the 'N models hidden by Suggested' tap-through", () => {
		render(
			<SttModelSelector
				currentQuantization=""
				getSuggestion={makeGetSuggestion({ hidden: ["one", "two"] })}
				inline
				models={[
					model({ id: "one", displayName: "One" }),
					model({ id: "two", displayName: "Two" }),
				]}
				onChange={mock(() => undefined)}
				statesById={{}}
				systemInfo={null}
				value="one"
			/>,
		);
		const hint = screen.getByText(
			"2 models hidden by Suggested — tap to show all",
		);
		fireEvent.click(hint);
		// Tap disables the flag → both models surface again.
		expect(screen.getByText("One")).toBeDefined();
		expect(screen.getByText("Two")).toBeDefined();
	});

	test("favorites are hidden too while unfit (filters apply before grouping)", () => {
		// Star "too-big" via the favorites localStorage key the picker reads.
		window.localStorage.setItem(
			"winstt:stt-favorite-models",
			JSON.stringify(["too-big"]),
		);
		render(
			<SttModelSelector
				currentQuantization=""
				getSuggestion={makeGetSuggestion({ hidden: ["too-big"] })}
				inline
				models={[
					model({ id: "fits", displayName: "Fits Fine" }),
					model({ id: "too-big", displayName: "Too Big" }),
				]}
				onChange={mock(() => undefined)}
				statesById={{}}
				systemInfo={null}
				value="fits"
			/>,
		);
		expect(screen.queryByText("Too Big")).toBeNull();
	});

	test("realtime picker composes the suggested filter with its prefilter", () => {
		render(
			<SttModelSelector
				currentQuantization=""
				getSuggestion={makeGetSuggestion({ hidden: ["stream-unfit"] })}
				inline
				kind="realtime"
				models={[
					model({
						id: "stream-fit",
						displayName: "Stream Fit",
						nativeStreaming: true,
					}),
					model({
						id: "stream-unfit",
						displayName: "Stream Unfit",
						nativeStreaming: true,
					}),
					model({
						id: "batch-fit",
						displayName: "Batch Fit",
						nativeStreaming: false,
					}),
				]}
				onChange={mock(() => undefined)}
				prefilter={(m) => m.nativeStreaming}
				statesById={{}}
				systemInfo={null}
				value="stream-fit"
			/>,
		);
		expect(screen.getByText("Stream Fit")).toBeDefined();
		// Hidden by the Suggested verdict…
		expect(screen.queryByText("Stream Unfit")).toBeNull();
		// …and by the realtime prefilter + locked realtimeOnly flag.
		expect(screen.queryByText("Batch Fit")).toBeNull();
	});
});
