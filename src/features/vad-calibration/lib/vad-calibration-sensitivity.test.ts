import { describe, expect, test } from "bun:test";
import type { AudioDevice } from "@/entities/audio-device";
import { nextSensitivityForDevice, resolveCurrentDeviceName } from "./vad-calibration-sensitivity";

function dev(index: number, name: string, isDefault = false): AudioDevice {
	return { index, name, isDefault } as AudioDevice;
}

describe("resolveCurrentDeviceName", () => {
	test("null while device list is empty (loading)", () => {
		expect(resolveCurrentDeviceName(null, [], null)).toBeNull();
		expect(resolveCurrentDeviceName(2, [], null)).toBeNull();
	});

	test("explicit index → matching device's name", () => {
		const list = [dev(1, "Mic A"), dev(2, "Mic B", true)];
		expect(resolveCurrentDeviceName(2, list, list[1] ?? null)).toBe("Mic B");
		expect(resolveCurrentDeviceName(1, list, list[1] ?? null)).toBe("Mic A");
	});

	test("explicit index not in list → null", () => {
		const list = [dev(1, "Mic A")];
		expect(resolveCurrentDeviceName(99, list, list[0] ?? null)).toBeNull();
	});

	test("null index → system default's name", () => {
		const list = [dev(1, "Mic A"), dev(2, "Mic B", true)];
		expect(resolveCurrentDeviceName(null, list, list[1] ?? null)).toBe("Mic B");
	});

	test("null index with no default device → null", () => {
		const list = [dev(1, "Mic A")];
		expect(resolveCurrentDeviceName(null, list, null)).toBeNull();
	});
});

describe("nextSensitivityForDevice", () => {
	test("null when device name unknown", () => {
		expect(nextSensitivityForDevice(null, 0.4, { "Mic A": 0.6 })).toBeNull();
	});

	test("null when map has no entry for this device", () => {
		expect(nextSensitivityForDevice("Mic A", 0.4, { "Mic B": 0.6 })).toBeNull();
		expect(nextSensitivityForDevice("Mic A", 0.4, undefined)).toBeNull();
		expect(nextSensitivityForDevice("Mic A", 0.4, {})).toBeNull();
	});

	test("null when persisted value equals current (no-op)", () => {
		expect(nextSensitivityForDevice("Mic A", 0.5, { "Mic A": 0.5 })).toBeNull();
	});

	test("returns persisted value when it differs from current", () => {
		expect(nextSensitivityForDevice("Mic A", 0.4, { "Mic A": 0.6 })).toBe(0.6);
	});

	test("treats undefined current as 'not equal' to a persisted value", () => {
		expect(nextSensitivityForDevice("Mic A", undefined, { "Mic A": 0.6 })).toBe(0.6);
	});
});
