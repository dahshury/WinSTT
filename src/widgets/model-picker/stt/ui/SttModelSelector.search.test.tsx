import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen, within } from "../../test/render-with-intl";
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

const MODELS: ModelInfo[] = [
	model({ id: "whisper-tiny", displayName: "Whisper Tiny", family: "whisper" }),
	model({ id: "whisper-base", displayName: "Whisper Base", family: "whisper" }),
	model({
		id: "whisper-large",
		displayName: "Whisper Large",
		family: "whisper",
	}),
	model({ id: "parakeet-tdt", displayName: "Parakeet TDT", family: "nemo" }),
	model({ id: "canary-1b", displayName: "Canary 1B", family: "nemo" }),
];

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
			value="whisper-tiny"
		/>,
	);
	return { ...utils, onChange };
}

function searchInput(): HTMLInputElement {
	return screen.getByPlaceholderText(
		"Search transcription models",
	) as HTMLInputElement;
}

function setSearch(value: string): void {
	fireEvent.change(searchInput(), { target: { value } });
}

/** Cards strip the "Whisper" family prefix, so the visible name for
 *  "Whisper Tiny" is "Tiny". Match the rendered card names. */
function visibleModelNames(): string[] {
	return screen
		.queryAllByRole("option")
		.map((el) => el.textContent ?? "")
		.map((t) => t.trim());
}

function showsWhisper(): boolean {
	return visibleModelNames().some((n) => n.startsWith("Tiny"));
}
function showsParakeet(): boolean {
	return visibleModelNames().some((n) => n.startsWith("Parakeet"));
}

describe("SttModelSelector search → clear → search", () => {
	beforeEach(() => {
		window.localStorage.clear();
	});
	afterEach(() => {
		window.localStorage.clear();
	});

	test("a second search works after clearing the first", () => {
		renderInline(MODELS);

		setSearch("parakeet");
		expect(showsParakeet()).toBe(true);
		expect(showsWhisper()).toBe(false);

		setSearch("");
		expect(showsWhisper()).toBe(true);
		expect(showsParakeet()).toBe(true);

		// The reported bug: this second search found nothing.
		setSearch("whisper");
		expect(showsWhisper()).toBe(true);
		expect(showsParakeet()).toBe(false);
	});

	test("second search works after the first when a model is favorited", () => {
		renderInline(MODELS);
		fireEvent.click(screen.getByLabelText("Add Parakeet TDT to favorites"));

		setSearch("parakeet");
		expect(showsParakeet()).toBe(true);

		setSearch("");
		setSearch("whisper");
		expect(showsWhisper()).toBe(true);
		expect(showsParakeet()).toBe(false);
	});

	test("works with the empty live region present (sanity on within/option roles)", () => {
		renderInline(MODELS);
		const list = screen.getByRole("listbox");
		expect(within(list).queryAllByRole("option").length).toBeGreaterThan(0);
	});

	test("changing the author rail WHILE a query is active does not break later search", () => {
		renderInline(MODELS);

		// Type a query first, so the search is active when the rail changes.
		setSearch("whisper");
		expect(showsWhisper()).toBe(true);

		// Switch to the NeMo rail while "whisper" is still in the box — the list
		// correctly empties (no Whisper under NVIDIA)…
		fireEvent.click(screen.getByLabelText("NVIDIA · NeMo"));
		expect(showsWhisper()).toBe(false);

		// …then back to All authors. The Whisper models MUST come back — the
		// reported bug is that the search stays stuck on "No models found".
		fireEvent.click(screen.getByLabelText("All authors"));
		expect(showsWhisper()).toBe(true);
	});

	test("a text search spans ALL authors even when a maker rail is selected", () => {
		renderInline(MODELS);

		// Narrow to the NeMo rail — only NeMo models show, no Whisper.
		fireEvent.click(screen.getByLabelText("NVIDIA · NeMo"));
		expect(showsParakeet()).toBe(true);
		expect(showsWhisper()).toBe(false);

		// Searching "whisper" must still find Whisper models — the query overrides
		// the rail rather than AND-ing with it into an empty "No models found".
		setSearch("whisper");
		expect(showsWhisper()).toBe(true);
	});

	test("clicking a maker rail clears an active search and browses that maker", () => {
		renderInline(MODELS);

		setSearch("whisper");
		expect(showsWhisper()).toBe(true);

		// Clicking NeMo is a browse intent → search clears, NeMo models show.
		fireEvent.click(screen.getByLabelText("NVIDIA · NeMo"));
		expect(searchInput().value).toBe("");
		expect(showsParakeet()).toBe(true);
		expect(showsWhisper()).toBe(false);
	});

	test("re-searching after a rail change with an active query still works", () => {
		renderInline(MODELS);

		setSearch("whisper");
		fireEvent.click(screen.getByLabelText("NVIDIA · NeMo"));
		fireEvent.click(screen.getByLabelText("All authors"));

		// Clear and search again — must filter normally, not stay screwed.
		setSearch("");
		expect(showsWhisper()).toBe(true);
		setSearch("whisper");
		expect(showsWhisper()).toBe(true);
		expect(showsParakeet()).toBe(false);
	});
});
