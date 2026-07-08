import { beforeEach, describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen } from "../../test/render-with-intl";
import { type ModelInfo, useModelSwapStore } from "@/entities/model-catalog";
import type { ModelStateEntry } from "@/shared/api/ipc-client";
import {
	_resetSelectedModelMetadataCacheForTests,
	SttModelSelector,
} from "./SttModelSelector";

function model(): ModelInfo {
	return {
		id: "tiny",
		displayName: "Whisper Tiny",
		family: "whisper",
		backend: "faster_whisper",
		languages: ["en"],
		supportsLanguageDetection: true,
		sizeLabel: "39M",
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
	} as ModelInfo;
}

function state(overrides: Partial<ModelStateEntry> = {}): ModelStateEntry {
	return {
		id: "tiny",
		cache: {
			state: "cached",
			progress: 1,
			downloaded_bytes: 123_000_000,
			total_bytes: 123_000_000,
		},
		cache_by_quantization: {},
		available_quantizations: ["", "int8"],
		effective_quantization: "int8",
		estimated_bytes: 0,
		comfortable_on_gpu: true,
		comfortable_on_cpu: true,
		...overrides,
	} as ModelStateEntry;
}

describe("SttModelSelector detached-open mode", () => {
	beforeEach(() => {
		// The module-level selected-model metadata cache (keyed by `${kind}:${value}`)
		// bleeds across test files in the single-process suite — a prior file's
		// `stt:tiny` entry yields stale quant/footprint here. Clear it per case.
		_resetSelectedModelMetadataCacheForTests();
		// A leaked, never-unmounted selector fiber from a prior test file can leave
		// the model-swap store mid-swap, which flips the trigger into its
		// "switching from → to" view instead of the steady-state chip. Reset it so
		// each case starts from the idle state.
		useModelSwapStore.setState({
			activeMain: null,
			activeRealtime: null,
			fromMain: null,
			fromRealtime: null,
		});
	});

	test("onOpenDetached: clicking the trigger opens the detached picker, not the inline popup", () => {
		const onOpenDetached = mock(() => undefined);
		const onChange = mock(() => undefined);
		render(
			<SttModelSelector
				currentQuantization=""
				models={[model()]}
				onChange={onChange}
				onOpenDetached={onOpenDetached}
				statesById={{}}
				systemInfo={null}
				value="tiny"
			/>,
		);

		const trigger = document.querySelector(
			'[data-slot="stt-model-selector-trigger"]',
		);
		expect(trigger).not.toBeNull();
		if (trigger === null) {
			throw new Error("Expected STT model selector trigger");
		}

		fireEvent.click(trigger);

		// The click routes to the detached-window opener with the trigger's rect…
		expect(onOpenDetached).toHaveBeenCalledTimes(1);
		// …and the in-window popup remains closed, so it can't be clipped by the host window.
		expect(trigger.getAttribute("data-state")).toBe("closed");
		expect(trigger.getAttribute("aria-expanded")).toBe("false");
		expect(screen.queryByRole("listbox")).toBeNull();
		expect(onChange).not.toHaveBeenCalled();
	});

	test("keeps the selected author chip when remounted before the catalog refills", () => {
		const first = render(
			<SttModelSelector
				currentQuantization=""
				models={[model()]}
				onChange={mock(() => undefined)}
				onOpenDetached={mock(() => undefined)}
				statesById={{}}
				systemInfo={null}
				value="tiny"
			/>,
		);
		expect(screen.getByText("OpenAI")).toBeDefined();
		first.unmount();

		render(
			<SttModelSelector
				currentQuantization=""
				isLoading
				models={[]}
				onChange={mock(() => undefined)}
				onOpenDetached={mock(() => undefined)}
				statesById={{}}
				systemInfo={null}
				value="tiny"
			/>,
		);

		expect(screen.getByText("OpenAI")).toBeDefined();
		expect(screen.getByText("Tiny")).toBeDefined();
	});

	test("renders selected quantization and footprint in the closed trigger", () => {
		const selected = {
			...model(),
			displayName: "NeMo Parakeet TDT 0.6B v3",
			family: "nemo",
			sizeLabel: "0.6B",
			sizeBytesByQuantization: { int8: 123_000_000 },
		} as ModelInfo;

		render(
			<SttModelSelector
				currentQuantization="int8"
				models={[selected]}
				onChange={mock(() => undefined)}
				onOpenDetached={mock(() => undefined)}
				statesById={{ tiny: state() }}
				systemInfo={null}
				value="tiny"
			/>,
		);

		const trigger = document.querySelector(
			'[data-slot="stt-model-selector-trigger"]',
		);
		expect(trigger?.textContent).toContain("Parakeet TDT");
		expect(trigger?.textContent).toContain("v3");
		expect(trigger?.textContent).toContain("0.6B");
		expect(trigger?.textContent).toContain("INT8");
		expect(trigger?.textContent).toContain("117 MB");
	});
});
