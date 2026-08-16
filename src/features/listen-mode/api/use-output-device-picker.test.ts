import { describe, expect, test } from "bun:test";
import type { OutputDevice } from "@/entities/audio-device";
import type { LoopbackDevice } from "../lib/loopback-devices";
import {
	buildOutputDeviceEntries,
	type OutputDeviceEntry,
	nativeOutputDeviceName,
	outputSelectionPatch,
	resolveCurrentId,
} from "./use-output-device-picker";

function out(deviceId: string, label: string, isDefault = false): OutputDevice {
	return { deviceId, label, isDefault };
}

function loop(index: number, name: string): LoopbackDevice {
	return { index, name, defaultSampleRate: 48_000, maxOutputChannels: 2 };
}

const OUTPUTS: OutputDevice[] = [
	out("sink-speakers", "Speakers (Realtek(R) Audio)", true),
	out("sink-tv", "LG TV (NVIDIA High Definition Audio)"),
	out("default", "Default"), // synthetic Chromium row — dropped
	out("", "Communications"), // empty-id placeholder — dropped
];

const LOOPBACKS: LoopbackDevice[] = [
	loop(0, "Speakers (Realtek(R) Audio)"),
	loop(1, "LG TV (NVIDIA High Definition Audio)"),
];

describe("buildOutputDeviceEntries", () => {
	test("prepends a System-default row and resolves loopback indices by name", () => {
		const entries = buildOutputDeviceEntries({
			devices: OUTPUTS,
			defaultDevice: OUTPUTS[0] ?? null,
			loopbackDevices: LOOPBACKS,
			systemDefaultLabel: "System default",
		});
		expect(entries).toEqual([
			{
				id: "",
				isDefault: true,
				label: "System default (Speakers (Realtek(R) Audio))",
				loopbackIndex: null,
			},
			{
				id: "sink-speakers",
				isDefault: false,
				label: "Speakers (Realtek(R) Audio)",
				loopbackIndex: 0,
			},
			{
				id: "sink-tv",
				isDefault: false,
				label: "LG TV (NVIDIA High Definition Audio)",
				loopbackIndex: 1,
			},
		]);
	});

	test("carries a null loopback index when no backend device matches", () => {
		const entries = buildOutputDeviceEntries({
			devices: [out("sink-bt", "Bluetooth Headset")],
			defaultDevice: null,
			loopbackDevices: LOOPBACKS,
			systemDefaultLabel: "System default",
		});
		expect(entries[1]?.loopbackIndex).toBeNull();
	});
});

describe("outputSelectionPatch", () => {
	const entries: OutputDeviceEntry[] = [
		{ id: "", isDefault: true, label: "System default", loopbackIndex: null },
		{ id: "sink-tv", isDefault: false, label: "LG TV", loopbackIndex: 1 },
	];

	test("writes BOTH the sink id and the resolved loopback index", () => {
		expect(outputSelectionPatch(entries, "sink-tv")).toEqual({
			outputDeviceId: "sink-tv",
			loopbackDeviceIndex: 1,
		});
	});

	test("selecting System default clears the loopback index", () => {
		expect(outputSelectionPatch(entries, "")).toEqual({
			outputDeviceId: "",
			loopbackDeviceIndex: null,
		});
	});

	test("an unknown id degrades to the system-default loopback", () => {
		expect(outputSelectionPatch(entries, "sink-gone")).toEqual({
			outputDeviceId: "sink-gone",
			loopbackDeviceIndex: null,
		});
	});
});

describe("nativeOutputDeviceName", () => {
	const entries: OutputDeviceEntry[] = [
		{ id: "", isDefault: true, label: "System default", loopbackIndex: null },
		{ id: "sink-tv", isDefault: false, label: "LG TV", loopbackIndex: 1 },
	];

	test("routes native chimes by CPAL name and clears to default", () => {
		expect(nativeOutputDeviceName(entries, "sink-tv")).toBe("LG TV");
		expect(nativeOutputDeviceName(entries, "")).toBe("default");
		expect(nativeOutputDeviceName(entries, "unplugged")).toBe("default");
	});
});

describe("resolveCurrentId", () => {
	const entries: OutputDeviceEntry[] = [
		{ id: "", isDefault: true, label: "System default", loopbackIndex: null },
		{ id: "sink-tv", isDefault: false, label: "LG TV", loopbackIndex: 1 },
	];

	test("prefers a matching persisted sink id", () => {
		expect(resolveCurrentId(entries, "sink-tv", null)).toBe("sink-tv");
	});

	test("falls back to the persisted loopback index when the sink id is unresolvable", () => {
		// The detached picker window can't resolve browser sink ids, so the stored
		// `outputDeviceId` matches no entry — the loopback index still pins it.
		expect(resolveCurrentId(entries, "sink-from-other-window", 1)).toBe(
			"sink-tv",
		);
	});

	test("defaults to the System-default row otherwise", () => {
		expect(resolveCurrentId(entries, "", null)).toBe("");
		expect(resolveCurrentId(entries, "nope", 99)).toBe("");
	});
});
