import { AiSettingIcon, CpuIcon } from "@hugeicons/core-free-icons";
import { resolveEffectiveQuant } from "@/entities/model-catalog";
import { providerOf } from "@/entities/cloud-stt-provider";
import type { OnnxQuantization } from "@/shared/config/defaults";
import type { SwitcherOption } from "@/shared/ui/switcher";
import type {
	DeviceValue,
	ElevenIntegration,
	LanguageControlMode,
	ModelControlVisibility,
	StatesById,
	TFn,
	TtsSettings,
} from "./types";

export type { DeviceValue, ModelControlVisibility };

// The Device switch is only ever rendered when a GPU is present (see
// DeviceSection), so it is always the full Auto/CPU pair — Auto picks the
// fastest device per model; CPU is the manual override.
export function buildDeviceOpts(t: TFn): SwitcherOption<DeviceValue>[] {
	return [
		{ value: "auto", label: t("deviceAutoLabel"), icon: AiSettingIcon },
		{ value: "cpu", label: t("deviceCpuLabel"), icon: CpuIcon },
	];
}

/** Whether a local TTS engine is the active synthesis source. It rides on the
 *  Model-tab compute device (`model.device` → `--tts-device`), so the Device
 *  control must survive a cloud STT selection while this is true. Mirrors
 *  TtsModelSection's effective-source gate: either usable cloud provider makes
 *  cloud effective; otherwise the requested cloud source falls back to local. */
export function isLocalTtsActive(
	tts: TtsSettings | undefined,
	elevenlabs: ElevenIntegration,
	openrouterApiKey: string,
): boolean {
	const elevenAvailable =
		elevenlabs.apiKey.trim().length > 0 && elevenlabs.verified === true;
	const openrouterAvailable = openrouterApiKey.trim().length > 0;
	const cloudEffective =
		(tts?.source ?? "local") === "cloud" &&
		(elevenAvailable || openrouterAvailable);
	return (tts?.enabled ?? false) && !cloudEffective;
}

/** Which Model-tab controls stay visible for the active main model. A cloud
 *  main hides STT language (the provider owns it). Device and idle-unload are
 *  shared local-runtime controls, so they remain whenever either local STT or
 *  local TTS is active and disappear only when both synthesis paths are cloud.
 *  A single-language local STT model also hides language (auto-detect + one
 *  language is a no-op choice). */
export function resolveModelControlVisibility(
	selectedIsCloud: boolean,
	languageControlMode: LanguageControlMode,
	localTtsActive: boolean,
): ModelControlVisibility {
	return {
		showLanguage: !selectedIsCloud && languageControlMode !== "hidden",
		showDevice: !selectedIsCloud || localTtsActive,
		// The global idle-unload policy also governs local TTS. Keep it reachable
		// when cloud STT is selected but a local voice engine is still active.
		showLifetime: !selectedIsCloud || localTtsActive,
	};
}

export function localModelIdOrNull(
	modelId: string | undefined,
	enabled = true,
): string | null {
	if (!(enabled && modelId) || providerOf(modelId) !== null) {
		return null;
	}
	return modelId;
}

export function quantForFit(
	statesById: StatesById,
	modelId: string | null,
	currentQuantization: OnnxQuantization,
): string {
	return modelId
		? resolveEffectiveQuant(statesById[modelId], currentQuantization)
		: "";
}

export function requestedDeviceForFit(deviceValue: DeviceValue): string | null {
	return deviceValue === "cpu" ? "cpu" : null;
}
