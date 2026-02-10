import type { components } from "@spec/schema";

type WhisperModel = components["schemas"]["WhisperModel"];
type ComputeType = components["schemas"]["ComputeType"];

export const WHISPER_MODELS: readonly WhisperModel[] = [
	"tiny",
	"tiny.en",
	"base",
	"base.en",
	"small",
	"small.en",
	"medium",
	"medium.en",
	"large-v1",
	"large-v2",
	"large-v3",
	"large-v3-turbo",
] as const;

export const COMPUTE_TYPES: readonly ComputeType[] = [
	"default",
	"auto",
	"int8",
	"int8_float16",
	"int8_float32",
	"int8_bfloat16",
	"int16",
	"float16",
	"float32",
	"bfloat16",
] as const;

export const LANGUAGES: readonly { code: string; name: string }[] = [
	{ code: "en", name: "English" },
] as const;

export const DEFAULT_HOTKEY = "LCtrl+LMeta";

export const STT_CONTROL_PORT = 8011;
export const STT_DATA_PORT = 8012;
