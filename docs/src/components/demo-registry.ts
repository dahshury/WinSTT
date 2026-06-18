/**
 * Demo registry for ComponentPreviewTooltip. Every entry is a short looping
 * .webm in /demos/:
 *   - every clip is a deterministic Remotion render from tools/remotion-demos/.
 *   - clips are app-faithful story demos, using WinSTT's dark palette and UI
 *     patterns while keeping file sizes suitable for docs.
 */
import { createElement, type ComponentType } from "react";
import { DemoVideo } from "./demo-video";

const vid = (src: string): ComponentType => {
  function DemoClip() {
    return createElement(DemoVideo, { src });
  }
  return DemoClip;
};

export const DEMOS: Record<string, ComponentType> = {
  // Core story flows.
  main: vid("main"),
  ptt: vid("ptt"),
  toggle: vid("toggle"),
  listen: vid("listen"),
  wakeword: vid("wakeword"),
  "llm-dictation": vid("llm-dictation"),
  "llm-transform": vid("llm-transform"),
  "auto-submit": vid("auto-submit"),
  dictionary: vid("dictionary"),
  snippets: vid("snippets"),
  "transcribe-file": vid("transcribe-file"),
  // Visual and overlay demos.
  "viz-bar": vid("viz-bar"),
  "viz-grid": vid("viz-grid"),
  "viz-radial": vid("viz-radial"),
  "viz-wave": vid("viz-wave"),
  "viz-aura": vid("viz-aura"),
  "overlay-floating": vid("overlay-floating"),
  "overlay-island": vid("overlay-island"),
  // Larger documentation walkthroughs.
  "dictation-loop": vid("dictation-loop"),
  "model-picker-flow": vid("model-picker-flow"),
  "audio-vad-flow": vid("audio-vad-flow"),
  "quality-pipeline": vid("quality-pipeline"),
  "integrations-secrets": vid("integrations-secrets"),
  "tts-voice-flow": vid("tts-voice-flow"),
  "history-playback": vid("history-playback"),
  "architecture-flow": vid("architecture-flow"),
};
