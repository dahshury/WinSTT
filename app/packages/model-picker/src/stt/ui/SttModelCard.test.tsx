import { describe, expect, mock, test } from "bun:test";
import { Combobox } from "@base-ui/react/combobox";
import { Tooltip as TooltipProvider } from "@base-ui/react/tooltip";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ModelInfo } from "@/entities/model-catalog";
import type { ModelStateEntry } from "@/shared/api/ipc-client";
import { type QuantDownloadSnapshot, SttModelCard } from "./SttModelCard";

const NOT_CACHED = {
	state: "not_cached",
	progress: 0,
	downloaded_bytes: 0,
	total_bytes: 0,
} as const;

/** Minimal valid ModelStateEntry for the precision-badge tests — only the
 *  fields the card actually reads (effective_quantization, cache lookups,
 *  comfort flags) carry meaning; the rest take inert defaults. */
function makeState(overrides: Partial<ModelStateEntry> = {}): ModelStateEntry {
	return {
		id: "custom-my-whisper",
		available_quantizations: ["", "int8"],
		cache: { ...NOT_CACHED },
		cache_by_quantization: {},
		comfortable_on_cpu: true,
		comfortable_on_gpu: true,
		estimated_bytes: 0,
		...overrides,
	};
}

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
	test("an uncached CONCRETE badge IS the download trigger — no separate download button", () => {
		const { onSelect, onDownloadAction } = renderDownloadCard(
			makeModel({ availableQuantizations: ["int8"] })
		);
		// The int8 quant is uncached (state=undefined). Exactly one control
		// carries the download label: the badge itself. The old standalone
		// Download button beside it is gone.
		const triggers = screen.getAllByLabelText("Download int8 weights");
		expect(triggers.length).toBe(1);
		fireEvent.click(triggers[0] as HTMLElement);
		// Clicking the badge starts a background predownload, NOT a swap.
		expect(onDownloadAction).toHaveBeenCalledWith("start", "custom-my-whisper", "int8");
		expect(onSelect).not.toHaveBeenCalled();
	});

	test("a downloading CONCRETE badge shows progress + pause/cancel, and stops being a download trigger", () => {
		const snapshot: QuantDownloadSnapshot = {
			downloadedBytes: 5,
			paused: false,
			progress: 50,
			totalBytes: 10,
		};
		renderDownloadCard(makeModel({ availableQuantizations: ["int8"] }), snapshot);
		// Label is replaced by the live percentage.
		expect(screen.getByText("50%")).toBeDefined();
		// Pause + Cancel controls appear while bytes are flowing.
		expect(screen.getByLabelText("Pause int8 download")).toBeDefined();
		expect(screen.getByLabelText("Cancel int8 download")).toBeDefined();
		// It no longer advertises "Download … weights" (it's already downloading).
		expect(screen.queryByLabelText("Download int8 weights")).toBeNull();
	});

	test("idle Auto never STARTS a download — clicking it routes through onSelect at ''", () => {
		// Auto ("") is a selection router: it never click-to-starts a download
		// (the swap controller resolves + prompts the right device-appropriate
		// precision). With nothing downloading it shows no progress chrome and a
		// click selects at "".
		const { onSelect, onDownloadAction } = renderDownloadCard(makeModel());
		expect(screen.queryByLabelText("Download Auto weights")).toBeNull();
		expect(screen.queryByText("50%")).toBeNull();
		fireEvent.click(screen.getByLabelText("Select Auto precision"));
		expect(onSelect).toHaveBeenCalledWith("custom-my-whisper", "");
		expect(onDownloadAction).not.toHaveBeenCalled();
	});

	test("Auto reflects + controls its EFFECTIVE precision's download (int8-preferred family)", () => {
		// The server resolves Auto → int8 for this device, and the repo ships NO
		// concrete int8 badge (availableQuantizations omits it). The download lives
		// under `model@int8`, so the Auto badge is the ONLY surface that can show
		// it — it reads the snapshot by the EFFECTIVE precision and its pause/cancel
		// controls must dispatch that same precision (int8), not the raw "".
		const onSelect = mock(() => undefined);
		const onDownloadAction = mock(() => undefined);
		const snapshot: QuantDownloadSnapshot = {
			downloadedBytes: 5,
			paused: false,
			progress: 50,
			totalBytes: 10,
		};
		render(
			<TooltipProvider.Provider>
				<Combobox.Root items={[makeModel()]}>
					<Combobox.List>
						{() => (
							<SttModelCard
								currentQuantization=""
								getDownloadSnapshot={(_id, q) => (q === "int8" ? snapshot : undefined)}
								model={makeModel()}
								onDownloadAction={onDownloadAction}
								onSelect={onSelect}
								selectedId={undefined}
								state={makeState({ effective_quantization: "int8" })}
								systemInfo={null}
							/>
						)}
					</Combobox.List>
				</Combobox.Root>
			</TooltipProvider.Provider>
		);
		// Live percentage is shown on the Auto badge itself.
		expect(screen.getByText("50%")).toBeDefined();
		// Pause + Cancel controls appear on Auto while its effective bytes flow.
		expect(screen.getByLabelText("Pause Auto download")).toBeDefined();
		expect(screen.getByLabelText("Cancel Auto download")).toBeDefined();
		// …and they dispatch the EFFECTIVE precision (int8), not the raw "".
		fireEvent.click(screen.getByLabelText("Pause Auto download"));
		expect(onDownloadAction).toHaveBeenCalledWith("pause", "custom-my-whisper", "int8");
	});
});
