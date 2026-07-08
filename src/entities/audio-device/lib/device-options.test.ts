import { describe, expect, test } from "bun:test";
import {
	BluetoothConnectedIcon,
	CameraMicrophone01Icon,
	ComputerIcon,
	HeadsetIcon,
	LaptopIcon,
	Mic01Icon,
	MixerIcon,
	UsbConnected01Icon,
} from "@hugeicons/core-free-icons";
import type { AudioDevice } from "../model/audio-device";
import {
	buildInputDeviceOptions,
	inputDeviceIconForName,
	priorityFromReorderedOptions,
	promoteDeviceNameToTop,
	resolveEffectivePriorityDeviceIndex,
} from "./device-options";

function makeDevice(
	index: number,
	name: string,
	isDefault = false,
): AudioDevice {
	return {
		index,
		name,
		isDefault,
		defaultSampleRate: 44_100,
		maxInputChannels: 2,
	};
}

describe("buildInputDeviceOptions", () => {
	test("returns only default option when device list is empty", () => {
		const result = buildInputDeviceOptions([], null, "System Default");
		expect(result.deviceOptions).toHaveLength(1);
		expect(result.deviceOptions[0]?.id).toBe("default");
		expect(result.deviceOptions[0]?.icon).toBe(ComputerIcon);
		expect(result.currentDeviceId).toBe("default");
		expect(result.currentDeviceLabel).toBe("System Default");
	});

	test("includes real devices in options", () => {
		const devices = [
			makeDevice(0, "Built-in Mic"),
			makeDevice(1, "USB Headset"),
		];
		const result = buildInputDeviceOptions(devices, null, "System Default");
		expect(result.deviceOptions).toHaveLength(3);
		expect(result.deviceOptions[1]?.label).toBe("Built-in Mic");
		expect(result.deviceOptions[1]?.icon).toBe(LaptopIcon);
		expect(result.deviceOptions[2]?.label).toBe("USB Headset");
		expect(result.deviceOptions[2]?.icon).toBe(HeadsetIcon);
	});

	test("uses the actual default device name to pick the system-default row icon", () => {
		const result = buildInputDeviceOptions(
			[],
			null,
			"System Default (USB Mic)",
			"USB Mic",
		);
		expect(result.deviceOptions[0]?.icon).toBe(UsbConnected01Icon);
	});

	test("maps common input device names to suitable icons", () => {
		expect(inputDeviceIconForName("Bluetooth Headset")).toBe(
			BluetoothConnectedIcon,
		);
		expect(inputDeviceIconForName("USB Condenser Mic")).toBe(
			UsbConnected01Icon,
		);
		expect(inputDeviceIconForName("Integrated Camera Microphone")).toBe(
			CameraMicrophone01Icon,
		);
		expect(inputDeviceIconForName("Scarlett 2i2 USB")).toBe(MixerIcon);
		expect(inputDeviceIconForName("Built-in Microphone Array")).toBe(
			LaptopIcon,
		);
		expect(inputDeviceIconForName("Studio Microphone")).toBe(Mic01Icon);
	});

	test("deduplicates devices with the same name (case-insensitive trim)", () => {
		const devices = [
			makeDevice(0, "Built-in Mic"), // MME
			makeDevice(1, "Built-in Mic"), // WASAPI duplicate
			makeDevice(2, "USB Headset"),
		];
		const result = buildInputDeviceOptions(devices, null, "System Default");
		// Should have: default + Built-in Mic + USB Headset (3 total, not 4)
		expect(result.deviceOptions).toHaveLength(3);
	});

	test("when a duplicate device is selected, uses the selected index as the canonical id", () => {
		const devices = [
			makeDevice(0, "Built-in Mic"),
			makeDevice(1, "Built-in Mic"), // duplicate
		];
		// User selected index 1 (the WASAPI version of the same mic)
		const result = buildInputDeviceOptions(devices, 1, "System Default");
		// The first seen entry for "Built-in Mic" should get id="1" (the selected index)
		const builtInOpt = result.deviceOptions.find(
			(o) => o.label === "Built-in Mic",
		);
		expect(builtInOpt?.id).toBe("1");
		expect(result.currentDeviceId).toBe("1");
	});

	test("resolves currentDeviceLabel from the found option", () => {
		const devices = [makeDevice(3, "Realtek Audio")];
		const result = buildInputDeviceOptions(devices, 3, "System Default");
		expect(result.currentDeviceLabel).toBe("Realtek Audio");
		expect(result.currentDeviceId).toBe("3");
	});

	test("falls back to defaultLabel for currentDeviceLabel when id is not found", () => {
		const result = buildInputDeviceOptions([], 99, "System Default");
		// index 99 not in the list → currentDeviceId="99" but no matching opt → fallback
		expect(result.currentDeviceLabel).toBe("System Default");
	});

	test("deduplication: non-matching device name gets its own index as id", () => {
		// inputDeviceIndex=0 → selectedName="Mic A". Device at index=1 is "Mic B" (no match) → gets id="1"
		const devices = [makeDevice(0, "Mic A"), makeDevice(1, "Mic B")];
		const result = buildInputDeviceOptions(devices, 0, "System Default");
		const micB = result.deviceOptions.find((o) => o.label === "Mic B");
		expect(micB?.id).toBe("1");
	});

	test("deduplication: duplicate names are skipped after first occurrence", () => {
		const devices = [
			makeDevice(0, "Realtek"), // first
			makeDevice(1, "Realtek"), // duplicate — should be skipped
			makeDevice(2, "USB Mic"),
		];
		const result = buildInputDeviceOptions(devices, null, "System Default");
		// default + Realtek (first occurrence only) + USB Mic = 3
		expect(result.deviceOptions).toHaveLength(3);
		expect(
			result.deviceOptions.filter((o) => o.label === "Realtek"),
		).toHaveLength(1);
	});

	test("dedup is case-INSENSITIVE (mixed-case duplicates collapse)", () => {
		// Mutating .toLowerCase() to .toUpperCase() does NOT change correctness
		// because case is normalized either way. But mutating to OMIT the
		// .toLowerCase() entirely (raw d.name) would treat "Mic" and "mic" as
		// distinct keys.
		const devices = [
			makeDevice(0, "Mic"),
			makeDevice(1, "mic"),
			makeDevice(2, "MIC"),
		];
		const result = buildInputDeviceOptions(devices, null, "System Default");
		// default + 1 mic = 2 (all three "mic" variants collapse)
		expect(result.deviceOptions).toHaveLength(2);
	});

	test("dedup uses .trim() — leading/trailing whitespace duplicates collapse", () => {
		// Mutating to remove .trim() (raw d.name without whitespace stripping)
		// would treat "Mic" and " Mic " as distinct.
		const devices = [
			makeDevice(0, "Mic"),
			makeDevice(1, "  Mic  "),
			makeDevice(2, " mic "),
		];
		const result = buildInputDeviceOptions(devices, null, "System Default");
		expect(result.deviceOptions).toHaveLength(2);
	});

	test("when inputDeviceIndex is null, no name resolution is attempted (early-return guard)", () => {
		// L39 mutation: `if (inputDeviceIndex == null) return null` → `false`
		// makes the function always try to find. With null and no matching index,
		// the result is the same. Distinguish by passing a device that would be
		// at index=null… not possible since index is number. Equivalent.
		// Test the documented behavior: null index → all dedup uses d.index as id.
		const devices = [makeDevice(0, "MicA"), makeDevice(1, "MicB")];
		const result = buildInputDeviceOptions(devices, null, "System Default");
		// IDs come from device's own index when no selection.
		const ids = result.deviceOptions.map((o) => o.id);
		expect(ids).toEqual(["default", "0", "1"]);
	});

	test("orders device rows by the priority list, unlisted devices keep enumeration order", () => {
		const devices = [
			makeDevice(0, "Built-in Mic"),
			makeDevice(1, "USB Headset"),
			makeDevice(2, "Webcam Mic"),
		];
		const result = buildInputDeviceOptions(
			devices,
			null,
			"System Default",
			null,
			["Webcam Mic", "USB Headset"],
		);
		expect(result.deviceOptions.map((o) => o.label)).toEqual([
			"System Default",
			"Webcam Mic",
			"USB Headset",
			"Built-in Mic",
		]);
		// The pinned default row is not sortable; device rows are.
		expect(result.deviceOptions[0]?.sortable).toBeUndefined();
		expect(result.deviceOptions[1]?.sortable).toBe(true);
	});

	test("priority ordering matches names case-insensitively and trimmed", () => {
		const devices = [makeDevice(0, "Built-in Mic"), makeDevice(1, "USB Mic")];
		const result = buildInputDeviceOptions(
			devices,
			null,
			"System Default",
			null,
			["  usb mic  "],
		);
		expect(result.deviceOptions.map((o) => o.label)).toEqual([
			"System Default",
			"USB Mic",
			"Built-in Mic",
		]);
	});

	test("marks ONLY the top connected priority device as selected, even when the index points elsewhere", () => {
		const devices = [
			makeDevice(0, "Built-in Mic"),
			makeDevice(1, "USB Mic"),
			makeDevice(2, "Webcam Mic"),
		];
		// Persisted index says Webcam (2), but USB is higher in the priority
		// list and connected — the recorder will open USB, so the UI must mark
		// USB and nothing else.
		const result = buildInputDeviceOptions(devices, 2, "System Default", null, [
			"Unplugged Mic",
			"USB Mic",
			"Webcam Mic",
		]);
		expect(result.currentDeviceId).toBe("1");
		expect(result.currentDeviceLabel).toBe("USB Mic");
	});

	test("falls back to the explicit index, then default, when no priority entry is connected", () => {
		const devices = [makeDevice(0, "Built-in Mic")];
		const withIndex = buildInputDeviceOptions(
			devices,
			0,
			"System Default",
			null,
			["Unplugged Mic"],
		);
		expect(withIndex.currentDeviceId).toBe("0");

		const withoutIndex = buildInputDeviceOptions(
			devices,
			null,
			"System Default",
			null,
			["Unplugged Mic"],
		);
		expect(withoutIndex.currentDeviceId).toBe("default");
	});

	test("empty priority list preserves enumeration order", () => {
		const devices = [makeDevice(0, "B Mic"), makeDevice(1, "A Mic")];
		const result = buildInputDeviceOptions(devices, null, "System Default");
		expect(result.deviceOptions.map((o) => o.label)).toEqual([
			"System Default",
			"B Mic",
			"A Mic",
		]);
	});
});

