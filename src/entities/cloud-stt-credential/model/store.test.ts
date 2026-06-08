import { beforeEach, describe, expect, test } from "bun:test";
import { useSettingsStore } from "@/entities/setting/@x/cloud-stt-credential";
import { useCredentialStatusStore } from "./store";

// Reset both stores before each test so the module-level `lastKeys` snapshot
// (seeded once at import time) doesn't leak between cases. We're testing the
// public-facing behavior: a key change should flip a non-idle status back
// to idle. ElevenLabs is the only integrations-backed cloud STT provider
// (OpenAI was removed; OpenRouter STT reuses the LLM key, not integrations).
beforeEach(() => {
	window.localStorage.removeItem("winstt-settings");
	useSettingsStore.getState().resetSettings();
	useSettingsStore.getState().updateIntegrations({
		elevenlabs: { apiKey: "" },
	});
	useCredentialStatusStore.setState({
		byProvider: {
			elevenlabs: { status: "idle" },
		},
	});
});

describe("useCredentialStatusStore mutators", () => {
	test("setStatus replaces the entry for a single provider", () => {
		useCredentialStatusStore
			.getState()
			.setStatus("elevenlabs", { status: "verified", lastError: undefined });
		const state = useCredentialStatusStore.getState();
		expect(state.byProvider.elevenlabs.status).toBe("verified");
	});

	test("reset flips a provider back to idle", () => {
		useCredentialStatusStore
			.getState()
			.setStatus("elevenlabs", { status: "invalid" });
		useCredentialStatusStore.getState().reset("elevenlabs");
		expect(
			useCredentialStatusStore.getState().byProvider.elevenlabs.status,
		).toBe("idle");
	});
});

describe("syncOnSettingsChange (settings subscription)", () => {
	test("flips a non-idle provider back to idle when its apiKey changes", () => {
		// Prime the verifier state to a non-idle status.
		useCredentialStatusStore
			.getState()
			.setStatus("elevenlabs", { status: "verified" });
		// Mutate the elevenlabs key — the module-level subscription should call
		// the sync function, which resets the elevenlabs status.
		useSettingsStore
			.getState()
			.updateIntegrations({ elevenlabs: { apiKey: "el-rotated" } });
		expect(
			useCredentialStatusStore.getState().byProvider.elevenlabs.status,
		).toBe("idle");
	});

	test("does NOT reset a provider whose status is already idle (avoids redundant re-renders)", () => {
		// elevenlabs is idle by default; change the key.
		const before = useCredentialStatusStore.getState().byProvider.elevenlabs;
		useSettingsStore
			.getState()
			.updateIntegrations({ elevenlabs: { apiKey: "el-changed" } });
		const after = useCredentialStatusStore.getState().byProvider.elevenlabs;
		// Reference equality survives because reset() was never called.
		expect(after).toBe(before);
	});

	test("a non-key settings change leaves the status untouched", () => {
		useCredentialStatusStore
			.getState()
			.setStatus("elevenlabs", { status: "verified" });
		// Touch an unrelated setting branch — should not reset the provider.
		useSettingsStore
			.getState()
			.updateGeneralSettings({ recordingMode: "toggle" });
		const state = useCredentialStatusStore.getState();
		expect(state.byProvider.elevenlabs.status).toBe("verified");
	});

	test("an elevenlabs key change resets elevenlabs", () => {
		useCredentialStatusStore
			.getState()
			.setStatus("elevenlabs", { status: "offline" });
		useSettingsStore
			.getState()
			.updateIntegrations({ elevenlabs: { apiKey: "el-new" } });
		const state = useCredentialStatusStore.getState();
		expect(state.byProvider.elevenlabs.status).toBe("idle");
	});
});
