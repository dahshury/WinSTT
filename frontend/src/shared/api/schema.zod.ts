/**
 * AUTO-GENERATED — do not edit by hand.
 * Source: spec/openapi.yaml (string enums under components.schemas).
 * Regenerate via `bun generate`.
 */

import { z } from "zod";

export const AllowedParameterSchema = z.enum([
	"model",
	"language",
	"silero_sensitivity",
	"wake_word_activation_delay",
	"post_speech_silence_duration",
	"listen_start",
	"recording_stop_time",
	"last_transcription_bytes",
	"last_transcription_bytes_b64",
	"speech_end_silence_start",
	"is_recording",
	"use_wake_words",
	"silence_timing",
	"silence_endpoint_enabled",
	"smart_endpoint_enabled",
	"detection_speed",
	"input_device_index",
	"end_of_sentence_detection_pause",
	"mid_sentence_detection_pause",
	"unknown_sentence_detection_pause",
	"initial_prompt",
	"initial_prompt_realtime",
	"onnx_quantization",
	"translate_to_english",
	"model_unload_timeout_seconds",
	"webrtc_sensitivity",
	"silero_deactivity_detection",
	"always_on_microphone",
	"lazy_stream_close",
	"lazy_close_timeout_seconds",
]);
export type AllowedParameter = z.infer<typeof AllowedParameterSchema>;

export const AllowedMethodSchema = z.enum([
	"set_microphone",
	"abort",
	"stop",
	"clear_audio_queue",
	"wakeup",
	"shutdown",
	"text",
	"request_diarization_toggle",
]);
export type AllowedMethod = z.infer<typeof AllowedMethodSchema>;

export const WhisperModelSchema = z.enum([
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
]);
export type WhisperModel = z.infer<typeof WhisperModelSchema>;

export const ComputeTypeSchema = z.enum([
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
]);
export type ComputeType = z.infer<typeof ComputeTypeSchema>;

export const DeviceTypeSchema = z.enum(["auto", "cpu"]);
export type DeviceType = z.infer<typeof DeviceTypeSchema>;

export const AcceleratorTypeSchema = z.enum(["auto", "cuda", "directml", "rocm", "coreml", "cpu"]);
export type AcceleratorType = z.infer<typeof AcceleratorTypeSchema>;

export const RecorderStateSchema = z.enum([
	"inactive",
	"listening",
	"wakeword",
	"recording",
	"transcribing",
]);
export type RecorderState = z.infer<typeof RecorderStateSchema>;

export const TranscriberBackendSchema = z.enum(["faster_whisper", "onnx_asr"]);
export type TranscriberBackend = z.infer<typeof TranscriberBackendSchema>;

export const ModelFamilySchema = z.enum([
	"whisper",
	"lite-whisper",
	"nemo",
	"gigaam",
	"kaldi",
	"t-one",
	"moonshine",
	"cohere",
	"sense_voice",
	"custom",
]);
export type ModelFamily = z.infer<typeof ModelFamilySchema>;

export const LlmProviderSchema = z.enum(["ollama", "openrouter", "apple-intelligence"]);
export type LlmProvider = z.infer<typeof LlmProviderSchema>;

export const LlmPresetKeySchema = z.enum([
	"neutral",
	"formal",
	"friendly",
	"technical",
	"casual",
	"concise",
	"summarize",
	"reorder",
	"restructure",
	"rewordForClarity",
]);
export type LlmPresetKey = z.infer<typeof LlmPresetKeySchema>;

export const LlmPresetLevelSchema = z.enum(["light", "medium", "high"]);
export type LlmPresetLevel = z.infer<typeof LlmPresetLevelSchema>;

export const OllamaPullProgressStatusSchema = z.enum([
	"pulling",
	"downloading",
	"verifying",
	"writing",
	"success",
	"error",
	"cancelled",
]);
export type OllamaPullProgressStatus = z.infer<typeof OllamaPullProgressStatusSchema>;

export const CloudSttProviderSchema = z.enum(["openai", "elevenlabs"]);
export type CloudSttProvider = z.infer<typeof CloudSttProviderSchema>;

export const CloudSttErrorCodeSchema = z.enum([
	"auth",
	"network",
	"key_missing",
	"rate_limit",
	"provider_error",
]);
export type CloudSttErrorCode = z.infer<typeof CloudSttErrorCodeSchema>;

export const FitSeveritySchema = z.enum(["ok", "warning", "critical"]);
export type FitSeverity = z.infer<typeof FitSeveritySchema>;

export const FitTargetSchema = z.enum(["gpu", "cpu", "neither"]);
export type FitTarget = z.infer<typeof FitTargetSchema>;

export const FitReasonSchema = z.enum([
	"exceeds_vram",
	"exceeds_ram",
	"tight_vram",
	"tight_ram",
	"no_gpu_available",
	"requires_cpu_quant",
	"stt_already_uses_gpu",
	"stt_already_uses_ram",
	"unknown_footprint",
	"ok",
]);
export type FitReason = z.infer<typeof FitReasonSchema>;

export const ServerStatusSchema = z.enum(["idle", "starting", "running", "error"]);
export type ServerStatus = z.infer<typeof ServerStatusSchema>;

export const ConnectionStatusSchema = z.enum(["disconnected", "connecting", "connected", "error"]);
export type ConnectionStatus = z.infer<typeof ConnectionStatusSchema>;
