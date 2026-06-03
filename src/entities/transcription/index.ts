export { colorForSpeaker } from "./lib/speaker-color";
export {
  dominantSpeaker,
  speakerCount,
  splitTextBySpeaker,
} from "./lib/speaker-text";
export { SpeakerTextChunks } from "./ui/SpeakerTextChunks";
export type { SpeakerSegment, TranscriptionItem } from "./model/transcription";
export { useTranscriptionStore } from "./model/transcription-store";
