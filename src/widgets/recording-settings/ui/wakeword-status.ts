import type { WakewordModelStatusPayload } from "@/shared/api/ipc-client";
import { isLowerAccuracyWakeWord } from "../lib/recording-settings-helpers";
import { WAKEWORD_DOWNLOAD_SIZE_LABEL } from "./recording-settings-types";

interface WakewordRuntimeFallback {
	artifactLabel: string;
	downloadSizeLabel: string;
	engine: string;
	engineLabel: string;
	qualityLabel: string;
}

function wakewordRuntimeFallback(
	wakeWord: string | undefined,
): WakewordRuntimeFallback {
	const lowerAccuracy = isLowerAccuracyWakeWord(wakeWord);
	return lowerAccuracy
		? {
				artifactLabel: "sherpa-onnx KWS archive",
				downloadSizeLabel: WAKEWORD_DOWNLOAD_SIZE_LABEL,
				engine: "sherpa-kws",
				engineLabel: "sherpa-onnx custom wake words",
				qualityLabel: "Lower accuracy custom",
			}
		: {
				artifactLabel: "pvporcupine 1.9.5 wheel",
				downloadSizeLabel: "about 2 MB",
				engine: "porcupine-legacy",
				engineLabel: "Porcupine built-in wake words",
				qualityLabel: "High accuracy built-in",
			};
}

export function wakewordStatusWithRuntimeFallback(
	status: WakewordModelStatusPayload,
	wakeWord: string | undefined,
): WakewordModelStatusPayload {
	const fallback = wakewordRuntimeFallback(wakeWord);
	return {
		...status,
		artifactLabel: status.artifactLabel ?? fallback.artifactLabel,
		downloadSizeLabel: status.downloadSizeLabel ?? fallback.downloadSizeLabel,
		engine: status.engine ?? fallback.engine,
		engineLabel: status.engineLabel ?? fallback.engineLabel,
		phase:
			status.phase ??
			(status.available
				? "complete"
				: status.downloading
					? "downloading"
					: "idle"),
		qualityLabel: status.qualityLabel ?? fallback.qualityLabel,
	};
}
