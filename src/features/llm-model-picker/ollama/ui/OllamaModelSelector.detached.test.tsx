import { beforeEach, describe, expect, mock, test } from "bun:test";
import {
	fireEvent,
	render,
	screen,
} from "@/shared/ui/model-picker/test/render-with-intl";
import type { OllamaModel } from "@/shared/api/models";
import { OllamaModelSelector } from "./OllamaModelSelector";

function model(overrides: Partial<OllamaModel> = {}): OllamaModel {
	return {
		name: "llama3:8b",
		size: 4_700_000_000,
		modifiedAt: "2026-01-01T00:00:00Z",
		details: { family: "llama" },
		capabilities: [],
		...overrides,
	} as OllamaModel;
}

describe("OllamaModelSelector detached-open mode", () => {
	beforeEach(() => {
		window.localStorage.clear();
	});

	test("onOpenDetached opens the detached picker without opening the in-page popup", () => {
		const onOpenDetached = mock(() => undefined);
		const onChange = mock(() => undefined);
		render(
			<OllamaModelSelector
				models={[model()]}
				onChange={onChange}
				onOpenDetached={onOpenDetached}
				value="llama3:8b"
			/>,
		);

		const trigger = document.querySelector(
			'[data-slot="ollama-model-selector-trigger"]',
		);
		expect(trigger).not.toBeNull();
		if (trigger === null) {
			throw new Error("Expected Ollama model selector trigger");
		}

		fireEvent.click(trigger);

		expect(onOpenDetached).toHaveBeenCalledTimes(1);
		expect(trigger.getAttribute("data-state")).toBe("closed");
		expect(trigger.getAttribute("aria-expanded")).toBe("false");
		expect(screen.queryByRole("listbox")).toBeNull();
		expect(onChange).not.toHaveBeenCalled();
	});

	test("uses the shared glass trigger border treatment", () => {
		render(
			<OllamaModelSelector
				models={[model()]}
				onChange={() => undefined}
				value="llama3:8b"
			/>,
		);

		const trigger = document.querySelector(
			'[data-slot="ollama-model-selector-trigger"]',
		);
		expect(trigger).not.toBeNull();
		const className = trigger?.getAttribute("class") ?? "";
		expect(className).toContain("bg-gradient-to-b");
		expect(className).toContain("ring-overlay-foreground/[0.07]");
		expect(className).not.toContain("border-border");
	});

	test("renders selected Ollama parameters, quantization, and estimated VRAM in the closed trigger", () => {
		render(
			<OllamaModelSelector
				models={[
					model({
						name: "llama3.2:8b-instruct-q4_K_M",
						details: {
							family: "llama",
							parameterSize: "8B",
							quantizationLevel: "Q4_K_M",
						},
					}),
				]}
				onChange={() => undefined}
				systemFit={() => ({
					availableBytes: 12_000_000_000,
					fits: true,
					requiredBytes: 6_640_000_000,
					shortfall: undefined,
				})}
				value="llama3.2:8b-instruct-q4_K_M"
			/>,
		);

		const trigger = document.querySelector(
			'[data-slot="ollama-model-selector-trigger"]',
		);
		expect(trigger?.textContent).toContain("Llama 3.2");
		expect(trigger?.textContent).toContain("Instruct");
		expect(trigger?.textContent).toContain("8B");
		expect(trigger?.textContent).toContain("Q4_K_M");
		expect(trigger?.textContent).toContain("6.6 GB");
		expect(trigger?.textContent).not.toContain("4.7 GB");
	});

	test("recovers the selected Qwen parameter count from its model tag", () => {
		render(
			<OllamaModelSelector
				models={[
					model({
						name: "qwen3.5:4b",
						details: { family: "qwen" },
					}),
				]}
				onChange={() => undefined}
				value="qwen3.5:4b"
			/>,
		);

		const trigger = document.querySelector(
			'[data-slot="ollama-model-selector-trigger"]',
		);
		expect(trigger?.textContent).toContain("Qwen 3.5");
		expect(trigger?.textContent).toContain("4B");
	});

	test("a typed off-catalog tag renders a full card from the on-demand homepage hit", () => {
		const uiStorageKey = "winstt:test:ollama-typed-card";
		window.localStorage.setItem(
			uiStorageKey,
			JSON.stringify({
				activeRailId: "__all_authors__",
				query: "gpt-oss:20b",
				sortKey: null,
			}),
		);
		const noop = () => undefined;

		render(
			<OllamaModelSelector
				inline
				librarySearch={{
					catalog: [],
					error: null,
					isLoaded: true,
					isLoading: false,
					loadCatalog: noop,
					fetchTags: noop,
					fetchHit: noop,
					tagsByModel: {
						"gpt-oss": {
							isLoading: false,
							error: null,
							tags: [
								{
									name: "gpt-oss:20b",
									sizeBytes: 13_800_000_000,
									sizeLabel: "13.8GB",
									parameterSize: "20B",
									contextWindow: "128K",
								},
							],
						},
					},
					hitsByModel: {
						"gpt-oss": {
							isLoading: false,
							error: null,
							hit: {
								name: "gpt-oss",
								description: "OpenAI open-weight reasoning models",
								capabilities: ["tools", "thinking"],
							},
						},
					},
				}}
				models={[]}
				onChange={noop}
				onDiscardPull={noop}
				onPull={noop}
				onResumePull={noop}
				onStopPull={noop}
				uiStorageKey={uiStorageKey}
				value=""
			/>,
		);

		// The card title beautifies the tag (param size moves to the meta chip),
		// the scraped description fills in, and the capability badges + 20B/128K
		// facts all come from the on-demand homepage hit + tags.
		expect(
			screen.getByText("OpenAI open-weight reasoning models"),
		).not.toBeNull();
		const listText =
			document.querySelector('[data-slot="ollama-model-list"]')?.textContent ??
			"";
		expect(listText).toContain("GPT OSS");
		expect(listText).toContain("20B");
		expect(listText).toContain("128K");
		// Capability badges render as icon chips (aria-labelled) from the hit's
		// `capabilities: ["tools", "thinking"]` — assert the reasoning chip mounted.
		expect(screen.getByLabelText("Reasoning")).not.toBeNull();
	});

	test("inline detached mode restores persisted search query for its scoped key", () => {
		const uiStorageKey = "winstt:test:ollama-inline-ui";
		window.localStorage.setItem(
			uiStorageKey,
			JSON.stringify({
				activeRailId: "llama",
				query: "llama3",
				sortKey: null,
			}),
		);

		render(
			<OllamaModelSelector
				inline
				models={[model()]}
				onChange={() => undefined}
				uiStorageKey={uiStorageKey}
				value="llama3:8b"
			/>,
		);

		const search = screen.getByPlaceholderText(
			"Search models or enter an Ollama tag",
		) as HTMLInputElement;
		expect(search.value).toBe("llama3");
	});
});
