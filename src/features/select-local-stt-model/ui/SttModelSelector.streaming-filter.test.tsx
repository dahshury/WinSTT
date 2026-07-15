import { describe, expect, mock, test } from "bun:test";
import {
	fireEvent,
	render,
	screen,
} from "@/shared/ui/model-picker/test/render-with-intl";
import { isVisibleSttModel, type ModelInfo } from "@/entities/model-catalog";
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

describe("SttModelSelector streaming filter", () => {
	test("realtime selector shows only native-streaming models", () => {
		render(
			<SttModelSelector
				currentQuantization=""
				inline
				kind="realtime"
				models={[
					model({
						id: "window-preview",
						displayName: "Window Preview",
						nativeStreaming: false,
						previewCapable: true,
					}),
					model({
						id: "native-stream",
						displayName: "Native Stream",
						nativeStreaming: true,
					}),
				]}
				onChange={mock(() => undefined)}
				statesById={{}}
				systemInfo={null}
				value="native-stream"
			/>,
		);

		expect(screen.getByText("Native Stream")).toBeDefined();
		expect(screen.queryByText("Window Preview")).toBeNull();
	});

	test("merges streaming precision export rows into one card", () => {
		const onChange = mock(() => undefined);
		const onDownloadAction = mock(() => undefined);
		render(
			<SttModelSelector
				currentQuantization=""
				inline
				kind="realtime"
				models={[
					model({
						id: "streaming-parakeet-unified-en-1120ms",
						displayName: "Streaming Parakeet Unified",
						family: "nemo",
						nativeStreaming: true,
						availableQuantizations: [""],
					}),
					model({
						id: "streaming-parakeet-unified-en-1120ms-int8",
						displayName: "Streaming Parakeet Unified",
						family: "nemo",
						nativeStreaming: true,
						availableQuantizations: ["int8"],
					}),
				]}
				onChange={onChange}
				onDownloadAction={onDownloadAction}
				statesById={{}}
				systemInfo={null}
				value="streaming-parakeet-unified-en-1120ms"
			/>,
		);

		expect(screen.getAllByText("Parakeet Unified")).toHaveLength(1);
		expect(screen.getByLabelText("Download fp32 weights")).toBeDefined();
		fireEvent.click(screen.getByLabelText("Download int8 weights"));
		expect(onDownloadAction).toHaveBeenCalledWith(
			"start",
			"streaming-parakeet-unified-en-1120ms-int8",
			"int8",
		);
		expect(onChange).not.toHaveBeenCalled();
	});

	test("merges Nemotron fp32 and int8 latency rows into one precision card", () => {
		const onDownloadAction = mock(() => undefined);
		render(
			<SttModelSelector
				currentQuantization=""
				inline
				kind="realtime"
				models={[
					model({
						id: "streaming-nemotron-en-1120ms",
						displayName: "Streaming Nemotron",
						family: "nemo",
						nativeStreaming: true,
						availableQuantizations: [""],
					}),
					model({
						id: "streaming-nemotron-en-1120ms-int8",
						displayName: "Streaming Nemotron",
						family: "nemo",
						nativeStreaming: true,
						availableQuantizations: ["int8"],
					}),
				]}
				onChange={mock(() => undefined)}
				onDownloadAction={onDownloadAction}
				statesById={{}}
				systemInfo={null}
				value="streaming-nemotron-en-1120ms"
			/>,
		);

		expect(screen.getAllByText("Nemotron")).toHaveLength(1);
		expect(screen.getByLabelText("Download fp32 weights")).toBeDefined();
		fireEvent.click(screen.getByLabelText("Download int8 weights"));
		expect(onDownloadAction).toHaveBeenCalledWith(
			"start",
			"streaming-nemotron-en-1120ms-int8",
			"int8",
		);
	});

	test("Nemotron 3.5 latency rows collapse to one card with a 320/560/1120 picker", () => {
		// Each Nemotron latency row ships all three precisions inline, and the ids are NOT matched
		// by STREAMING_EXPORT_VARIANT_RE — so with the real `isVisibleSttModel` prefilter every row
		// survives and the latency-merge folds them into ONE card whose LatencyShelf offers all three.
		const nemotron = (ms: number) =>
			model({
				id: `streaming-nemotron-3.5-multi-${ms}ms-int8`,
				displayName: `Streaming Nemotron 3.5 ${ms}ms (Multilingual)`,
				family: "nemo",
				nativeStreaming: true,
				availableQuantizations: ["", "fp16", "int8"],
			});
		render(
			<SttModelSelector
				currentQuantization=""
				inline
				kind="realtime"
				models={[nemotron(320), nemotron(560), nemotron(1120)]}
				onChange={mock(() => undefined)}
				prefilter={isVisibleSttModel}
				statesById={{}}
				systemInfo={null}
				value="streaming-nemotron-3.5-multi-1120ms-int8"
			/>,
		);

		// Exactly one LatencyShelf carrying all three chips — proof the rows collapsed into a
		// single card. (Had they stayed three single-latency cards, each shelf would suppress
		// itself and there would be zero latency chips.)
		expect(screen.getAllByLabelText(/streaming latency$/)).toHaveLength(3);
		expect(screen.getByLabelText("Use 320 ms streaming latency")).toBeDefined();
		expect(screen.getByLabelText("Use 560 ms streaming latency")).toBeDefined();
		expect(screen.getByLabelText("Use 1.12 s streaming latency")).toBeDefined();
	});

	test("merges legacy 80ms and 480ms NeMo precision row ids", () => {
		const onDownloadAction = mock(() => undefined);
		render(
			<SttModelSelector
				currentQuantization=""
				inline
				kind="realtime"
				models={[
					model({
						id: "streaming-nemo-ctc-en",
						displayName: "Streaming NeMo FastConformer CTC",
						family: "nemo",
						nativeStreaming: true,
						availableQuantizations: [""],
					}),
					model({
						id: "streaming-nemo-ctc-en-80ms-int8",
						displayName: "Streaming NeMo FastConformer CTC",
						family: "nemo",
						nativeStreaming: true,
						availableQuantizations: ["int8"],
					}),
					model({
						id: "streaming-nemo-rnnt-en",
						displayName: "Streaming NeMo FastConformer RNN-T",
						family: "nemo",
						nativeStreaming: true,
						availableQuantizations: [""],
					}),
					model({
						id: "streaming-nemo-rnnt-en-480ms-int8",
						displayName: "Streaming NeMo FastConformer RNN-T",
						family: "nemo",
						nativeStreaming: true,
						availableQuantizations: ["int8"],
					}),
				]}
				onChange={mock(() => undefined)}
				onDownloadAction={onDownloadAction}
				statesById={{}}
				systemInfo={null}
				value="streaming-nemo-ctc-en"
			/>,
		);

		expect(screen.getAllByText("FastConformer CTC")).toHaveLength(1);
		expect(screen.getAllByText("FastConformer RNN-T")).toHaveLength(1);
		fireEvent.click(screen.getAllByLabelText("Download int8 weights")[0]!);
		expect(onDownloadAction).toHaveBeenCalledWith(
			"start",
			"streaming-nemo-ctc-en-80ms-int8",
			"int8",
		);
	});
});
