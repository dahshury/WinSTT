import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	appSettingsSchema,
	type AppSettingsOutput,
} from "@/shared/config/settings-schema";
// Capture the factory's initial state at module-load time, BEFORE any test
// runs setState(), so the snapshot reflects the source literals.
import {
	inferTrackFromSettings,
	isFirstStep,
	isLastStep,
	type OnboardingStepId,
	useOnboardingWizardStore,
	visibleSteps,
} from "./wizard-store";

const INITIAL_STATE = useOnboardingWizardStore.getInitialState();
const STORAGE_KEY = "winstt-onboarding-progress";

type SettingsPatch = Partial<Omit<AppSettingsOutput, "general" | "model">> & {
	general?: Partial<AppSettingsOutput["general"]>;
	model?: Partial<AppSettingsOutput["model"]>;
};

/** Seed the persist store's localStorage slot, mimicking a prior session. */
function seedPersisted(state: { currentStep?: string; track?: string }): void {
	window.localStorage.setItem(
		STORAGE_KEY,
		JSON.stringify({ state, version: 1 }),
	);
}

beforeEach(() => {
	window.localStorage.removeItem(STORAGE_KEY);
	useOnboardingWizardStore.setState({
		currentStep: "welcome",
		track: "",
		hydratedFromSettings: false,
		micTestPassed: false,
		sttModelReady: false,
		cloudSttReady: false,
	});
});

afterEach(() => {
	window.localStorage.removeItem(STORAGE_KEY);
});

function settingsWith(patch: SettingsPatch = {}): AppSettingsOutput {
	const defaults = appSettingsSchema.parse({});
	return appSettingsSchema.parse({
		...defaults,
		...patch,
		general: { ...defaults.general, ...patch.general },
		model: { ...defaults.model, ...patch.model },
	});
}

describe("visibleSteps", () => {
	test("cloud track includes the cloud-keys step", () => {
		expect(visibleSteps("cloud")).toEqual([
			"welcome",
			"cloud-keys",
			"mic",
			"capabilities",
			"llm",
			"overview",
		]);
	});

	test("local track omits cloud-keys", () => {
		expect(visibleSteps("local")).toEqual([
			"welcome",
			"stt-model",
			"mic",
			"capabilities",
			"llm",
			"overview",
		]);
	});

	test("empty/untracked falls through to the local flow (cloud-keys hidden)", () => {
		// Only the explicit "cloud" track widens the flow; everything else
		// (including the initial "" track) uses the shorter local order.
		expect(visibleSteps("")).toEqual([
			"welcome",
			"stt-model",
			"mic",
			"capabilities",
			"llm",
			"overview",
		]);
	});
});

describe("isFirstStep", () => {
	test("true on welcome, false elsewhere (local track)", () => {
		expect(isFirstStep("welcome", "local")).toBe(true);
		expect(isFirstStep("stt-model", "local")).toBe(false);
		expect(isFirstStep("capabilities", "local")).toBe(false);
		expect(isFirstStep("mic", "local")).toBe(false);
		expect(isFirstStep("llm", "local")).toBe(false);
		expect(isFirstStep("overview", "local")).toBe(false);
	});

	test("welcome is still first on the cloud track", () => {
		expect(isFirstStep("welcome", "cloud")).toBe(true);
		expect(isFirstStep("cloud-keys", "cloud")).toBe(false);
	});
});

describe("isLastStep", () => {
	test("overview is last on both tracks; cloud-keys is NOT last on cloud", () => {
		expect(isLastStep("overview", "local")).toBe(true);
		expect(isLastStep("overview", "cloud")).toBe(true);
		expect(isLastStep("llm", "local")).toBe(false);
		expect(isLastStep("llm", "cloud")).toBe(false);
		expect(isLastStep("cloud-keys", "cloud")).toBe(false);
		expect(isLastStep("stt-model", "local")).toBe(false);
		expect(isLastStep("capabilities", "local")).toBe(false);
		expect(isLastStep("mic", "local")).toBe(false);
	});

	test("a step not in the visible order is never the last step", () => {
		// cloud-keys is filtered out of the local order, so .at(-1) ("overview")
		// never equals it.
		expect(isLastStep("cloud-keys", "local")).toBe(false);
	});
});

describe("useOnboardingWizardStore — initial state", () => {
	test("defaults", () => {
		const s = useOnboardingWizardStore.getState();
		expect(s.currentStep).toBe("welcome");
		expect(s.track).toBe("");
		expect(s.hydratedFromSettings).toBe(false);
		expect(s.micTestPassed).toBe(false);
		expect(s.sttModelReady).toBe(false);
		expect(s.cloudSttReady).toBe(false);
	});

	test("factory initial-state literals (mutation guard)", () => {
		expect(INITIAL_STATE.currentStep).toBe("welcome");
		expect(INITIAL_STATE.track).toBe("");
		expect(INITIAL_STATE.hydratedFromSettings).toBe(false);
		expect(INITIAL_STATE.micTestPassed).toBe(false);
		expect(INITIAL_STATE.sttModelReady).toBe(false);
		expect(INITIAL_STATE.cloudSttReady).toBe(false);
	});
});

