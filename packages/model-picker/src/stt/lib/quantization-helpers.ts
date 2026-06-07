import type { ModelInfo } from "@/entities/model-catalog";
import { ONNX_QUANTIZATIONS, type OnnxQuantization } from "@/shared/config/defaults";

export interface QuantizationOption {
	label: string;
	tooltip: string;
	value: OnnxQuantization;
}

const QUANTIZATION_LABELS: Record<OnnxQuantization, { label: string; tooltip: string }> = {
	"": {
		label: "fp32",
		tooltip:
			"Full precision (32-bit float) — the base export. Highest accuracy, but the largest on disk/RAM and the slowest. The badge marked “Recommended” is the best fit for your hardware; clicking the card body picks it.",
	},
	int8: {
		label: "int8",
		tooltip: "8-bit integer quantization. Faster and ~4× smaller than fp32, mild quality loss.",
	},
	fp16: {
		label: "fp16",
		tooltip: "16-bit float. Fastest on GPU, near-fp32 quality.",
	},
	fp16w: {
		label: "fp16w",
		tooltip: "16-bit stored weights with fp32 compute. Near-fp32 quality at about half the disk size.",
	},
	uint8: {
		label: "uint8",
		tooltip: "Unsigned 8-bit quantization. Similar trade-off to int8.",
	},
	q4: {
		label: "q4",
		tooltip:
			"4-bit quantization. Smallest weights, fastest CPU inference, noticeable quality loss.",
	},
	q4f16: {
		label: "q4f16",
		tooltip: "4-bit weights with fp16 activations. Good GPU/CPU compromise.",
	},
	bnb4: {
		label: "bnb4",
		tooltip: "bitsandbytes 4-bit quantization. Compact and fast where supported.",
	},
};

function isKnownQuantization(value: string): value is OnnxQuantization {
	return (ONNX_QUANTIZATIONS as readonly string[]).includes(value);
}

/**
 * Precision "weight" — bit width as a proxy for how heavy (RAM/CPU) AND how
 * faithful each quantization is. Drives the shelf order: most-capable / heaviest
 * on the left to least on the right. `""` is the default export (≈ fp32, the
 * recommended + heaviest), so it leads. The canonical `ONNX_QUANTIZATIONS` order
 * is NOT weight-sorted (it lists int8 before fp16), so this re-sorts it.
 */
const QUANTIZATION_WEIGHT: Record<OnnxQuantization, number> = {
	"": 32,
	fp16: 16,
	fp16w: 16,
	int8: 8,
	uint8: 8,
	q4f16: 6,
	bnb4: 4,
	q4: 4,
};

/**
 * Quantization options the upstream repo actually ships for this model, ordered
 * heaviest/most-capable → lightest (ties keep canonical order, a stable sort).
 * Unknown suffixes the server reports are ignored so the picker never offers a
 * precision the UI can't label.
 */
export function getQuantizationOptions(model: ModelInfo): QuantizationOption[] {
	const available = new Set(model.availableQuantizations);
	// EVERY published precision is shown as a selectable badge, including `""`
	// (the unsuffixed export — labeled "fp32" — the full-precision base). "Auto"
	// is NOT a badge: the recommended precision is instead a MARK on whichever
	// concrete badge the backend's RAM/VRAM-aware resolver picks (the model
	// state's `effective_quantization`), and clicking the card BODY selects it.
	return ONNX_QUANTIZATIONS.filter((value) => available.has(value))
		.map((value) => ({
			value,
			label: QUANTIZATION_LABELS[value].label,
			tooltip: QUANTIZATION_LABELS[value].tooltip,
		}))
		.sort((a, b) => QUANTIZATION_WEIGHT[b.value] - QUANTIZATION_WEIGHT[a.value]);
}

/**
 * True when the model takes an onnx quantization choice *and* the repo
 * ships more than one precision — a single-variant repo has nothing to pick.
 */
export function supportsQuantization(model: ModelInfo): boolean {
	if (model.backend !== "onnx_asr") {
		return false;
	}
	const known = model.availableQuantizations.filter(isKnownQuantization);
	return known.length > 1;
}
