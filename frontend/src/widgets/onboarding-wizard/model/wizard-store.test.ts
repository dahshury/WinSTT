import { beforeEach, describe, expect, test } from "bun:test";
// Capture the factory's initial state at module-load time, BEFORE any test
// runs setState(), so the snapshot reflects the source literals.
import {
	isFirstStep,
	isLastStep,
	type OnboardingStepId,
	useOnboardingWizardStore,
	visibleSteps,
} from "./wizard-store";

const INITIAL_STATE = useOnboardingWizardStore.getInitialState();

beforeEach(() => {
	useOnboardingWizardStore.setState({
		currentStep: "welcome",
		track: "",
		micTestPassed: false,
		llmPickerOpen: false,
	});
});

describe("visibleSteps", () => {
	test("cloud track includes the cloud-keys step", () => {
		expect(visibleSteps("cloud")).toEqual(["welcome", "mic", "cloud-keys", "llm"]);
	});

	test("local track omits cloud-keys", () => {
		expect(visibleSteps("local")).toEqual(["welcome", "mic", "llm"]);
	});

	test("empty/untracked falls through to the local flow (cloud-keys hidden)", () => {
		// Only the explicit "cloud" track widens the flow; everything else
		// (including the initial "" track) uses the shorter local order.
		expect(visibleSteps("")).toEqual(["welcome", "mic", "llm"]);
	});
});

describe("isFirstStep", () => {
	test("true on welcome, false elsewhere (local track)", () => {
		expect(isFirstStep("welcome", "local")).toBe(true);
		expect(isFirstStep("mic", "local")).toBe(false);
		expect(isFirstStep("llm", "local")).toBe(false);
	});

	test("welcome is still first on the cloud track", () => {
		expect(isFirstStep("welcome", "cloud")).toBe(true);
		expect(isFirstStep("cloud-keys", "cloud")).toBe(false);
	});
});

describe("isLastStep", () => {
	test("llm is last on both tracks; cloud-keys is NOT last on cloud", () => {
		expect(isLastStep("llm", "local")).toBe(true);
		expect(isLastStep("llm", "cloud")).toBe(true);
		expect(isLastStep("cloud-keys", "cloud")).toBe(false);
		expect(isLastStep("mic", "local")).toBe(false);
	});

	test("a step not in the visible order is never the last step", () => {
		// cloud-keys is filtered out of the local order, so .at(-1) ("llm")
		// never equals it.
		expect(isLastStep("cloud-keys", "local")).toBe(false);
	});
});

describe("useOnboardingWizardStore — initial state", () => {
	test("defaults", () => {
		const s = useOnboardingWizardStore.getState();
		expect(s.currentStep).toBe("welcome");
		expect(s.track).toBe("");
		expect(s.micTestPassed).toBe(false);
		expect(s.llmPickerOpen).toBe(false);
	});

	test("factory initial-state literals (mutation guard)", () => {
		expect(INITIAL_STATE.currentStep).toBe("welcome");
		expect(INITIAL_STATE.track).toBe("");
		expect(INITIAL_STATE.micTestPassed).toBe(false);
		expect(INITIAL_STATE.llmPickerOpen).toBe(false);
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

	test("setLlmPickerOpen updates only the flag", () => {
		useOnboardingWizardStore.getState().setLlmPickerOpen(true);
		expect(useOnboardingWizardStore.getState().llmPickerOpen).toBe(true);
	});
});

describe("useOnboardingWizardStore — goNext / goBack (local track)", () => {
	test("goNext walks welcome → mic → llm and clamps at the last step", () => {
		const { goNext } = useOnboardingWizardStore.getState();
		goNext();
		expect(useOnboardingWizardStore.getState().currentStep).toBe("mic");
		goNext();
		expect(useOnboardingWizardStore.getState().currentStep).toBe("llm");
		// Clamp: already on the last step, stays put.
		goNext();
		expect(useOnboardingWizardStore.getState().currentStep).toBe("llm");
	});

	test("goBack walks back and clamps at the first step", () => {
		useOnboardingWizardStore.setState({ currentStep: "llm" });
		const { goBack } = useOnboardingWizardStore.getState();
		goBack();
		expect(useOnboardingWizardStore.getState().currentStep).toBe("mic");
		goBack();
		expect(useOnboardingWizardStore.getState().currentStep).toBe("welcome");
		// Clamp: already first, stays put.
		goBack();
		expect(useOnboardingWizardStore.getState().currentStep).toBe("welcome");
	});
});

describe("useOnboardingWizardStore — goNext / goBack (cloud track)", () => {
	test("goNext threads through the cloud-keys step", () => {
		useOnboardingWizardStore.setState({ track: "cloud", currentStep: "mic" });
		useOnboardingWizardStore.getState().goNext();
		expect(useOnboardingWizardStore.getState().currentStep).toBe("cloud-keys");
		useOnboardingWizardStore.getState().goNext();
		expect(useOnboardingWizardStore.getState().currentStep).toBe("llm");
	});
});

describe("useOnboardingWizardStore — track/step mismatch (defensive)", () => {
	test("goNext from a step not in the active order snaps to the first step", () => {
		// User reached cloud-keys on the cloud track, then switched to local
		// (which has no cloud-keys). indexOf is -1, so step() clamps idx+1 to 0
		// and returns "welcome" — documenting the current defensive behaviour.
		useOnboardingWizardStore.setState({ track: "local", currentStep: "cloud-keys" });
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
