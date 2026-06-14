import { beforeEach, describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen } from "../../test/render-with-intl";
import { type ModelInfo, useModelSwapStore } from "@/entities/model-catalog";
import { SttModelSelector } from "./SttModelSelector";

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
	} as ModelInfo;
}

describe("SttModelSelector detached-open mode", () => {
	beforeEach(() => {
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

		fireEvent.click(trigger as Element);

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
});