describe("useOnboardingWizardStore — setters", () => {
	test("setTrack updates only the track", () => {
		useOnboardingWizardStore.getState().setTrack("cloud");
		const s = useOnboardingWizardStore.getState();
		expect(s.track).toBe("cloud");
		expect(s.currentStep).toBe("welcome");
	});

	test("setMicTestPassed updates only the flag", () => {
		useOnboardingWizardStore.getState().setMicTestPassed(true);
		expect(useOnboardingWizardStore.getState().micTestPassed).toBe(true);
	});

	test("readiness setters update their gates", () => {
		useOnboardingWizardStore.getState().setSttModelReady(true);
		useOnboardingWizardStore.getState().setCloudSttReady(true);
		const s = useOnboardingWizardStore.getState();
		expect(s.sttModelReady).toBe(true);
		expect(s.cloudSttReady).toBe(true);
	});
});

describe("inferTrackFromSettings", () => {
	test("uses the persisted onboarded track when present", () => {
		expect(
			inferTrackFromSettings(
				settingsWith({ general: { onboardedTrack: "local" } }),
			),
		).toBe("local");
		expect(
			inferTrackFromSettings(
				settingsWith({ general: { onboardedTrack: "cloud" } }),
			),
		).toBe("cloud");
	});

	test("keeps fresh installs unselected", () => {
		expect(inferTrackFromSettings(settingsWith())).toBe("");
	});

	test("infers cloud from an existing cloud STT model", () => {
		expect(
			inferTrackFromSettings(
				settingsWith({
					model: { model: "elevenlabs:scribe_v1" },
				}),
			),
		).toBe("cloud");
	});

	test("infers local from an existing non-default local STT model", () => {
		expect(
			inferTrackFromSettings(
				settingsWith({ model: { model: "nemo-canary-180m-flash" } }),
			),
		).toBe("local");
	});

	test("infers local from an existing local STT model", () => {
		expect(
			inferTrackFromSettings(
				settingsWith({
					general: { onboarded: true },
					model: { model: "nemo-canary-180m-flash" },
				}),
			),
		).toBe("local");
	});
});

describe("useOnboardingWizardStore — settings hydration", () => {
	test("hydrates the wizard track from loaded settings once", () => {
		useOnboardingWizardStore.getState().hydrateFromSettings(
			settingsWith({
				general: { onboarded: true },
				model: { model: "elevenlabs:scribe_v1" },
			}),
		);

		const s = useOnboardingWizardStore.getState();
		expect(s.hydratedFromSettings).toBe(true);
		expect(s.track).toBe("cloud");
	});

	test("does not overwrite a user-selected track", () => {
		useOnboardingWizardStore.getState().setTrack("cloud");
		useOnboardingWizardStore
			.getState()
			.hydrateFromSettings(
				settingsWith({ general: { onboardedTrack: "local" } }),
			);

		expect(useOnboardingWizardStore.getState().track).toBe("cloud");
	});

	test("does not re-hydrate after the first settings snapshot", () => {
		useOnboardingWizardStore
			.getState()
			.hydrateFromSettings(
				settingsWith({ general: { onboardedTrack: "cloud" } }),
			);
		useOnboardingWizardStore
			.getState()
			.hydrateFromSettings(
				settingsWith({ general: { onboardedTrack: "local" } }),
			);

		expect(useOnboardingWizardStore.getState().track).toBe("cloud");
	});
});

