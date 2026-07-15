import { useGpuInfo } from "@/entities/connection";
import { useDeviceSwitchFeedback } from "@/features/audio-device-feedback";
import { useAudioDeviceMonitor } from "@/features/audio-device-monitor";
import { useFileTranscriptionListener } from "@/features/file-transcription";
import { useListenMode } from "@/features/listen-mode";
import { useDownloadListener } from "@/features/model-download";
import { useModifierOnlyHotkeyToast } from "@/features/push-to-talk";
import { useVadCalibration } from "@/features/vad-calibration";
import {
	useAppProfileIndicator,
	usePostProcessingProfileSwap,
} from "@/widgets/llm-settings";

/** Non-paint-critical subscriptions loaded after the main shell is visible. */
export function DeferredIpcEffects() {
	useModifierOnlyHotkeyToast();
	useDownloadListener();
	useFileTranscriptionListener();
	useListenMode();
	usePostProcessingProfileSwap();
	useAppProfileIndicator();
	useDeviceSwitchFeedback();
	useVadCalibration();
	useAudioDeviceMonitor();

	// GPU details are only needed by model/settings surfaces. Preserve the
	// original delay in addition to moving the module off the first-paint graph.
	useGpuInfo(750);

	return null;
}
