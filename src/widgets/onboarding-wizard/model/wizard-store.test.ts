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
    sttModelId: "",
    sttQuantization: "auto",
    sttModelReady: false,
    cloudSttReady: false,
  });
});

describe("visibleSteps", () => {
  test("cloud track includes the cloud-keys step", () => {
    expect(visibleSteps("cloud")).toEqual([
      "welcome",
      "cloud-keys",
      "capabilities",
      "mic",
      "llm",
    ]);
  });

  test("local track omits cloud-keys", () => {
    expect(visibleSteps("local")).toEqual([
      "welcome",
      "stt-model",
      "capabilities",
      "mic",
      "llm",
    ]);
  });

  test("empty/untracked falls through to the local flow (cloud-keys hidden)", () => {
    // Only the explicit "cloud" track widens the flow; everything else
    // (including the initial "" track) uses the shorter local order.
    expect(visibleSteps("")).toEqual([
      "welcome",
      "stt-model",
      "capabilities",
      "mic",
      "llm",
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
    expect(isLastStep("stt-model", "local")).toBe(false);
    expect(isLastStep("capabilities", "local")).toBe(false);
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
    expect(s.sttModelId).toBe("");
    expect(s.sttQuantization).toBe("auto");
    expect(s.sttModelReady).toBe(false);
    expect(s.cloudSttReady).toBe(false);
  });

  test("factory initial-state literals (mutation guard)", () => {
    expect(INITIAL_STATE.currentStep).toBe("welcome");
    expect(INITIAL_STATE.track).toBe("");
    expect(INITIAL_STATE.micTestPassed).toBe(false);
    expect(INITIAL_STATE.sttModelId).toBe("");
    expect(INITIAL_STATE.sttQuantization).toBe("auto");
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

  test("setSttSelection records the pending local model choice", () => {
    useOnboardingWizardStore.getState().setSttSelection("tiny", "int8");
    const s = useOnboardingWizardStore.getState();
    expect(s.sttModelId).toBe("tiny");
    expect(s.sttQuantization).toBe("int8");
  });

  test("readiness setters update their gates", () => {
    useOnboardingWizardStore.getState().setSttModelReady(true);
    useOnboardingWizardStore.getState().setCloudSttReady(true);
    const s = useOnboardingWizardStore.getState();
    expect(s.sttModelReady).toBe(true);
    expect(s.cloudSttReady).toBe(true);
  });
});

describe("useOnboardingWizardStore — goNext / goBack (local track)", () => {
  test("goNext walks welcome → stt-model → capabilities → mic → llm and clamps at the last step", () => {
    const { goNext } = useOnboardingWizardStore.getState();
    goNext();
    expect(useOnboardingWizardStore.getState().currentStep).toBe("stt-model");
    goNext();
    expect(useOnboardingWizardStore.getState().currentStep).toBe(
      "capabilities",
    );
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
    expect(useOnboardingWizardStore.getState().currentStep).toBe(
      "capabilities",
    );
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
  test("goNext threads through cloud-keys before capabilities", () => {
    useOnboardingWizardStore.setState({
      track: "cloud",
      currentStep: "cloud-keys",
    });
    useOnboardingWizardStore.getState().goNext();
    expect(useOnboardingWizardStore.getState().currentStep).toBe(
      "capabilities",
    );
    useOnboardingWizardStore.getState().goNext();
    expect(useOnboardingWizardStore.getState().currentStep).toBe("mic");
    useOnboardingWizardStore.getState().goNext();
    expect(useOnboardingWizardStore.getState().currentStep).toBe("llm");
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
