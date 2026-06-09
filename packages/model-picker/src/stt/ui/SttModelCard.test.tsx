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
		previewCapable: true,
		nativeStreaming: false,
		finalReuseSafe: true,
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
		<TooltipProvider.Provider closeDelay={0} delay={0}>
			<Combobox.Root items={[model]}>
				<Combobox.List>
					{() => (
						<SttModelCard
							currentQuantization=""
							key={model.id}
							model={model}
							onSelect={onSelect}
							selectedId={undefined}
							state={undefined}
							systemInfo={null}
						/>
					)}
				</Combobox.List>
			</Combobox.Root>
		</TooltipProvider.Provider>,
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

	test("renders the model description when the catalog provides one", () => {
		renderCard(
			makeModel({
				description: "Fast English notes with a lightweight footprint.",
			}),
		);
		expect(
			screen.getByText("Fast English notes with a lightweight footprint."),
		).toBeDefined();
	});

	test("renders multi-language models as a Multilingual tag without requiring language detection", () => {
		renderCard(
			makeModel({
				languages: ["en", "de", "fr"],
				supportsLanguageDetection: false,
			}),
		);
		expect(screen.getByText("Multilingual")).toBeDefined();
		expect(screen.queryByText("EN/DE/FR")).toBeNull();
	});

	test("shows the supported language roster when hovering the Multilingual tag", async () => {
		renderCard(
			makeModel({
				languages: ["en", "de", "fr"],
				supportsLanguageDetection: false,
			}),
		);
		const tag = screen.getByText("Multilingual");
		fireEvent.pointerEnter(tag);
		fireEvent.mouseEnter(tag);
		fireEvent.focus(tag);
		expect(
			await screen.findByText("Supports 3 languages: English, French, German"),
		).toBeDefined();
	});

	test("keeps one-language models explicit", () => {
		renderCard(
			makeModel({ languages: ["ru"], supportsLanguageDetection: false }),
		);
		expect(screen.getByText("RU")).toBeDefined();
		expect(screen.queryByText("Multilingual")).toBeNull();
	});

	test("surfaces native streaming without adding a non-streaming final-policy fact", () => {
		renderCard(
			makeModel({
				id: "streaming-nemotron-en-1120ms-int8",
				nativeStreaming: true,
				finalReuseSafe: true,
			}),
		);
		expect(screen.getByText("Native stream · 1.12 s")).toBeDefined();

		renderCard(
			makeModel({
				id: "custom-full-final",
				nativeStreaming: false,
				previewCapable: true,
				finalReuseSafe: false,
			}),
		);
		expect(screen.queryByText("Full final")).toBeNull();
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
			}),
		);
		// The badge is the visible signal that the row is greyed-out.
		expect(screen.getByText("Broken")).toBeDefined();
	});

	test("disables broken cards via the Combobox.Item disabled prop", () => {
		const { container } = renderCard(
			makeModel({ available: false, errorMessage: "missing decoder.onnx" }),
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
			makeModel({
				available: false,
				errorMessage: "missing tokenizer.json in my-whisper",
			}),
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
		renderCard(
			makeModel({ available: false, errorMessage: "missing encoder.onnx" }),
		);
		expect(screen.queryByText("Precision")).toBeNull();
	});
});

/** Render variant that wires the download dispatcher + snapshot lookup so the
 *  precision-badge download behaviour can be exercised. */
function renderDownloadCard(
	model: ModelInfo,
	snapshot?: QuantDownloadSnapshot | undefined,
) {
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
							key={model.id}
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
		</TooltipProvider.Provider>,
	);
	return { ...utils, onSelect, onDownloadAction };
}

