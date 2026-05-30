import { describe, expect, mock, test } from "bun:test";
import { renderHook } from "@testing-library/react";
import type { useSettingsStore } from "@/entities/setting";
import type { OnnxQuantization } from "@/shared/config/defaults";
import { useLockRealtimeToMain } from "./use-lock-realtime-to-main";

type RealtimeChange = (modelId: string, quantization?: OnnxQuantization) => void;
type UpdateQuality = ReturnType<typeof useSettingsStore.getState>["updateQualitySettings"];

interface HookArgs {
	currentRealtimeModel: string | undefined;
	lockRealtimeToMain: boolean;
	realtimeChange: RealtimeChange;
	selectedModel: string;
	updateQuality: UpdateQuality;
	useMainModelFlag: boolean;
}

function renderLock(args: HookArgs) {
	return renderHook(
		(p: HookArgs) =>
			useLockRealtimeToMain(
				p.lockRealtimeToMain,
				p.selectedModel,
				p.currentRealtimeModel,
				p.useMainModelFlag,
				p.realtimeChange,
				p.updateQuality
			),
		{ initialProps: args }
	);
}

describe("useLockRealtimeToMain", () => {
	test("does nothing while the lock is off", () => {
		const realtimeChange = mock<RealtimeChange>(() => undefined);
		const updateQuality = mock<UpdateQuality>(() => undefined);
		renderLock({
			lockRealtimeToMain: false,
			selectedModel: "tiny",
			// Deliberately mismatched + flag off so we'd fire BOTH calls if the
			// guard weren't honoured.
			currentRealtimeModel: "base",
			useMainModelFlag: false,
			realtimeChange,
			updateQuality,
		});
		expect(realtimeChange).not.toHaveBeenCalled();
		expect(updateQuality).not.toHaveBeenCalled();
	});

	test("mirrors the realtime slot to the main model when locked and they differ", () => {
		const realtimeChange = mock<RealtimeChange>(() => undefined);
		const updateQuality = mock<UpdateQuality>(() => undefined);
		renderLock({
			lockRealtimeToMain: true,
			selectedModel: "tiny",
			currentRealtimeModel: "base",
			// Flag already true — only realtimeChange should fire.
			useMainModelFlag: true,
			realtimeChange,
			updateQuality,
		});
		expect(realtimeChange).toHaveBeenCalledTimes(1);
		expect(realtimeChange).toHaveBeenCalledWith("tiny");
		expect(updateQuality).not.toHaveBeenCalled();
	});

	test("does not re-issue a realtime change when slot already mirrors main", () => {
		const realtimeChange = mock<RealtimeChange>(() => undefined);
		const updateQuality = mock<UpdateQuality>(() => undefined);
		renderLock({
			lockRealtimeToMain: true,
			selectedModel: "tiny",
			// Already equal → realtimeChange must NOT fire.
			currentRealtimeModel: "tiny",
			useMainModelFlag: true,
			realtimeChange,
			updateQuality,
		});
		expect(realtimeChange).not.toHaveBeenCalled();
		expect(updateQuality).not.toHaveBeenCalled();
	});

	test("flips the server flag when locked and useMainModelForRealtime is off", () => {
		const realtimeChange = mock<RealtimeChange>(() => undefined);
		const updateQuality = mock<UpdateQuality>(() => undefined);
		renderLock({
			lockRealtimeToMain: true,
			// Already mirrored → realtimeChange must NOT fire, isolating the flag branch.
			selectedModel: "tiny",
			currentRealtimeModel: "tiny",
			useMainModelFlag: false,
			realtimeChange,
			updateQuality,
		});
		expect(realtimeChange).not.toHaveBeenCalled();
		expect(updateQuality).toHaveBeenCalledTimes(1);
		expect(updateQuality).toHaveBeenCalledWith({ useMainModelForRealtime: true });
	});

	test("fires both effects when slot differs AND the flag is off", () => {
		const realtimeChange = mock<RealtimeChange>(() => undefined);
		const updateQuality = mock<UpdateQuality>(() => undefined);
		renderLock({
			lockRealtimeToMain: true,
			selectedModel: "tiny",
			currentRealtimeModel: "base",
			useMainModelFlag: false,
			realtimeChange,
			updateQuality,
		});
		expect(realtimeChange).toHaveBeenCalledWith("tiny");
		expect(updateQuality).toHaveBeenCalledWith({ useMainModelForRealtime: true });
	});

	test("treats an undefined realtime model as a mismatch and mirrors it", () => {
		const realtimeChange = mock<RealtimeChange>(() => undefined);
		const updateQuality = mock<UpdateQuality>(() => undefined);
		renderLock({
			lockRealtimeToMain: true,
			selectedModel: "tiny",
			currentRealtimeModel: undefined,
			useMainModelFlag: true,
			realtimeChange,
			updateQuality,
		});
		expect(realtimeChange).toHaveBeenCalledWith("tiny");
	});

	test("re-runs when the lock flips on after mounting unlocked", () => {
		const realtimeChange = mock<RealtimeChange>(() => undefined);
		const updateQuality = mock<UpdateQuality>(() => undefined);
		const { rerender } = renderLock({
			lockRealtimeToMain: false,
			selectedModel: "tiny",
			currentRealtimeModel: "base",
			useMainModelFlag: false,
			realtimeChange,
			updateQuality,
		});
		expect(realtimeChange).not.toHaveBeenCalled();
		rerender({
			lockRealtimeToMain: true,
			selectedModel: "tiny",
			currentRealtimeModel: "base",
			useMainModelFlag: false,
			realtimeChange,
			updateQuality,
		});
		expect(realtimeChange).toHaveBeenCalledWith("tiny");
		expect(updateQuality).toHaveBeenCalledWith({ useMainModelForRealtime: true });
	});
});
