import { describe, expect, mock, test } from "bun:test";
import { Combobox } from "@base-ui/react/combobox";
import { Tooltip as TooltipProvider } from "@base-ui/react/tooltip";
import { render, screen } from "@testing-library/react";
import type { ModelInfo } from "@/entities/model-catalog";
import { SttModelCard } from "./SttModelCard";

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