describe("SttModelCard precision-badge download affordance", () => {
	test("card meta uses the selected quant download size, not the runtime estimate", () => {
		const model = makeModel({
			availableQuantizations: ["", "int8"],
			sizeBytesByQuantization: {
				"": 1_073_741_824,
				int8: 83_886_080,
			},
		});
		render(
			<TooltipProvider.Provider>
				<Combobox.Root items={[model]}>
					<Combobox.List>
						{() => (
							<SttModelCard
								currentQuantization="int8"
								key={model.id}
								model={model}
								onSelect={mock(() => undefined)}
								selectedId={undefined}
								state={makeState({
									estimated_bytes: 5_368_709_120,
									effective_quantization: "int8",
								})}
								systemInfo={null}
							/>
						)}
					</Combobox.List>
				</Combobox.Root>
			</TooltipProvider.Provider>,
		);
		expect(screen.getByText("80 MB")).toBeDefined();
		expect(screen.queryByText("5.0 GB")).toBeNull();
	});

	test("an uncached CONCRETE badge IS the download trigger — no separate download button", () => {
		const { onSelect, onDownloadAction } = renderDownloadCard(
			makeModel({ availableQuantizations: ["int8"] }),
		);
		// The int8 quant is uncached (state=undefined). Exactly one control
		// carries the download label: the badge itself. The old standalone
		// Download button beside it is gone.
		const triggers = screen.getAllByLabelText("Download int8 weights");
		expect(triggers.length).toBe(1);
		fireEvent.click(triggers[0] as HTMLElement);
		// Clicking the badge starts a background predownload, NOT a swap.
		expect(onDownloadAction).toHaveBeenCalledWith(
			"start",
			"custom-my-whisper",
			"int8",
		);
		expect(onSelect).not.toHaveBeenCalled();
	});

	test("a downloading CONCRETE badge shows progress + pause/cancel, and stops being a download trigger", () => {
		const snapshot: QuantDownloadSnapshot = {
			downloadedBytes: 5,
			paused: false,
			progress: 50,
			totalBytes: 10,
		};
		const { container } = renderDownloadCard(
			makeModel({ availableQuantizations: ["int8"] }),
			snapshot,
		);
		// Label is replaced by the live percentage.
		expect(screen.getByText("50%")).toBeDefined();
		expect(container.querySelector(".t-digit-group")).toBeNull();
		// Pause + Cancel controls appear while bytes are flowing.
		expect(screen.getByLabelText("Pause int8 download")).toBeDefined();
		expect(screen.getByLabelText("Cancel int8 download")).toBeDefined();
		// It no longer advertises "Download … weights" (it's already downloading).
		expect(screen.queryByLabelText("Download int8 weights")).toBeNull();
	});

	test("a partial CONCRETE badge shows stored progress and resumes before a live snapshot exists", () => {
		const onSelect = mock(() => undefined);
		const onDownloadAction = mock(() => undefined);
		const model = makeModel({ availableQuantizations: ["int8"] });
		const PARTIAL = {
			state: "partial",
			progress: 0.37,
			downloaded_bytes: 37,
			total_bytes: 100,
		} as const;
		render(
			<TooltipProvider.Provider>
				<Combobox.Root items={[model]}>
					<Combobox.List>
						{() => (
							<SttModelCard
								currentQuantization=""
								key={model.id}
								model={model}
								onDownloadAction={onDownloadAction}
								onSelect={onSelect}
								selectedId={undefined}
								state={makeState({
									cache_by_quantization: { int8: { ...PARTIAL } },
								})}
								systemInfo={null}
							/>
						)}
					</Combobox.List>
				</Combobox.Root>
			</TooltipProvider.Provider>,
		);

		expect(screen.getByText("37%")).toBeDefined();
		fireEvent.click(screen.getByLabelText("Resume int8 weights download"));
		expect(onDownloadAction).toHaveBeenCalledWith(
			"resume",
			"custom-my-whisper",
			"int8",
		);
		expect(onSelect).not.toHaveBeenCalled();
	});

	test('the fp32 base export ("") renders as a normal selectable badge, not "Auto"', () => {
		// "" is the full-precision fp32 export — a real, selectable precision badge
		// (labeled "fp32"), NOT a special "Auto" router. The recommended precision is
		// instead a MARK on the resolved badge, and a CARD-BODY click selects it.
		renderDownloadCard(makeModel({ availableQuantizations: [""] }));
		// No "Auto" affordance anywhere…
		expect(screen.queryByLabelText("Select Auto precision")).toBeNull();
		expect(screen.queryByLabelText("Download Auto weights")).toBeNull();
		// …but "" IS present as an fp32 badge (uncached here → the download trigger).
		expect(screen.getByLabelText("Download fp32 weights")).toBeDefined();
	});

	test("the badge matching effective_quantization is marked Recommended", () => {
		// The backend's RAM/VRAM-aware pick (the model state's effective_quantization)
		// is the recommended precision; its badge carries the "(recommended for your
		// hardware)" aria suffix (+ a sparkle). Other badges are not marked.
		const model = makeModel({ availableQuantizations: ["", "fp16", "int8"] });
		render(
			<TooltipProvider.Provider>
				<Combobox.Root items={[model]}>
					<Combobox.List>
						{() => (
							<SttModelCard
								currentQuantization=""
								getDownloadSnapshot={() => undefined}
								key={model.id}
								model={model}
								onDownloadAction={mock(() => undefined)}
								onSelect={mock(() => undefined)}
								selectedId={undefined}
								state={makeState({ effective_quantization: "fp16" })}
								systemInfo={null}
							/>
						)}
					</Combobox.List>
				</Combobox.Root>
			</TooltipProvider.Provider>,
		);
		expect(
			screen.getByLabelText(
				"Download fp16 weights (recommended for your hardware)",
			),
		).toBeDefined();
		// fp32 + int8 are NOT the recommended pick → no suffix.
		expect(
			screen.queryByLabelText(
				"Download fp32 weights (recommended for your hardware)",
			),
		).toBeNull();
	});

	test("clicking a cached CONCRETE badge routes through onSelect at that explicit precision", () => {
		// Badge clicks stay the EXPLICIT precision router (they stopPropagation so they
		// never reach the card-body path). A CACHED int8 badge is a SELECT affordance
		// (not a click-to-download trigger), and selecting it passes the explicit
		// "int8" — distinct from the card body, which selects the RECOMMENDED precision
		// (the model state's effective_quantization).
		const onSelect = mock(() => undefined);
		const model = makeModel({ availableQuantizations: ["int8"] });
		const CACHED = {
			state: "cached",
			progress: 1,
			downloaded_bytes: 10,
			total_bytes: 10,
		} as const;
		render(
			<TooltipProvider.Provider>
				<Combobox.Root items={[model]}>
					<Combobox.List>
						{() => (
							<SttModelCard
								currentQuantization=""
								key={model.id}
								model={model}
								onSelect={onSelect}
								selectedId={undefined}
								state={makeState({
									cache_by_quantization: { int8: { ...CACHED } },
								})}
								systemInfo={null}
							/>
						)}
					</Combobox.List>
				</Combobox.Root>
			</TooltipProvider.Provider>,
		);
		fireEvent.click(screen.getByLabelText("Select int8 precision"));
		expect(onSelect).toHaveBeenCalledWith("custom-my-whisper", "int8");
	});

	test("a cached badge hides delete when canDeleteQuant rejects it", () => {
		const model = makeModel({ availableQuantizations: ["int8"] });
		const CACHED = {
			state: "cached",
			progress: 1,
			downloaded_bytes: 10,
			total_bytes: 10,
		} as const;
		render(
			<TooltipProvider.Provider>
				<Combobox.Root items={[model]}>
					<Combobox.List>
						{() => (
							<SttModelCard
								canDeleteQuant={() => false}
								currentQuantization=""
								key={model.id}
								model={model}
								onRequestDeleteQuant={mock(() => undefined)}
								onSelect={mock(() => undefined)}
								selectedId={undefined}
								state={makeState({
									cache_by_quantization: { int8: { ...CACHED } },
								})}
								systemInfo={null}
							/>
						)}
					</Combobox.List>
				</Combobox.Root>
			</TooltipProvider.Provider>,
		);
		expect(
			screen.queryByLabelText("Delete int8 weights for My Whisper"),
		).toBeNull();
	});

	test("a CONCRETE badge reflects + controls its EFFECTIVE precision's download", () => {
		// The server resolves the model → int8 for this device; the shelf ships a
		// concrete int8 badge. The download lives under `model@int8`, so the int8
		// badge reads the snapshot by that precision and its pause/cancel controls
		// dispatch int8.
		const onSelect = mock(() => undefined);
		const onDownloadAction = mock(() => undefined);
		const snapshot: QuantDownloadSnapshot = {
			downloadedBytes: 5,
			paused: false,
			progress: 50,
			totalBytes: 10,
		};
		const model = makeModel({ availableQuantizations: ["int8"] });
		render(
			<TooltipProvider.Provider>
				<Combobox.Root items={[model]}>
					<Combobox.List>
						{() => (
							<SttModelCard
								currentQuantization=""
								getDownloadSnapshot={(_id, q) =>
									q === "int8" ? snapshot : undefined
								}
								key={model.id}
								model={model}
								onDownloadAction={onDownloadAction}
								onSelect={onSelect}
								selectedId={undefined}
								state={makeState({ effective_quantization: "int8" })}
								systemInfo={null}
							/>
						)}
					</Combobox.List>
				</Combobox.Root>
			</TooltipProvider.Provider>,
		);
		// Live percentage is shown on the int8 badge itself.
		expect(screen.getByText("50%")).toBeDefined();
		// Pause + Cancel controls appear while its bytes flow.
		expect(screen.getByLabelText("Pause int8 download")).toBeDefined();
		expect(screen.getByLabelText("Cancel int8 download")).toBeDefined();
		// …and they dispatch int8.
		fireEvent.click(screen.getByLabelText("Pause int8 download"));
		expect(onDownloadAction).toHaveBeenCalledWith(
			"pause",
			"custom-my-whisper",
			"int8",
		);
	});
});