describe("useOnboardingWizardStore — goNext / goBack (local track)", () => {
	test("goNext walks welcome → stt-model → mic → capabilities → llm → overview and clamps at the last step", () => {
		const { goNext } = useOnboardingWizardStore.getState();
		goNext();
		expect(useOnboardingWizardStore.getState().currentStep).toBe("stt-model");
		goNext();
		expect(useOnboardingWizardStore.getState().currentStep).toBe("mic");
		goNext();
		expect(useOnboardingWizardStore.getState().currentStep).toBe(
			"capabilities",
		);
		goNext();
		expect(useOnboardingWizardStore.getState().currentStep).toBe("llm");
		goNext();
		expect(useOnboardingWizardStore.getState().currentStep).toBe("overview");
		// Clamp: already on the last step, stays put.
		goNext();
		expect(useOnboardingWizardStore.getState().currentStep).toBe("overview");
	});

	test("goNext from llm advances to the overview step", () => {
		useOnboardingWizardStore.setState({
			track: "local",
			currentStep: "llm",
		});
		useOnboardingWizardStore.getState().goNext();
		expect(useOnboardingWizardStore.getState().currentStep).toBe("overview");
	});

	test("goBack from overview returns to llm", () => {
		useOnboardingWizardStore.setState({
			track: "local",
			currentStep: "overview",
		});
		useOnboardingWizardStore.getState().goBack();
		expect(useOnboardingWizardStore.getState().currentStep).toBe("llm");
	});

	test("goBack walks back and clamps at the first step", () => {
		useOnboardingWizardStore.setState({ currentStep: "overview" });
		const { goBack } = useOnboardingWizardStore.getState();
		goBack();
		expect(useOnboardingWizardStore.getState().currentStep).toBe("llm");
		goBack();
		expect(useOnboardingWizardStore.getState().currentStep).toBe(
			"capabilities",
		);
		goBack();
		expect(useOnboardingWizardStore.getState().currentStep).toBe("mic");
		goBack();
		expect(useOnboardingWizardStore.getState().currentStep).toBe("stt-model");
		goBack();
		expect(useOnboardingWizardStore.getState().currentStep).toBe("welcome");
		// Clamp: already first, stays put.
		goBack();
		expect(useOnboardingWizardStore.getState().currentStep).toBe("welcome");
	});
});

describe("useOnboardingWizardStore — goNext / goBack (cloud track)", () => {
	test("goNext threads through cloud-keys and mic before capabilities", () => {
		useOnboardingWizardStore.setState({
			track: "cloud",
			currentStep: "cloud-keys",
		});
		useOnboardingWizardStore.getState().goNext();
		expect(useOnboardingWizardStore.getState().currentStep).toBe("mic");
		useOnboardingWizardStore.getState().goNext();
		expect(useOnboardingWizardStore.getState().currentStep).toBe(
			"capabilities",
		);
		useOnboardingWizardStore.getState().goNext();
		expect(useOnboardingWizardStore.getState().currentStep).toBe("llm");
		useOnboardingWizardStore.getState().goNext();
		expect(useOnboardingWizardStore.getState().currentStep).toBe("overview");
	});
});

describe("useOnboardingWizardStore — goToStep (indicator jump-back)", () => {
	test("jumps backwards to an earlier visited step", () => {
		useOnboardingWizardStore.setState({ track: "local", currentStep: "llm" });
		useOnboardingWizardStore.getState().goToStep("capabilities");
		expect(useOnboardingWizardStore.getState().currentStep).toBe("capabilities");
		useOnboardingWizardStore.getState().goToStep("welcome");
		expect(useOnboardingWizardStore.getState().currentStep).toBe("welcome");
	});

	test("clicking the current step is a no-op", () => {
		useOnboardingWizardStore.setState({ track: "local", currentStep: "mic" });
		useOnboardingWizardStore.getState().goToStep("mic");
		expect(useOnboardingWizardStore.getState().currentStep).toBe("mic");
	});

	test("never jumps forward past the current step (gating preserved)", () => {
		useOnboardingWizardStore.setState({
			track: "local",
			currentStep: "stt-model",
		});
		useOnboardingWizardStore.getState().goToStep("llm");
		expect(useOnboardingWizardStore.getState().currentStep).toBe("stt-model");
	});

	test("a target not in the active order is ignored", () => {
		useOnboardingWizardStore.setState({ track: "local", currentStep: "mic" });
		// cloud-keys is filtered out of the local order → indexOf -1 → no-op.
		useOnboardingWizardStore.getState().goToStep("cloud-keys");
		expect(useOnboardingWizardStore.getState().currentStep).toBe("mic");
	});
});

describe("useOnboardingWizardStore — track/step mismatch (defensive)", () => {
	test("goNext from a step not in the active order snaps to the first step", () => {
		// User reached cloud-keys on the cloud track, then switched to local
		// (which has no cloud-keys). indexOf is -1, so step() clamps idx+1 to 0
		// and returns "welcome" — documenting the current defensive behaviour.
		useOnboardingWizardStore.setState({
			track: "local",
			currentStep: "cloud-keys",
		});
		useOnboardingWizardStore.getState().goNext();
		expect(useOnboardingWizardStore.getState().currentStep).toBe("welcome");
	});

	test("goBack from an out-of-order step also snaps to the first step", () => {
		useOnboardingWizardStore.setState({
			track: "local",
			currentStep: "cloud-keys" as OnboardingStepId,
		});
		useOnboardingWizardStore.getState().goBack();
		expect(useOnboardingWizardStore.getState().currentStep).toBe("welcome");
	});
});

