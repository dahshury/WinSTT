import type { ModelInfo } from "@/entities/model-catalog";
import { ONNX_QUANTIZATIONS, type OnnxQuantization } from "@/shared/config/defaults";

export interface QuantizationOption {
	label: string;
	tooltip: string;
	value: OnnxQuantization;
}

const QUANTIZATION_LABELS: Record<OnnxQuantization, { label: string; tooltip: string }> = {
	"": {
		label: "Auto",
		tooltip: "Default fp32 weights — slowest but most accurate. Always available.",
	},
	int8: {
		label: "int8",
		tooltip: "8-bit integer quantization. Faster and ~4× smaller than fp32, mild quality loss.",
	},
	fp16: {
		label: "fp16",
		tooltip: "16-bit float. Fastest on GPU, near-fp32 quality.",
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
 * Quantization options the upstream repo actually ships for this model,
 * in canonical order. Unknown suffixes the server reports are ignored so
 * the picker never offers a precision the UI can't label.
 */
export function getQuantizationOptions(model: ModelInfo): QuantizationOption[] {
	const available = new Set(model.availableQuantizations);
	return ONNX_QUANTIZATIONS.filter((value) => available.has(value)).map((value) => ({
		value,
		label: QUANTIZATION_LABELS[value].label,
		tooltip: QUANTIZATION_LABELS[value].tooltip,
	}));
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
