import { create } from "zustand";

export type OnboardingTrack = "" | "local" | "cloud";

export type OnboardingStepId = "welcome" | "mic" | "cloud-keys" | "llm";

interface OnboardingWizardState {
	currentStep: OnboardingStepId;
	goBack: () => void;
	goNext: () => void;
	/**
	 * Whether the Ollama model-picker dialog is open. The dialog itself
	 * lives in the view (`OnboardingPage`) because it's a sibling-widget
	 * to onboarding-wizard, and widgets can't import siblings. The step
	 * that wants to open it flips this flag; the page reads it to render
	 * the dialog.
	 */
	llmPickerOpen: boolean;
	micTestPassed: boolean;
	setLlmPickerOpen: (open: boolean) => void;
	setMicTestPassed: (passed: boolean) => void;
	setTrack: (track: OnboardingTrack) => void;
	track: OnboardingTrack;
}

const FULL_FLOW_LOCAL: readonly OnboardingStepId[] = ["welcome", "mic", "llm"] as const;
const FULL_FLOW_CLOUD: readonly OnboardingStepId[] = [
	"welcome",
	"mic",
	"cloud-keys",
	"llm",
] as const;

/** Step order, with `cloud-keys` filtered out for users on the local track. */
export function visibleSteps(track: OnboardingTrack): readonly OnboardingStepId[] {
	return track === "cloud" ? FULL_FLOW_CLOUD : FULL_FLOW_LOCAL;
}

function step(current: OnboardingStepId, delta: 1 | -1, track: OnboardingTrack): OnboardingStepId {
	const order = visibleSteps(track);
	const idx = order.indexOf(current);
	const next = Math.min(Math.max(idx + delta, 0), order.length - 1);
	return order[next] ?? current;
}

export const useOnboardingWizardStore = create<OnboardingWizardState>((set) => ({
	currentStep: "welcome",
	track: "",
	micTestPassed: false,
	llmPickerOpen: false,
	setTrack: (track) => set({ track }),
	setMicTestPassed: (passed) => set({ micTestPassed: passed }),
	setLlmPickerOpen: (open) => set({ llmPickerOpen: open }),
	goNext: () => set((s) => ({ currentStep: step(s.currentStep, 1, s.track) })),
	goBack: () => set((s) => ({ currentStep: step(s.currentStep, -1, s.track) })),
}));

/** True when the current step is the last visible step (Finish button time). */
export function isLastStep(current: OnboardingStepId, track: OnboardingTrack): boolean {
	const order = visibleSteps(track);
	return order.at(-1) === current;
}

/** True when the current step is the first visible step (no Back button). */
export function isFirstStep(current: OnboardingStepId, track: OnboardingTrack): boolean {
	const order = visibleSteps(track);
	return order.at(0) === current;
}