describe("useOnboardingWizardStore — resetProgress", () => {
	test("resets navigation + gates back to a fresh first-run state", () => {
		useOnboardingWizardStore.setState({
			track: "cloud",
			currentStep: "llm",
			hydratedFromSettings: true,
			micTestPassed: true,
			sttModelReady: true,
			cloudSttReady: true,
		});
		useOnboardingWizardStore.getState().resetProgress();
		const s = useOnboardingWizardStore.getState();
		expect(s.currentStep).toBe("welcome");
		expect(s.track).toBe("");
		expect(s.hydratedFromSettings).toBe(false);
		expect(s.micTestPassed).toBe(false);
		expect(s.sttModelReady).toBe(false);
		expect(s.cloudSttReady).toBe(false);
	});

	test("clears the persisted navigation slice", () => {
		useOnboardingWizardStore.setState({ track: "cloud", currentStep: "mic" });
		useOnboardingWizardStore.getState().resetProgress();
		const raw = window.localStorage.getItem(STORAGE_KEY);
		expect(raw).not.toBeNull();
		const parsed = JSON.parse(raw ?? "{}") as { state: unknown };
		expect(parsed.state).toEqual({ currentStep: "welcome", track: "" });
	});
});

describe("useOnboardingWizardStore — persistence (partialize)", () => {
	test("writes ONLY the navigation state to localStorage, never the gates", () => {
		useOnboardingWizardStore.setState({
			currentStep: "mic",
			track: "cloud",
			micTestPassed: true,
			sttModelReady: true,
			cloudSttReady: true,
		});
		const parsed = JSON.parse(
			window.localStorage.getItem(STORAGE_KEY) ?? "{}",
		) as { state: unknown };
		expect(parsed.state).toEqual({ currentStep: "mic", track: "cloud" });
	});
});

describe("useOnboardingWizardStore — rehydration (merge)", () => {
	test("restores a valid persisted step + track", async () => {
		seedPersisted({ currentStep: "mic", track: "cloud" });
		await useOnboardingWizardStore.persist.rehydrate();
		const s = useOnboardingWizardStore.getState();
		expect(s.currentStep).toBe("mic");
		expect(s.track).toBe("cloud");
	});

	test("rejects an unknown persisted step id (falls back to welcome)", async () => {
		seedPersisted({ currentStep: "bogus-step", track: "local" });
		await useOnboardingWizardStore.persist.rehydrate();
		expect(useOnboardingWizardStore.getState().currentStep).toBe("welcome");
		expect(useOnboardingWizardStore.getState().track).toBe("local");
	});

	test("rejects an unknown persisted track", async () => {
		seedPersisted({ currentStep: "mic", track: "sideways" });
		await useOnboardingWizardStore.persist.rehydrate();
		// Invalid track ignored → keeps the current ("") track; "mic" is valid
		// in the local flow that "" resolves to, so the step survives.
		expect(useOnboardingWizardStore.getState().track).toBe("");
		expect(useOnboardingWizardStore.getState().currentStep).toBe("mic");
	});

	test("clamps a persisted step that is hidden on the persisted track", async () => {
		// cloud-keys does not exist in the local flow → must not strand there.
		seedPersisted({ currentStep: "cloud-keys", track: "local" });
		await useOnboardingWizardStore.persist.rehydrate();
		expect(useOnboardingWizardStore.getState().currentStep).toBe("welcome");
		expect(useOnboardingWizardStore.getState().track).toBe("local");
	});
});

describe("useOnboardingWizardStore — hydrateFromSettings with restored progress", () => {
	test("a restored track wins over what settings would infer", () => {
		useOnboardingWizardStore.setState({ track: "cloud", currentStep: "mic" });
		useOnboardingWizardStore
			.getState()
			.hydrateFromSettings(
				settingsWith({ model: { model: "nemo-canary-180m-flash" } }),
			);
		const s = useOnboardingWizardStore.getState();
		expect(s.track).toBe("cloud");
		expect(s.currentStep).toBe("mic");
	});

	test("clamps the restored step when the track is inferred from settings", () => {
		// No restored track (""), but a restored cloud-only step. Settings infer
		// "local" (a non-default local model), where cloud-keys is hidden — the
		// step must clamp to welcome rather than render a hidden step.
		useOnboardingWizardStore.setState({ track: "", currentStep: "cloud-keys" });
		useOnboardingWizardStore
			.getState()
			.hydrateFromSettings(
				settingsWith({ model: { model: "nemo-canary-180m-flash" } }),
			);
		const s = useOnboardingWizardStore.getState();
		expect(s.track).toBe("local");
		expect(s.currentStep).toBe("welcome");
	});
});
