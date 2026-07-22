import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import * as realBindings from "@/bindings";
import type { VoiceCatalogPayload } from "@/bindings";

interface PendingCatalogRequest {
	modelId: string | null;
	reject: (reason: unknown) => void;
	resolve: (catalog: VoiceCatalogPayload) => void;
}

const pendingRequests: PendingCatalogRequest[] = [];

function requestVoiceCatalog(
	modelId: string | null,
): Promise<VoiceCatalogPayload> {
	return new Promise((resolve, reject) => {
		pendingRequests.push({ modelId, reject, resolve });
	});
}

mock.module("@/bindings", () => ({
	...realBindings,
	commands: {
		...realBindings.commands,
		ttsListVoices: requestVoiceCatalog,
	},
}));

const { useTtsVoiceCatalog } = await import("./use-tts-voice-catalog");

function catalog(id: string, language = "en"): VoiceCatalogPayload {
	return {
		languages: [{ code: language, label: language.toUpperCase() }],
		voices: [{ id, label: id, language, gender: "female" }],
	};
}

beforeEach(() => {
	pendingRequests.length = 0;
});

afterEach(() => {
	cleanup();
});

describe("useTtsVoiceCatalog", () => {
	test("issues one request per enabled/model lifecycle", () => {
		const update = mock(() => undefined);
		const { rerender } = renderHook(
			({ enabled, modelId, voice }) =>
				useTtsVoiceCatalog(enabled, modelId, voice, update),
			{
				initialProps: { enabled: false, modelId: "kokoro", voice: "af_heart" },
			},
		);

		expect(pendingRequests).toHaveLength(0);
		rerender({ enabled: true, modelId: "kokoro", voice: "af_heart" });
		expect(pendingRequests.map((request) => request.modelId)).toEqual([
			"kokoro",
		]);

		// Changing only the selected voice must not re-fetch the static catalog.
		rerender({ enabled: true, modelId: "kokoro", voice: "af_bella" });
		expect(pendingRequests).toHaveLength(1);

		rerender({ enabled: true, modelId: "kitten", voice: "expr-voice-2-f" });
		expect(pendingRequests.map((request) => request.modelId)).toEqual([
			"kokoro",
			"kitten",
		]);
	});

	test("ignores a stale response after the model changes", async () => {
		const update = mock(() => undefined);
		const { result, rerender } = renderHook(
			({ modelId }) => useTtsVoiceCatalog(true, modelId, "voice-b", update),
			{ initialProps: { modelId: "model-a" } },
		);

		rerender({ modelId: "model-b" });
		await act(async () => {
			pendingRequests[1]?.resolve(catalog("voice-b"));
			await Promise.resolve();
		});
		expect(result.current.voices[0]?.id).toBe("voice-b");

		await act(async () => {
			pendingRequests[0]?.resolve(catalog("voice-a"));
			await Promise.resolve();
		});
		expect(result.current.voices[0]?.id).toBe("voice-b");
	});

	test("keeps the visible catalog when a later command returns empty", async () => {
		const update = mock(() => undefined);
		const { result, rerender } = renderHook(
			({ modelId }) => useTtsVoiceCatalog(true, modelId, "voice-a", update),
			{ initialProps: { modelId: "model-a" } },
		);

		await act(async () => {
			pendingRequests[0]?.resolve(catalog("voice-a"));
			await Promise.resolve();
		});
		expect(result.current.voices[0]?.id).toBe("voice-a");

		rerender({ modelId: "model-b" });
		await act(async () => {
			pendingRequests[1]?.resolve({ languages: [], voices: [] });
			await Promise.resolve();
		});

		expect(result.current.voices[0]?.id).toBe("voice-a");
		expect(pendingRequests).toHaveLength(2);
	});

	test("applies a stale-voice fallback through the latest update callback", async () => {
		const firstUpdate = mock(() => undefined);
		const latestUpdate = mock(() => undefined);
		const { rerender } = renderHook(
			({ update, voice }) => useTtsVoiceCatalog(true, "kokoro", voice, update),
			{ initialProps: { update: firstUpdate, voice: "old-voice" } },
		);

		rerender({ update: latestUpdate, voice: "still-stale" });
		await act(async () => {
			pendingRequests[0]?.resolve(catalog("af_heart"));
			await Promise.resolve();
		});

		expect(firstUpdate).not.toHaveBeenCalled();
		expect(latestUpdate).toHaveBeenCalledWith({
			voice: "af_heart",
			lang: "en",
		});
		expect(pendingRequests).toHaveLength(1);
	});
});
