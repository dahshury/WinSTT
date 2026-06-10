import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen } from "../../test/render-with-intl";
import type { ModelInfo } from "@/entities/model-catalog";
import { SttModelSelector } from "./SttModelSelector";

function model(overrides: Partial<ModelInfo> = {}): ModelInfo {
	return {
		id: "tiny",
		displayName: "Whisper Tiny",
		family: "whisper",
		backend: "onnx_asr",
		languages: ["en"],
		supportsLanguageDetection: true,
		sizeLabel: "39M",
		previewCapable: true,
		nativeStreaming: false,
		finalReuseSafe: false,
		supportsRealtime: true,
		onnxModelName: null,
		description: "",
		availableQuantizations: [""],
		sizeBytesByQuantization: {},
		available: true,
		errorMessage: "",
		localPath: null,
		speedScore: 0.5,
		accuracyScore: 0.5,
		...overrides,
	} as ModelInfo;
}

/** Render the selector in inline (always-open panel) mode so the list — and
 *  therefore the star toggles + Favorites group — render without having to
 *  drive the popup open. */
function renderInline(models: ModelInfo[]) {
	const onChange = mock(() => undefined);
	const utils = render(
		<SttModelSelector
			currentQuantization=""
			inline
			models={models}
			onChange={onChange}
			statesById={{}}
			systemInfo={null}
			value="tiny"
		/>,
	);
	return { ...utils, onChange };
}

describe("SttModelSelector favorites", () => {
	beforeEach(() => {
		window.localStorage.clear();
	});
	afterEach(() => {
		window.localStorage.clear();
	});

	test("no Favorites group renders until a model is starred", () => {
		renderInline([model()]);
		expect(screen.queryByText("Favorites")).toBeNull();
	});

	test("starring a model surfaces it (repeated) in a Favorites group at the top", () => {
		renderInline([model()]);
		// The card strips the "Whisper" family label → the visible name is "Tiny",
		// shown once (just the maker group) before starring.
		expect(screen.getAllByText("Tiny")).toHaveLength(1);

		fireEvent.click(screen.getByLabelText("Add Whisper Tiny to favorites"));

		// The Favorites group header appears…
		expect(screen.getByText("Favorites")).toBeDefined();
		// …and the model now appears twice: once in Favorites, once in its maker group.
		expect(screen.getAllByText("Tiny")).toHaveLength(2);
		// Both cards now expose the "remove" affordance (shared favorite state).
		expect(
			screen.getAllByLabelText("Remove Whisper Tiny from favorites"),
		).toHaveLength(2);
	});

	test("unstarring from either card removes the Favorites group", () => {
		renderInline([model()]);
		fireEvent.click(screen.getByLabelText("Add Whisper Tiny to favorites"));
		expect(screen.getByText("Favorites")).toBeDefined();

		const removeButtons = screen.getAllByLabelText(
			"Remove Whisper Tiny from favorites",
		);
		fireEvent.click(removeButtons[0] as HTMLElement);

		expect(screen.queryByText("Favorites")).toBeNull();
		expect(screen.getAllByText("Tiny")).toHaveLength(1);
		expect(
			screen.getByLabelText("Add Whisper Tiny to favorites"),
		).toBeDefined();
	});

	test("favorites persist across remounts via localStorage", () => {
		const first = renderInline([model()]);
		fireEvent.click(screen.getByLabelText("Add Whisper Tiny to favorites"));
		first.unmount();

		// A fresh mount reads the persisted favorites and shows the group again.
		renderInline([model()]);
		expect(screen.getByText("Favorites")).toBeDefined();
		expect(
			screen.getAllByLabelText("Remove Whisper Tiny from favorites").length,
		).toBeGreaterThan(0);
	});
});
