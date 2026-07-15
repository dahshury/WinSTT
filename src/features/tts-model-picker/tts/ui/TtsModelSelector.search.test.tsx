import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
	fireEvent,
	render,
	screen,
	within,
} from "@/shared/ui/model-picker/test/render-with-intl";
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
		voiceDesign: false,
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

const MODELS: TtsModelInfo[] = [
	model({ id: "kokoro-82m", displayName: "Kokoro 82M", engine: "kokoro" }),
	model({
		id: "piper-lessac",
		displayName: "Piper Lessac",
		engine: "piper",
		maker: "Rhasspy",
		paramCountM: 20,
	}),
];

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

function searchInput(): HTMLInputElement {
	return screen.getByPlaceholderText("Search voice models") as HTMLInputElement;
}

function setSearch(value: string): void {
	fireEvent.change(searchInput(), { target: { value } });
}

function visibleModelNames(): string[] {
	return screen
		.queryAllByRole("option")
		.map((el) => el.textContent ?? "")
		.map((t) => t.trim());
}

function showsKokoro(): boolean {
	return visibleModelNames().some((n) => n.includes("Kokoro"));
}
function showsPiper(): boolean {
	return visibleModelNames().some((n) => n.includes("Piper"));
}

describe("TtsModelSelector search → clear → search", () => {
	beforeEach(() => {
		window.localStorage.clear();
	});
	afterEach(() => {
		window.localStorage.clear();
	});

	test("a second search works after clearing the first", () => {
		renderInline(MODELS);

		setSearch("piper");
		expect(showsPiper()).toBe(true);
		expect(showsKokoro()).toBe(false);

		setSearch("");
		expect(showsKokoro()).toBe(true);
		expect(showsPiper()).toBe(true);

		// The reported bug: this second search found nothing.
		setSearch("kokoro");
		expect(showsKokoro()).toBe(true);
		expect(showsPiper()).toBe(false);
	});

	test("works with the empty live region present (sanity on within/option roles)", () => {
		renderInline(MODELS);
		const list = screen.getByRole("listbox");
		expect(within(list).queryAllByRole("option").length).toBeGreaterThan(0);
	});

	test("changing the author rail WHILE a query is active does not break later search", () => {
		renderInline(MODELS);

		// Type a query first, so the search is active when the rail changes.
		setSearch("kokoro");
		expect(showsKokoro()).toBe(true);

		// Switch to the Piper rail while "kokoro" is still in the box — the list
		// correctly empties (no Kokoro under Rhasspy)…
		fireEvent.click(screen.getByLabelText("Rhasspy · Piper"));
		expect(showsKokoro()).toBe(false);

		// …then back to All authors. The Kokoro models MUST come back — the
		// reported bug is that the search stays stuck on "No models found".
		fireEvent.click(screen.getByLabelText("All authors"));
		expect(showsKokoro()).toBe(true);
	});

	test("a text search spans ALL authors even when a maker rail is selected", () => {
		renderInline(MODELS);

		// Narrow to the Piper rail — only Piper models show, no Kokoro.
		fireEvent.click(screen.getByLabelText("Rhasspy · Piper"));
		expect(showsPiper()).toBe(true);
		expect(showsKokoro()).toBe(false);

		// Searching "kokoro" must still find Kokoro models — the query overrides
		// the rail rather than AND-ing with it into an empty "No models found".
		setSearch("kokoro");
		expect(showsKokoro()).toBe(true);
	});

	test("clicking a maker rail clears an active search and browses that maker", () => {
		renderInline(MODELS);

		setSearch("kokoro");
		expect(showsKokoro()).toBe(true);

		// Clicking Piper is a browse intent → search clears, Piper models show.
		fireEvent.click(screen.getByLabelText("Rhasspy · Piper"));
		expect(searchInput().value).toBe("");
		expect(showsPiper()).toBe(true);
		expect(showsKokoro()).toBe(false);
	});

	test("re-searching after a rail change with an active query still works", () => {
		renderInline(MODELS);

		setSearch("kokoro");
		fireEvent.click(screen.getByLabelText("Rhasspy · Piper"));
		fireEvent.click(screen.getByLabelText("All authors"));

		// Clear and search again — must filter normally, not stay screwed.
		setSearch("");
		expect(showsKokoro()).toBe(true);
		setSearch("kokoro");
		expect(showsKokoro()).toBe(true);
		expect(showsPiper()).toBe(false);
	});
});

describe("TtsModelSelector closed-trigger download status", () => {
	test("surfaces a per-quant download outside the popup", () => {
		const { container } = render(
			<TtsModelSelector
				currentQuantization="fp16"
				models={MODELS}
				onChange={() => undefined}
				onDownloadSnapshot={(modelId, quantization) =>
					modelId === "piper-lessac" && quantization === "fp16"
						? {
								downloadedBytes: 420,
								paused: false,
								progress: 42,
								totalBytes: 1000,
							}
						: undefined
				}
				statesById={{}}
				value="kokoro-82m"
			/>,
		);

		const trigger = container.querySelector(
			'[data-slot="tts-model-selector-trigger"]',
		);
		expect(trigger).not.toBeNull();
		expect(trigger?.getAttribute("data-switching")).toBe("true");
		expect(trigger?.textContent).toContain("Piper Lessac");
		expect(trigger?.textContent).toContain("42%");
		expect(trigger?.textContent).toContain("Downloading");
		expect(trigger?.querySelectorAll('[data-slot="pulse-dot"]')).toHaveLength(
			1,
		);
		expect(trigger?.getAttribute("aria-label")).toContain(
			"Downloading Piper Lessac (42 percent)",
		);
	});
});

describe("TtsModelSelector filters", () => {
	beforeEach(() => window.localStorage.clear());
	afterEach(() => window.localStorage.clear());

	test("filters the visible model collection from the shared menu", () => {
		renderInline([
			...MODELS,
			model({
				id: "spark-clone",
				displayName: "Spark Clone",
				engine: "spark",
				cloning: "zero_shot_audio_transcript",
			}),
		]);

		fireEvent.click(screen.getByRole("button", { name: "Sort & filter" }));
		fireEvent.click(screen.getByRole("checkbox", { name: "Voice cloning" }));

		const names = visibleModelNames();
		expect(names.some((name) => name.includes("Spark Clone"))).toBe(true);
		expect(names.some((name) => name.includes("Kokoro"))).toBe(false);
		expect(names.some((name) => name.includes("Piper"))).toBe(false);
		expect(
			screen.getByRole("button", { name: "Sort & filter (1 active)" }),
		).not.toBeNull();
	});
});
