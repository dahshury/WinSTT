import { create } from "zustand";

export type OnboardingTrack = "" | "local" | "cloud";

export type OnboardingStepId =
  | "welcome"
  | "stt-model"
  | "capabilities"
  | "mic"
  | "cloud-keys"
  | "llm";

interface OnboardingWizardState {
  cloudSttReady: boolean;
  currentStep: OnboardingStepId;
  goBack: () => void;
  goNext: () => void;
  micTestPassed: boolean;
  setCloudSttReady: (ready: boolean) => void;
  setMicTestPassed: (passed: boolean) => void;
  setSttModelReady: (ready: boolean) => void;
  setSttSelection: (modelId: string, quantization: string) => void;
  sttModelId: string;
  sttModelReady: boolean;
  sttQuantization: string;
  setTrack: (track: OnboardingTrack) => void;
  track: OnboardingTrack;
}

const FULL_FLOW_LOCAL: readonly OnboardingStepId[] = [
  "welcome",
  "stt-model",
  "capabilities",
  "mic",
  "llm",
] as const;
const FULL_FLOW_CLOUD: readonly OnboardingStepId[] = [
  "welcome",
  "cloud-keys",
  "capabilities",
  "mic",
  "llm",
] as const;

/** Step order, with `cloud-keys` filtered out for users on the local track. */
export function visibleSteps(
  track: OnboardingTrack,
): readonly OnboardingStepId[] {
  return track === "cloud" ? FULL_FLOW_CLOUD : FULL_FLOW_LOCAL;
}

function step(
  current: OnboardingStepId,
  delta: 1 | -1,
  track: OnboardingTrack,
): OnboardingStepId {
  const order = visibleSteps(track);
  const idx = order.indexOf(current);
  const next = Math.min(Math.max(idx + delta, 0), order.length - 1);
  return order[next] ?? current;
}

export const useOnboardingWizardStore = create<OnboardingWizardState>(
  (set) => ({
    currentStep: "welcome",
    track: "",
    micTestPassed: false,
    sttModelId: "",
    sttQuantization: "auto",
    sttModelReady: false,
    cloudSttReady: false,
    setTrack: (track) => set({ track }),
    setMicTestPassed: (passed) => set({ micTestPassed: passed }),
    setSttSelection: (modelId, quantization) =>
      set({ sttModelId: modelId, sttQuantization: quantization }),
    setSttModelReady: (ready) => set({ sttModelReady: ready }),
    setCloudSttReady: (ready) => set({ cloudSttReady: ready }),
    goNext: () =>
      set((s) => ({ currentStep: step(s.currentStep, 1, s.track) })),
    goBack: () =>
      set((s) => ({ currentStep: step(s.currentStep, -1, s.track) })),
  }),
);

/** True when the current step is the last visible step (Finish button time). */
export function isLastStep(
  current: OnboardingStepId,
  track: OnboardingTrack,
): boolean {
  const order = visibleSteps(track);
  return order.at(-1) === current;
}

/** True when the current step is the first visible step (no Back button). */
export function isFirstStep(
  current: OnboardingStepId,
  track: OnboardingTrack,
): boolean {
  const order = visibleSteps(track);
  return order.at(0) === current;
}