describe("resolveEffectivePriorityDeviceIndex", () => {
	test("returns the index of the first connected priority entry", () => {
		const devices = [makeDevice(3, "Built-in Mic"), makeDevice(7, "USB Mic")];
		expect(
			resolveEffectivePriorityDeviceIndex(devices, [
				"AirPods Pro", // not connected → skipped
				"usb mic", // case-insensitive match
				"Built-in Mic",
			]),
		).toBe(7);
	});

	test("returns null when the list is empty or nothing is connected", () => {
		const devices = [makeDevice(0, "Built-in Mic")];
		expect(resolveEffectivePriorityDeviceIndex(devices, [])).toBeNull();
		expect(
			resolveEffectivePriorityDeviceIndex(devices, ["Gone Mic"]),
		).toBeNull();
		expect(resolveEffectivePriorityDeviceIndex([], ["Gone Mic"])).toBeNull();
	});
});

describe("promoteDeviceNameToTop", () => {
	test("moves an existing entry to the front, keeping the rest in order", () => {
		expect(promoteDeviceNameToTop(["A", "B", "C"], "B")).toEqual([
			"B",
			"A",
			"C",
		]);
	});

	test("prepends a missing entry and dedupes case-insensitively", () => {
		expect(promoteDeviceNameToTop(["a mic", "B"], "A Mic")).toEqual([
			"A Mic",
			"B",
		]);
		expect(promoteDeviceNameToTop([], "New Mic")).toEqual(["New Mic"]);
	});
});

describe("priorityFromReorderedOptions", () => {
	test("maps ordered option ids back to device names, dropping the default row", () => {
		const devices = [makeDevice(0, "Built-in Mic"), makeDevice(1, "USB Mic")];
		const { deviceOptions } = buildInputDeviceOptions(
			devices,
			null,
			"System Default",
		);
		expect(
			priorityFromReorderedOptions(deviceOptions, ["default", "1", "0"]),
		).toEqual(["USB Mic", "Built-in Mic"]);
	});

	test("ignores unknown ids (row disappeared mid-drag)", () => {
		const devices = [makeDevice(0, "Built-in Mic")];
		const { deviceOptions } = buildInputDeviceOptions(
			devices,
			null,
			"System Default",
		);
		expect(priorityFromReorderedOptions(deviceOptions, ["9", "0"])).toEqual([
			"Built-in Mic",
		]);
	});
});
