import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { DEFAULT_SETTINGS, useSettingsStore } from "@/entities/setting";
import type { AppSettingsOutput } from "@/shared/config/settings-schema";
import { useCloudKeyRemovalGuard } from "./use-cloud-key-removal-guard";

// Build a settings object whose active main model + provider keys we control.
// Everything else stays at the schema defaults.
function settings(opts: {
	model: string;
	openaiKey?: string;
	elevenlabsKey?: string;
}): AppSettingsOutput {
	return {
		...DEFAULT_SETTINGS,
		model: { ...DEFAULT_SETTINGS.model, model: opts.model },
		integrations: {
			openai: { ...DEFAULT_SETTINGS.integrations.openai, apiKey: opts.openaiKey ?? "" },
			elevenlabs: {
				...DEFAULT_SETTINGS.integrations.elevenlabs,
				apiKey: opts.elevenlabsKey ?? "",
			},
		},
	};
}

function seed(opts: { model: string; openaiKey?: string; elevenlabsKey?: string }): void {
	useSettingsStore.setState({ settings: settings(opts), isLoaded: true });
}

beforeEach(() => {
	// Reset to a clean local STT model with empty keys before each test so the
	// hook mounts in a neutral state.
	seed({ model: "tiny" });
});

afterEach(() => {
	cleanup();
	useSettingsStore.setState({ settings: DEFAULT_SETTINGS, isLoaded: true });
});

describe("useCloudKeyRemovalGuard", () => {
	test("no notice on a stable cloud model with a present key", async () => {
		seed({ model: "openai:whisper-1", openaiKey: "sk-abc" });
		const { result } = renderHook(() => useCloudKeyRemovalGuard());
		// Let both effects settle; nothing changed, so no transition is detected.
		await act(async () => {
			await new Promise((r) => setTimeout(r, 0));
		});
		expect(result.current).toBeNull();
	});

	test("no notice for a local model regardless of key edits", async () => {
		seed({ model: "tiny", openaiKey: "sk-abc" });
		const { result } = renderHook(() => useCloudKeyRemovalGuard());
		act(() => {
			seed({ model: "tiny", openaiKey: "" });
		});
		await act(async () => {
			await new Promise((r) => setTimeout(r, 0));
		});
		// model never starts with "openai:" so the non-empty → empty transition
		// is ignored.
		expect(result.current).toBeNull();
	});

	test("surfaces an openai notice when the active openai model's key is cleared", async () => {
		seed({ model: "openai:whisper-1", openaiKey: "sk-abc" });
		const { result } = renderHook(() => useCloudKeyRemovalGuard());
		act(() => {
			seed({ model: "openai:whisper-1", openaiKey: "" });
		});
		await waitFor(() => expect(result.current?.provider).toBe("openai"));
		expect(typeof result.current?.timestamp).toBe("number");
	});

	test("surfaces an elevenlabs notice when the active elevenlabs model's key is cleared", async () => {
		seed({ model: "elevenlabs:scribe_v1", elevenlabsKey: "el-xyz" });
		const { result } = renderHook(() => useCloudKeyRemovalGuard());
		act(() => {
			seed({ model: "elevenlabs:scribe_v1", elevenlabsKey: "" });
		});
		await waitFor(() => expect(result.current?.provider).toBe("elevenlabs"));
	});

	test("does NOT fire when the cleared key belongs to a non-active provider", async () => {
		// Active model is openai; we clear the ELEVENLABS key. Only the provider
		// matching the active model's prefix should trip the notice.
		seed({ model: "openai:whisper-1", openaiKey: "sk-abc", elevenlabsKey: "el-xyz" });
		const { result } = renderHook(() => useCloudKeyRemovalGuard());
		act(() => {
			seed({ model: "openai:whisper-1", openaiKey: "sk-abc", elevenlabsKey: "" });
		});
		await act(async () => {
			await new Promise((r) => setTimeout(r, 0));
		});
		expect(result.current).toBeNull();
	});

	test("treats a whitespace-only previous key as 'no real key' (no false positive)", async () => {
		// prevKey.trim() must be non-empty for the transition to count. A key of
		// "   " cleared to "" is NOT a real removal of a usable key.
		seed({ model: "openai:whisper-1", openaiKey: "   " });
		const { result } = renderHook(() => useCloudKeyRemovalGuard());
		act(() => {
			seed({ model: "openai:whisper-1", openaiKey: "" });
		});
		await act(async () => {
			await new Promise((r) => setTimeout(r, 0));
		});
		expect(result.current).toBeNull();
	});

	test("auto-clears the notice once the user RESTORES the openai key", async () => {
		seed({ model: "openai:whisper-1", openaiKey: "sk-abc" });
		const { result } = renderHook(() => useCloudKeyRemovalGuard());
		act(() => {
			seed({ model: "openai:whisper-1", openaiKey: "" });
		});
		await waitFor(() => expect(result.current?.provider).toBe("openai"));
		// Restore a key — the precondition (empty key on the active provider) is gone.
		act(() => {
			seed({ model: "openai:whisper-1", openaiKey: "sk-new" });
		});
		await waitFor(() => expect(result.current).toBeNull());
	});

	test("auto-clears the notice once the user SWITCHES away from the cloud model", async () => {
		seed({ model: "openai:whisper-1", openaiKey: "sk-abc" });
		const { result } = renderHook(() => useCloudKeyRemovalGuard());
		act(() => {
			seed({ model: "openai:whisper-1", openaiKey: "" });
		});
		await waitFor(() => expect(result.current?.provider).toBe("openai"));
		// Switch to a local model — `cleared` (!model.startsWith("openai:")) fires.
		act(() => {
			seed({ model: "tiny", openaiKey: "" });
		});
		await waitFor(() => expect(result.current).toBeNull());
	});

	test("auto-clears an elevenlabs notice when its key is restored (restored branch for elevenlabs)", async () => {
		seed({ model: "elevenlabs:scribe_v1", elevenlabsKey: "el-xyz" });
		const { result } = renderHook(() => useCloudKeyRemovalGuard());
		act(() => {
			seed({ model: "elevenlabs:scribe_v1", elevenlabsKey: "" });
		});
		await waitFor(() => expect(result.current?.provider).toBe("elevenlabs"));
		act(() => {
			seed({ model: "elevenlabs:scribe_v1", elevenlabsKey: "el-new" });
		});
		await waitFor(() => expect(result.current).toBeNull());
	});

	test("a whitespace-only RESTORED key does NOT clear the notice (restore must be a real key)", async () => {
		// The auto-clear's `restored` check uses key.trim() !== "". A key of "  "
		// is not a usable restoration, so the broken-pick notice must persist.
		seed({ model: "openai:whisper-1", openaiKey: "sk-abc" });
		const { result } = renderHook(() => useCloudKeyRemovalGuard());
		act(() => {
			seed({ model: "openai:whisper-1", openaiKey: "" });
		});
		await waitFor(() => expect(result.current?.provider).toBe("openai"));
		act(() => {
			seed({ model: "openai:whisper-1", openaiKey: "   " });
		});
		await act(async () => {
			await new Promise((r) => setTimeout(r, 0));
		});
		expect(result.current?.provider).toBe("openai");
	});
});
