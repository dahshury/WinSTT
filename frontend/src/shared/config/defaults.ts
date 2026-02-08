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
	{ code: "zh", name: "Chinese" },
	{ code: "de", name: "German" },
	{ code: "es", name: "Spanish" },
	{ code: "ru", name: "Russian" },
	{ code: "ko", name: "Korean" },
	{ code: "fr", name: "French" },
	{ code: "ja", name: "Japanese" },
	{ code: "pt", name: "Portuguese" },
	{ code: "tr", name: "Turkish" },
	{ code: "pl", name: "Polish" },
	{ code: "ca", name: "Catalan" },
	{ code: "nl", name: "Dutch" },
	{ code: "ar", name: "Arabic" },
	{ code: "sv", name: "Swedish" },
	{ code: "it", name: "Italian" },
	{ code: "id", name: "Indonesian" },
	{ code: "hi", name: "Hindi" },
	{ code: "fi", name: "Finnish" },
	{ code: "vi", name: "Vietnamese" },
	{ code: "he", name: "Hebrew" },
	{ code: "uk", name: "Ukrainian" },
	{ code: "el", name: "Greek" },
	{ code: "ms", name: "Malay" },
	{ code: "cs", name: "Czech" },
	{ code: "ro", name: "Romanian" },
	{ code: "da", name: "Danish" },
	{ code: "hu", name: "Hungarian" },
	{ code: "ta", name: "Tamil" },
	{ code: "no", name: "Norwegian" },
	{ code: "th", name: "Thai" },
	{ code: "ur", name: "Urdu" },
	{ code: "hr", name: "Croatian" },
	{ code: "bg", name: "Bulgarian" },
	{ code: "lt", name: "Lithuanian" },
	{ code: "la", name: "Latin" },
	{ code: "", name: "Auto-detect" },
] as const;

export const DEFAULT_HOTKEY = "Space";

export const STT_CONTROL_PORT = 8011;
export const STT_DATA_PORT = 8012;
