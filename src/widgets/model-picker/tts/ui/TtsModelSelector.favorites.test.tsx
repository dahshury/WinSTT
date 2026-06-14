import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen } from "../../test/render-with-intl";
import type { TtsModelInfo } from "@/entities/tts-catalog";
import { TtsModelSelector } from "./TtsModelSelector";

function model(overrides: Partial<TtsModelInfo> = {}): TtsModelInfo {
	return {
		id: "kokoro-82m",
		displayName: "Kokoro 82M",
		engine: "kokoro",
		maker: "hexgrad",
		languages: ["en-us"],
		numVoices: 54,
		cloning: "none",
		sampleRate: 24_000,
		paramCountM: 82,
		availableQuantizations: ["fp16"],
		sizeBytesByQuantization: { fp16: 169_869_312 },
		sizeLabel: "82M",
		qualityScore: 0.9,
		speedScore: 0.85,
		description: "",
		available: true,
		...overrides,
	};
}

/** Inline (always-open panel) mode so the list — and therefore the star toggles
 *  + the synthetic Favorites group — render without driving the popup open. */
function renderInline(models: TtsModelInfo[]) {
	const onChange = mock(() => undefined);
	const utils = render(
		<TtsModelSelector
			currentQuantization=""
			inline
			models={models}
			onChange={onChange}
			statesById={{}}
			value="kokoro-82m"
		/>,
	);
	return { ...utils, onChange };
}

describe("TtsModelSelector favorites (DRY with STT)", () => {
	beforeEach(() => {
		window.localStorage.clear();
	});
	afterEach(() => {
		window.localStorage.clear();
	});

	test("no Favorites group renders until a model is starred", () => {
		renderInline([model()]);
		expect(screen.queryByText("Favorites")).toBeNull();
		expect(screen.getAllByText("Kokoro 82M")).toHaveLength(1);
	});

	test("starring a model surfaces it (repeated) in a Favorites group at the top", () => {
		renderInline([model()]);
		fireEvent.click(screen.getByLabelText("Add Kokoro 82M to favorites"));

		expect(screen.getByText("Favorites")).toBeDefined();
		// Now shown twice: once in Favorites, once in its engine group.
		expect(screen.getAllByText("Kokoro 82M")).toHaveLength(2);
		// Both cards expose the remove affordance (shared favorite state).
		expect(
			screen.getAllByLabelText("Remove Kokoro 82M from favorites"),
		).toHaveLength(2);
	});

	test("unstarring from either card removes the Favorites group", () => {
		renderInline([model()]);
		fireEvent.click(screen.getByLabelText("Add Kokoro 82M to favorites"));
		expect(screen.getByText("Favorites")).toBeDefined();

		const removeButtons = screen.getAllByLabelText(
			"Remove Kokoro 82M from favorites",
		);
		fireEvent.click(removeButtons[0] as HTMLElement);

		expect(screen.queryByText("Favorites")).toBeNull();
		expect(screen.getAllByText("Kokoro 82M")).toHaveLength(1);
	});

	test("favorites persist across remounts via localStorage", () => {
		const first = renderInline([model()]);
		fireEvent.click(screen.getByLabelText("Add Kokoro 82M to favorites"));
		first.unmount();

		renderInline([model()]);
		expect(screen.getByText("Favorites")).toBeDefined();
	});
});
