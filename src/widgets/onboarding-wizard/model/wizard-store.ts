import { create } from "zustand";
import { persist } from "zustand/middleware";
import { providerOf } from "@/entities/cloud-stt-provider";
import {
	type AppSettingsOutput,
	appSettingsSchema,
} from "@/shared/config/settings-schema";

export type OnboardingTrack = "" | "local" | "cloud";

export type OnboardingStepId =
	| "welcome"
	| "stt-model"
	| "capabilities"
	| "mic"
	| "cloud-keys"
	| "llm"
	| "overview";

interface OnboardingWizardState {
	cloudSttReady: boolean;
	currentStep: OnboardingStepId;
	goBack: () => void;
	goNext: () => void;
	goToStep: (step: OnboardingStepId) => void;
	hydrateFromSettings: (settings: AppSettingsOutput) => void;
	hydratedFromSettings: boolean;
	micTestPassed: boolean;
	// Wipe the persisted progress back to the welcome step / unset track. Called
	// when the wizard finishes or is closed so a later forced re-onboarding (or a
	// settings reset) starts clean instead of resuming a stale half-finished run.
	resetProgress: () => void;
	setCloudSttReady: (ready: boolean) => void;
	setMicTestPassed: (passed: boolean) => void;
	// The local STT model choice itself lives in `settings.model`: the onboarding
	// step opens the SAME detached picker Settings uses, which persists + swaps
	// the model. The wizard store only tracks whether that model is downloaded
	// (the Next-button gate).
	setSttModelReady: (ready: boolean) => void;
	sttModelReady: boolean;
	setTrack: (track: OnboardingTrack) => void;
	track: OnboardingTrack;
}

const FULL_FLOW_LOCAL: readonly OnboardingStepId[] = [
	"welcome",
	"stt-model",
	"mic",
	"capabilities",
	"llm",
	"overview",
] as const;
const FULL_FLOW_CLOUD: readonly OnboardingStepId[] = [
	"welcome",
	"cloud-keys",
	"mic",
	"capabilities",
	"llm",
	"overview",
] as const;
const DEFAULT_MODEL_ID = appSettingsSchema.parse({}).model.model;

/** Every known step id across both tracks — used to validate persisted state. */
const ALL_STEP_IDS: readonly OnboardingStepId[] = [
	"welcome",
	"stt-model",
	"capabilities",
	"mic",
	"cloud-keys",
	"llm",
	"overview",
] as const;

function isStepId(value: unknown): value is OnboardingStepId {
	return (
		typeof value === "string" &&
		(ALL_STEP_IDS as readonly string[]).includes(value)
	);
}

function isTrack(value: unknown): value is OnboardingTrack {
	return value === "" || value === "local" || value === "cloud";
}

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

export function inferTrackFromSettings(
	settings: Pick<AppSettingsOutput, "general" | "model">,
): OnboardingTrack {
	const savedTrack = settings.general.onboardedTrack;
	if (savedTrack === "local" || savedTrack === "cloud") {
		return savedTrack;
	}
	const modelId = settings.model.model.trim();
	if (providerOf(modelId) !== null) {
		return "cloud";
	}
	if (modelId !== "" && modelId !== DEFAULT_MODEL_ID) {
		return "local";
	}
	if (!settings.general.onboarded && settings.general.onboardedAt === null) {
		return "";
	}
	return "local";
}

export const useOnboardingWizardStore = create<OnboardingWizardState>()(
	persist(
		(set) => ({
			currentStep: "welcome",
			track: "",
			hydratedFromSettings: false,
			micTestPassed: false,
			sttModelReady: false,
			cloudSttReady: false,
			setTrack: (track) => set({ track }),
			hydrateFromSettings: (settings) =>
				set((s) => {
					if (s.hydratedFromSettings) {
						return s;
					}
					// A persisted track (from a half-finished prior run) wins; otherwise
					// infer it from the saved settings. Then clamp the persisted step to
					// the resolved track's order so inferring a *different* track than
					// the persisted step belonged to can't strand us on a hidden step.
					const track = s.track || inferTrackFromSettings(settings);
					const currentStep = visibleSteps(track).includes(s.currentStep)
						? s.currentStep
						: "welcome";
					return { hydratedFromSettings: true, track, currentStep };
				}),
			setMicTestPassed: (passed) => set({ micTestPassed: passed }),
			setSttModelReady: (ready) => set({ sttModelReady: ready }),
			setCloudSttReady: (ready) => set({ cloudSttReady: ready }),
			resetProgress: () =>
				set({
					currentStep: "welcome",
					track: "",
					hydratedFromSettings: false,
					micTestPassed: false,
					sttModelReady: false,
					cloudSttReady: false,
				}),
			goNext: () =>
				set((s) => ({ currentStep: step(s.currentStep, 1, s.track) })),
			goBack: () =>
				set((s) => ({ currentStep: step(s.currentStep, -1, s.track) })),
			// Jump straight to an earlier step via the step indicator. Only ever
			// navigates *backwards* (or no-ops on the current step): the indicator
			// makes upcoming steps non-interactive, and we re-assert that here so a
			// stray call can't skip a gated step (e.g. the model download) forward.
			goToStep: (target) =>
				set((s) => {
					const order = visibleSteps(s.track);
					const targetIdx = order.indexOf(target);
					const currentIdx = order.indexOf(s.currentStep);
					if (targetIdx < 0 || currentIdx < 0 || targetIdx > currentIdx) {
						return s;
					}
					return { currentStep: target };
				}),
		}),
		{
			name: "winstt-onboarding-progress",
			version: 1,
			// Only the navigation state survives a restart. The readiness gates
			// (mic/STT/cloud) are deliberately NOT persisted — each gated step
			// re-derives them from the real model cache / saved API keys on mount,
			// so a stale "ready" can never let the user finish without the
			// prerequisite actually being met.
			partialize: (state) => ({
				currentStep: state.currentStep,
				track: state.track,
			}),
			// Validate the persisted slice before adopting it: reject unknown step
			// ids / tracks (e.g. after a flow rename) and clamp the step to the
			// resolved track's visible order so the two can never disagree.
			merge: (persisted, current) => {
				const saved = (persisted ?? {}) as Partial<
					Pick<OnboardingWizardState, "currentStep" | "track">
				>;
				const track = isTrack(saved.track) ? saved.track : current.track;
				const savedStep = isStepId(saved.currentStep)
					? saved.currentStep
					: current.currentStep;
				const currentStep = visibleSteps(track).includes(savedStep)
					? savedStep
					: "welcome";
				return { ...current, track, currentStep };
			},
		},
	),
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
