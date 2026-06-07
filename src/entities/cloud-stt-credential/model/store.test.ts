import { beforeEach, describe, expect, test } from "bun:test";
import { useSettingsStore } from "@/entities/setting/@x/cloud-stt-credential";
import { useCredentialStatusStore } from "./store";

// Reset both stores before each test so the module-level `lastKeys` snapshot
// (seeded once at import time) doesn't leak between cases. We're testing the
// public-facing behavior: a key change should flip a non-idle status back
// to idle, but only on the affected provider.
beforeEach(() => {
	window.localStorage.removeItem("winstt-settings");
	useSettingsStore.getState().resetSettings();
	useSettingsStore.getState().updateIntegrations({
		openai: { apiKey: "" },
		elevenlabs: { apiKey: "" },
	});
	useCredentialStatusStore.setState({
		byProvider: {
			openai: { status: "idle" },
			elevenlabs: { status: "idle" },
		},
	});
});

describe("useCredentialStatusStore mutators", () => {
	test("setStatus replaces the entry for a single provider", () => {
		useCredentialStatusStore
			.getState()
			.setStatus("openai", { status: "verified", lastError: undefined });
		const state = useCredentialStatusStore.getState();
		expect(state.byProvider.openai.status).toBe("verified");
		// Other provider untouched.
		expect(state.byProvider.elevenlabs.status).toBe("idle");
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
			.setStatus("openai", { status: "verified" });
		// Mutate the openai key — the module-level subscription should call
		// the sync function, which resets the openai status.
		useSettingsStore
			.getState()
			.updateIntegrations({ openai: { apiKey: "sk-rotated" } });
		expect(useCredentialStatusStore.getState().byProvider.openai.status).toBe(
			"idle",
		);
	});

	test("leaves the other provider's status untouched when only one key changes", () => {
		useCredentialStatusStore
			.getState()
			.setStatus("openai", { status: "verified" });
		useCredentialStatusStore
			.getState()
			.setStatus("elevenlabs", { status: "invalid" });
		useSettingsStore
			.getState()
			.updateIntegrations({ openai: { apiKey: "sk-only" } });
		const state = useCredentialStatusStore.getState();
		expect(state.byProvider.openai.status).toBe("idle");
		// elevenlabs key didn't change → status remains "invalid".
		expect(state.byProvider.elevenlabs.status).toBe("invalid");
	});

	test("does NOT reset a provider whose status is already idle (avoids redundant re-renders)", () => {
		// openai is idle by default; change the key.
		const before = useCredentialStatusStore.getState().byProvider.openai;
		useSettingsStore
			.getState()
			.updateIntegrations({ openai: { apiKey: "sk-changed" } });
		const after = useCredentialStatusStore.getState().byProvider.openai;
		// Reference equality survives because reset() was never called.
		expect(after).toBe(before);
	});

	test("a non-key settings change leaves both statuses untouched", () => {
		useCredentialStatusStore
			.getState()
			.setStatus("openai", { status: "verified" });
		useCredentialStatusStore
			.getState()
			.setStatus("elevenlabs", { status: "offline" });
		// Touch an unrelated setting branch — should not reset either provider.
		useSettingsStore
			.getState()
			.updateGeneralSettings({ recordingMode: "toggle" });
		const state = useCredentialStatusStore.getState();
		expect(state.byProvider.openai.status).toBe("verified");
		expect(state.byProvider.elevenlabs.status).toBe("offline");
	});

	test("an elevenlabs key change resets elevenlabs only", () => {
		useCredentialStatusStore
			.getState()
			.setStatus("elevenlabs", { status: "offline" });
		useCredentialStatusStore
			.getState()
			.setStatus("openai", { status: "verifying" });
		useSettingsStore
			.getState()
			.updateIntegrations({ elevenlabs: { apiKey: "el-new" } });
		const state = useCredentialStatusStore.getState();
		expect(state.byProvider.elevenlabs.status).toBe("idle");
		// openai didn't have its key change → its in-flight verifying stays.
		expect(state.byProvider.openai.status).toBe("verifying");
	});
});
