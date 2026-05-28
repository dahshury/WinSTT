import { describe, expect, mock, test } from "bun:test";
import { Combobox } from "@base-ui/react/combobox";
import { Tooltip as TooltipProvider } from "@base-ui/react/tooltip";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ModelInfo } from "@/entities/model-catalog";
import { type QuantDownloadSnapshot, SttModelCard } from "./SttModelCard";

/** Factory producing a fully-typed ModelInfo with sane defaults so each
 *  test only spells out the fields it actually cares about. */
function makeModel(overrides: Partial<ModelInfo> = {}): ModelInfo {
	return {
		id: "custom-my-whisper",
		displayName: "My Whisper",
		family: "custom",
		backend: "onnx_asr",
		languages: [],
		supportsLanguageDetection: false,
		sizeLabel: "",
		supportsRealtime: true,
		onnxModelName: null,
		description: "",
		availableQuantizations: [""],
		sizeBytesByQuantization: {},
		available: true,
		errorMessage: "",
		localPath: "/userData/models/custom/my-whisper",
		speedScore: 0.5,
		accuracyScore: 0.5,
		...overrides,
	};
}

function renderCard(model: ModelInfo) {
	const onSelect = mock(() => undefined);
	const utils = render(
		<TooltipProvider.Provider>
			<Combobox.Root items={[model]}>
				<Combobox.List>
					{() => (
						<SttModelCard
							currentQuantization=""
							model={model}
							onSelect={onSelect}
							selectedId={undefined}
							state={undefined}
							systemInfo={null}
						/>
					)}
				</Combobox.List>
			</Combobox.Root>
		</TooltipProvider.Provider>
	);
	return { ...utils, onSelect };
}

describe("SttModelCard custom-model handling", () => {
	test("renders the display name for a valid custom entry", () => {
		renderCard(makeModel({ displayName: "Acme Voice" }));
		// The card strips the family-label prefix; "Custom" is the label, so
		// "Acme Voice" survives unchanged.
		expect(screen.getByText("Acme Voice")).toBeDefined();
	});

	test("does NOT render the 'Broken' badge on a healthy custom entry", () => {
		renderCard(makeModel({ available: true, errorMessage: "" }));
		expect(screen.queryByText("Broken")).toBeNull();
	});

	test("renders a 'Broken' badge when available=false", () => {
		renderCard(
			makeModel({
				available: false,
				errorMessage: "missing tokenizer.json in my-whisper",
			})
		);
		// The badge is the visible signal that the row is greyed-out.
		expect(screen.getByText("Broken")).toBeDefined();
	});

	test("disables broken cards via the Combobox.Item disabled prop", () => {
		const { container } = renderCard(
			makeModel({ available: false, errorMessage: "missing decoder.onnx" })
		);
		// Base UI sets ``data-disabled`` on the rendered <div> when the item
		// is disabled — we assert against that rather than reaching into the
		// react-internals. The disabled prop is what stops Combobox from
		// firing onValueChange for broken rows.
		const disabled = container.querySelector("[data-disabled]");
		expect(disabled).not.toBeNull();
	});

	test("surfaces the error message as the title attribute on broken cards", () => {
		const { container } = renderCard(
			makeModel({ available: false, errorMessage: "missing tokenizer.json in my-whisper" })
		);
		// The native title attribute is the OS-level tooltip the user sees
		// when hovering the greyed-out card. Inline tooltips also work but
		// the title is the lowest-common-denominator signal.
		const withTitle = container.querySelector('[title*="Unavailable"]');
		expect(withTitle).not.toBeNull();
	});

	test("does not render the PrecisionGroup on a broken card", () => {
		// "Precision" is the label of the PrecisionGroup header — its
		// absence confirms the broken card hides the precision row (loading
		// broken weights at a different precision wouldn't help anyway).
		renderCard(makeModel({ available: false, errorMessage: "missing encoder.onnx" }));
		expect(screen.queryByText("Precision")).toBeNull();
	});
});

/** Render variant that wires the download dispatcher + snapshot lookup so the
 *  precision-badge download behaviour can be exercised. */
function renderDownloadCard(model: ModelInfo, snapshot?: QuantDownloadSnapshot | undefined) {
	const onSelect = mock(() => undefined);
	const onDownloadAction = mock(() => undefined);
	const utils = render(
		<TooltipProvider.Provider>
			<Combobox.Root items={[model]}>
				<Combobox.List>
					{() => (
						<SttModelCard
							currentQuantization=""
							getDownloadSnapshot={() => snapshot}
							model={model}
							onDownloadAction={onDownloadAction}
							onSelect={onSelect}
							selectedId={undefined}
							state={undefined}
							systemInfo={null}
						/>
					)}
				</Combobox.List>
			</Combobox.Root>
		</TooltipProvider.Provider>
	);
	return { ...utils, onSelect, onDownloadAction };
}

describe("SttModelCard precision-badge download affordance", () => {
	test("an uncached badge IS the download trigger — no separate download button", () => {
		const { onSelect, onDownloadAction } = renderDownloadCard(makeModel());
		// The default "Auto" ("") quant is uncached (state=undefined). Exactly
		// one control carries the download label: the badge itself. The old
		// standalone Download button beside it is gone.
		const triggers = screen.getAllByLabelText("Download Auto weights");
		expect(triggers.length).toBe(1);
		fireEvent.click(triggers[0] as HTMLElement);
		// Clicking the badge starts a background predownload, NOT a swap.
		expect(onDownloadAction).toHaveBeenCalledWith("start", "custom-my-whisper", "");
		expect(onSelect).not.toHaveBeenCalled();
	});

	test("a downloading badge shows progress + pause/cancel, and stops being a download trigger", () => {
		const snapshot: QuantDownloadSnapshot = {
			downloadedBytes: 5,
			paused: false,
			progress: 50,
			totalBytes: 10,
		};
		renderDownloadCard(makeModel(), snapshot);
		// Label is replaced by the live percentage.
		expect(screen.getByText("50%")).toBeDefined();
		// Pause + Cancel controls appear while bytes are flowing.
		expect(screen.getByLabelText("Pause Auto download")).toBeDefined();
		expect(screen.getByLabelText("Cancel Auto download")).toBeDefined();
		// It no longer advertises "Download … weights" (it's already downloading).
		expect(screen.queryByLabelText("Download Auto weights")).toBeNull();
	});
});
