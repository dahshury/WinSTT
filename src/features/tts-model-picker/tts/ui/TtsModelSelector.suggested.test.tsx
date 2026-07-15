import { beforeEach, describe, expect, mock, test } from "bun:test";
import {
	fireEvent,
	render,
	screen,
} from "@/shared/ui/model-picker/test/render-with-intl";
import type { ModelSuggestion } from "@/entities/model-suggestion";
import type { TtsModelInfo } from "@/entities/tts-catalog";
import { TtsModelSelector } from "./TtsModelSelector";

function model(
	overrides: Partial<TtsModelInfo> & Pick<TtsModelInfo, "id">,
): TtsModelInfo {
	const { id, ...rest } = overrides;
	return {
		id,
		displayName: rest.displayName ?? id,
		engine: "kokoro",
		maker: "hexgrad",
		languages: ["en-us"],
		numVoices: 1,
		cloning: "none",
		voiceDesign: false,
		sampleRate: 24_000,
		paramCountM: 82,
		availableQuantizations: ["fp16"],
		sizeBytesByQuantization: { fp16: 169_869_312 },
		sizeLabel: "82M",
		qualityScore: 0.5,
		speedScore: 0.5,
		description: "",
		available: true,
		...rest,
	};
}

function suggestion(overrides: Partial<ModelSuggestion> = {}): ModelSuggestion {
	return {
		visible: true,
		fittingQuants: new Set(["fp16"]),
		score: 0.5,
		bestQuant: "fp16",
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

const TTS_UI_KEY = "winstt:model-picker:tts-ui";

beforeEach(() => {
	// The picker persists its filter state — clear so the default-ON Suggested
	// flag (not a leftover from a previous test) is what renders.
	window.localStorage.clear();
});

describe("TtsModelSelector suggested filter", () => {
	test("hides models whose suggestion says visible=false (default ON)", () => {
		render(
			<TtsModelSelector
				currentQuantization=""
				getSuggestion={makeGetSuggestion({ hidden: ["too-big"] })}
				inline
				models={[
					model({ id: "fits", displayName: "Fits Fine" }),
					model({ id: "too-big", displayName: "Too Big" }),
				]}
				onChange={mock(() => undefined)}
				statesById={{}}
				value="fits"
			/>,
		);
		expect(screen.getByText("Fits Fine")).toBeDefined();
		expect(screen.queryByText("Too Big")).toBeNull();
	});

	test("without a host verdict the flag is inert and the chip hidden", () => {
		render(
			<TtsModelSelector
				currentQuantization=""
				inline
				models={[
					model({ id: "fits", displayName: "Fits Fine" }),
					model({ id: "too-big", displayName: "Too Big" }),
				]}
				onChange={mock(() => undefined)}
				statesById={{}}
				value="fits"
			/>,
		);
		expect(screen.getByText("Too Big")).toBeDefined();
		expect(screen.queryByLabelText("Suggested")).toBeNull();
	});

	test("flattens into the bang-for-buck column with the Suggested header when no sort is active", () => {
		render(
			<TtsModelSelector
				currentQuantization=""
				getSuggestion={makeGetSuggestion({
					scores: { slow: 0.2, best: 0.9, mid: 0.5 },
				})}
				inline
				models={[
					model({ id: "slow", displayName: "Slow Voice", engine: "piper" }),
					model({ id: "best", displayName: "Best Voice", engine: "kokoro" }),
					model({ id: "mid", displayName: "Mid Voice", engine: "kitten" }),
				]}
				onChange={mock(() => undefined)}
				statesById={{}}
				value="best"
			/>,
		);
		// Header: "Suggested · best for your machine" (i18n-split across spans;
		// the always-visible chip also carries the word, hence the header is
		// pinned down via its unique subtitle).
		expect(screen.getByText(/best for your machine/)).toBeDefined();
		// Best-first ordering (score desc), not engine grouping.
		const names = screen.getAllByText(/Voice$/).map((node) => node.textContent);
		expect(names).toEqual(["Best Voice", "Mid Voice", "Slow Voice"]);
	});

	test("a language-mismatch de-rank sinks the model but keeps it visible", () => {
		// The adapter expresses the mismatch purely as a LOWER score — the
		// picker must render it last, never hide it.
		render(
			<TtsModelSelector
				currentQuantization=""
				getSuggestion={makeGetSuggestion({
					scores: { match: 0.8, mismatch: 0.4 },
				})}
				inline
				models={[
					model({ id: "mismatch", displayName: "Mismatch Voice" }),
					model({ id: "match", displayName: "Match Voice" }),
				]}
				onChange={mock(() => undefined)}
				statesById={{}}
				value="match"
			/>,
		);
		const names = screen.getAllByText(/Voice$/).map((node) => node.textContent);
		expect(names).toEqual(["Match Voice", "Mismatch Voice"]);
	});

	test("an explicit sort key overrides the Suggested ordering but not the hiding", () => {
		render(
			<TtsModelSelector
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
				value="a"
			/>,
		);
		// Activate the "Name" sort via the menu.
		fireEvent.click(screen.getByRole("button", { name: /Sort & filter/ }));
		fireEvent.click(screen.getByRole("button", { name: "Name" }));
		// Header flips to the sorted label, order is A→Z, hidden stays hidden.
		expect(screen.getByText("Name · A–Z")).toBeDefined();
		expect(screen.queryByText(/best for your machine/)).toBeNull();
		expect(screen.queryByText("Too Big")).toBeNull();
		const names = screen
			.getAllByText(/^(Alpha|Zulu)$/)
			.map((node) => node.textContent);
		expect(names).toEqual(["Alpha", "Zulu"]);
	});

	test("the chip disables the filter with one tap and shares menu state", () => {
		render(
			<TtsModelSelector
				currentQuantization=""
				getSuggestion={makeGetSuggestion({ hidden: ["too-big"] })}
				inline
				models={[
					model({ id: "fits", displayName: "Fits Fine" }),
					model({ id: "too-big", displayName: "Too Big" }),
				]}
				onChange={mock(() => undefined)}
				statesById={{}}
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
			<TtsModelSelector
				currentQuantization=""
				getSuggestion={makeGetSuggestion({ hidden: ["one", "two"] })}
				inline
				models={[
					model({ id: "one", displayName: "One" }),
					model({ id: "two", displayName: "Two" }),
				]}
				onChange={mock(() => undefined)}
				statesById={{}}
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

	test("a persisted pre-feature blob (no suggestedOnly) defaults the flag ON", () => {
		window.localStorage.setItem(
			TTS_UI_KEY,
			JSON.stringify({
				activeRailId: "__all_authors__",
				filters: {
					availableOnly: false,
					cachedOnly: false,
					cloningOnly: false,
					languages: [],
					multilingualOnly: false,
					quantizations: [],
					voiceDesignOnly: false,
				},
				sort: null,
			}),
		);
		render(
			<TtsModelSelector
				currentQuantization=""
				getSuggestion={makeGetSuggestion({ hidden: ["too-big"] })}
				inline
				models={[
					model({ id: "fits", displayName: "Fits Fine" }),
					model({ id: "too-big", displayName: "Too Big" }),
				]}
				onChange={mock(() => undefined)}
				statesById={{}}
				value="fits"
			/>,
		);
		expect(screen.queryByText("Too Big")).toBeNull();
	});

	test("a persisted explicit OFF is respected", () => {
		window.localStorage.setItem(
			TTS_UI_KEY,
			JSON.stringify({
				activeRailId: "__all_authors__",
				filters: {
					availableOnly: false,
					cachedOnly: false,
					cloningOnly: false,
					languages: [],
					multilingualOnly: false,
					quantizations: [],
					suggestedOnly: false,
					voiceDesignOnly: false,
				},
				sort: null,
			}),
		);
		render(
			<TtsModelSelector
				currentQuantization=""
				getSuggestion={makeGetSuggestion({ hidden: ["too-big"] })}
				inline
				models={[
					model({ id: "fits", displayName: "Fits Fine" }),
					model({ id: "too-big", displayName: "Too Big" }),
				]}
				onChange={mock(() => undefined)}
				statesById={{}}
				value="fits"
			/>,
		);
		expect(screen.getByText("Too Big")).toBeDefined();
		expect(
			screen.getByLabelText("Suggested").getAttribute("aria-pressed"),
		).toBe("false");
	});
});
