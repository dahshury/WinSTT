import { describe, expect, test } from "bun:test";
import type { AudioDevice } from "@/entities/audio-device";
import { buildTrayDeviceOptions } from "./tray-device-options";

function makeDevice(index: number, name: string, isDefault = false): AudioDevice {
	return { index, name, isDefault, defaultSampleRate: 44_100, maxInputChannels: 2 };
}

describe("buildTrayDeviceOptions", () => {
	test("returns only default option when device list is empty", () => {
		const result = buildTrayDeviceOptions([], null, null, "System Default");
		expect(result.deviceOptions).toHaveLength(1);
		expect(result.deviceOptions[0]?.id).toBe("default");
		expect(result.currentDeviceId).toBe("default");
		expect(result.currentDeviceLabel).toBe("System Default");
	});

	test("includes real devices in options", () => {
		const devices = [makeDevice(0, "Built-in Mic"), makeDevice(1, "USB Headset")];
		const result = buildTrayDeviceOptions(devices, null, null, "System Default");
		expect(result.deviceOptions).toHaveLength(3);
		expect(result.deviceOptions[1]?.label).toBe("Built-in Mic");
		expect(result.deviceOptions[2]?.label).toBe("USB Headset");
	});

	test("deduplicates devices with the same name (case-insensitive trim)", () => {
		const devices = [
			makeDevice(0, "Built-in Mic"), // MME
			makeDevice(1, "Built-in Mic"), // WASAPI duplicate
			makeDevice(2, "USB Headset"),
		];
		const result = buildTrayDeviceOptions(devices, null, null, "System Default");
		// Should have: default + Built-in Mic + USB Headset (3 total, not 4)
		expect(result.deviceOptions).toHaveLength(3);
	});

	test("when a duplicate device is selected, uses the selected index as the canonical id", () => {
		const devices = [
			makeDevice(0, "Built-in Mic"),
			makeDevice(1, "Built-in Mic"), // duplicate
		];
		// User selected index 1 (the WASAPI version of the same mic)
		const result = buildTrayDeviceOptions(devices, null, 1, "System Default");
		// The first seen entry for "Built-in Mic" should get id="1" (the selected index)
		const builtInOpt = result.deviceOptions.find((o) => o.label === "Built-in Mic");
		expect(builtInOpt?.id).toBe("1");
		expect(result.currentDeviceId).toBe("1");
	});

	test("resolves currentDeviceLabel from the found option", () => {
		const devices = [makeDevice(3, "Realtek Audio")];
		const result = buildTrayDeviceOptions(devices, null, 3, "System Default");
		expect(result.currentDeviceLabel).toBe("Realtek Audio");
		expect(result.currentDeviceId).toBe("3");
	});

	test("falls back to defaultLabel for currentDeviceLabel when id is not found", () => {
		const result = buildTrayDeviceOptions([], null, 99, "System Default");
		// index 99 not in the list → currentDeviceId="99" but no matching opt → fallback
		expect(result.currentDeviceLabel).toBe("System Default");
	});

	test("deduplication: non-matching device name gets its own index as id", () => {
		// inputDeviceIndex=0 → selectedName="Mic A". Device at index=1 is "Mic B" (no match) → gets id="1"
		const devices = [makeDevice(0, "Mic A"), makeDevice(1, "Mic B")];
		const result = buildTrayDeviceOptions(devices, null, 0, "System Default");
		const micB = result.deviceOptions.find((o) => o.label === "Mic B");
		expect(micB?.id).toBe("1");
	});

	test("deduplication: duplicate names are skipped after first occurrence", () => {
		const devices = [
			makeDevice(0, "Realtek"), // first
			makeDevice(1, "Realtek"), // duplicate — should be skipped
			makeDevice(2, "USB Mic"),
		];
		const result = buildTrayDeviceOptions(devices, null, null, "System Default");
		// default + Realtek (first occurrence only) + USB Mic = 3
		expect(result.deviceOptions).toHaveLength(3);
		expect(result.deviceOptions.filter((o) => o.label === "Realtek")).toHaveLength(1);
	});

	test("dedup is case-INSENSITIVE (mixed-case duplicates collapse)", () => {
		// Mutating .toLowerCase() to .toUpperCase() does NOT change correctness
		// because case is normalized either way. But mutating to OMIT the
		// .toLowerCase() entirely (raw d.name) would treat "Mic" and "mic" as
		// distinct keys.
		const devices = [makeDevice(0, "Mic"), makeDevice(1, "mic"), makeDevice(2, "MIC")];
		const result = buildTrayDeviceOptions(devices, null, null, "System Default");
		// default + 1 mic = 2 (all three "mic" variants collapse)
		expect(result.deviceOptions).toHaveLength(2);
	});

	test("dedup uses .trim() — leading/trailing whitespace duplicates collapse", () => {
		// Mutating to remove .trim() (raw d.name without whitespace stripping)
		// would treat "Mic" and " Mic " as distinct.
		const devices = [makeDevice(0, "Mic"), makeDevice(1, "  Mic  "), makeDevice(2, " mic ")];
		const result = buildTrayDeviceOptions(devices, null, null, "System Default");
		expect(result.deviceOptions).toHaveLength(2);
	});

	test("when inputDeviceIndex is null, no name resolution is attempted (early-return guard)", () => {
		// L39 mutation: `if (inputDeviceIndex == null) return null` → `false`
		// makes the function always try to find. With null and no matching index,
		// the result is the same. Distinguish by passing a device that would be
		// at index=null… not possible since index is number. Equivalent.
		// Test the documented behavior: null index → all dedup uses d.index as id.
		const devices = [makeDevice(0, "MicA"), makeDevice(1, "MicB")];
		const result = buildTrayDeviceOptions(devices, null, null, "System Default");
		// IDs come from device's own index when no selection.
		const ids = result.deviceOptions.map((o) => o.id);
		expect(ids).toEqual(["default", "0", "1"]);
	});
});
