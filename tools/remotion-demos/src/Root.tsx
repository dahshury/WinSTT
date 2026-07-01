import { Composition } from "remotion";
import type React from "react";
import {
  ArchitectureFlow,
  AudioVadFlow,
  AutoSubmitDemo,
  DictationLoop,
  HistoryPlayback,
  IntegrationsSecrets,
  LlmDictationDemo,
  LlmTransformDemo,
  MainDemo,
  ModelPickerFlow,
  OverlayDemo,
  QualityPipeline,
  RecordingModeDemo,
  ReplaceDemo,
  TranscribeFileDemo,
  TtsVoiceFlow,
  VisualizerDemo
} from "./scenes";
import { DUR, FPS } from "./theme";

type Demo = {
  id: string;
  component: React.ComponentType;
  width?: number;
  height?: number;
  durationInFrames?: number;
};

const W = 1280;
const H = 720;
const STRIP_W = 1440;
const STRIP_H = 420;

const demos: Demo[] = [
  { id: "main", component: MainDemo },
  { id: "ptt", component: () => <RecordingModeDemo mode="ptt" /> },
  { id: "toggle", component: () => <RecordingModeDemo mode="toggle" /> },
  { id: "listen", component: () => <RecordingModeDemo mode="listen" /> },
  { id: "wakeword", component: () => <RecordingModeDemo mode="wakeword" /> },
  { id: "llm-dictation", component: LlmDictationDemo },
  { id: "llm-transform", component: LlmTransformDemo },
  { id: "auto-submit", component: AutoSubmitDemo },
  { id: "dictionary", component: () => <ReplaceDemo kind="dictionary" /> },
  { id: "snippets", component: () => <ReplaceDemo kind="snippets" /> },
  { id: "transcribe-file", component: TranscribeFileDemo },
  { id: "viz-bar", component: () => <VisualizerDemo kind="bar" /> },
  { id: "viz-grid", component: () => <VisualizerDemo kind="grid" /> },
  { id: "viz-radial", component: () => <VisualizerDemo kind="radial" /> },
  { id: "viz-wave", component: () => <VisualizerDemo kind="wave" /> },
  { id: "viz-aura", component: () => <VisualizerDemo kind="aura" /> },
  {
    id: "overlay-floating",
    component: () => <OverlayDemo kind="floating" />,
    width: STRIP_W,
    height: STRIP_H
  },
  {
    id: "overlay-island",
    component: () => <OverlayDemo kind="island" />,
    width: STRIP_W,
    height: STRIP_H
  },
  { id: "dictation-loop", component: DictationLoop, durationInFrames: 210 },
  { id: "model-picker-flow", component: ModelPickerFlow, durationInFrames: 210 },
  { id: "audio-vad-flow", component: AudioVadFlow, durationInFrames: 210 },
  { id: "quality-pipeline", component: QualityPipeline, durationInFrames: 210 },
  { id: "integrations-secrets", component: IntegrationsSecrets, durationInFrames: 210 },
  { id: "tts-voice-flow", component: TtsVoiceFlow, durationInFrames: 210 },
  { id: "history-playback", component: HistoryPlayback, durationInFrames: 210 },
  { id: "architecture-flow", component: ArchitectureFlow, durationInFrames: 210 }
];

export function RemotionRoot() {
  return (
    <>
      {demos.map(({ id, component, width, height, durationInFrames }) => (
        <Composition
          key={id}
          id={id}
          component={component}
          durationInFrames={durationInFrames ?? DUR}
          fps={FPS}
          width={width ?? W}
          height={height ?? H}
        />
      ))}
    </>
  );
}
