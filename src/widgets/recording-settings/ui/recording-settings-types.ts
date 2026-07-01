import type { useTranslations } from "use-intl";
import type { WakewordModelStatusPayload } from "@/shared/api/ipc-client";

export type {
	AudioSettings,
	AudioT,
	GeneralSettings,
	GeneralT,
	QualitySettings,
	QualityT,
	UpdateAudioFn,
	UpdateGeneralFn,
	UpdateQualityFn,
} from "@/entities/setting";

export type CommonT = ReturnType<typeof useTranslations<"common">>;
export type SettingsT = ReturnType<typeof useTranslations<"settings">>;

export const SILENCE_STOP_MIN_SECONDS = 0.1;
export const SILENCE_STOP_MAX_SECONDS = 10;
export const SILENCE_STOP_STEP_SECONDS = 0.1;
export const WAKEWORD_DOWNLOAD_SIZE_LABEL = "about 17 MB";
export const WAKEWORD_MODEL_DISABLED_REASON = "wake word model download";
export const WAKEWORD_MODEL_STATUS_DEFAULT: WakewordModelStatusPayload = {
	available: false,
	downloading: false,
	phase: "idle",
};

export function roundSilenceStopSeconds(value: number): number {
	return Number(
		(
			Math.round(value / SILENCE_STOP_STEP_SECONDS) * SILENCE_STOP_STEP_SECONDS
		).toFixed(1),
	);
}
