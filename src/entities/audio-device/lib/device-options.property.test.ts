import { describe, test } from "bun:test";
import fc from "fast-check";
import type { AudioDevice } from "../model/audio-device";
import { buildInputDeviceOptions } from "./device-options";

const deviceGen = (): fc.Arbitrary<AudioDevice> =>
	fc.record({
		index: fc.integer({ min: 0, max: 50 }),
		name: fc.string({ minLength: 1, maxLength: 12 }),
		isDefault: fc.boolean(),
		defaultSampleRate: fc.constant(44_100),
		maxInputChannels: fc.constant(2),
	});

function dedupKey(name: string): string {
	return name.trim().toLowerCase();
}

describe("buildInputDeviceOptions (property-based)", () => {
	test("dedup never increases length: output (minus default) ≤ input length", () => {
		fc.assert(
			fc.property(fc.array(deviceGen(), { maxLength: 20 }), (devices) => {
				const result = buildInputDeviceOptions(devices, null, "System Default");
				// Output includes the prepended "default" row.
				return result.deviceOptions.length - 1 <= devices.length;
			}),
			{ numRuns: 300 },
		);
	});

	test("output length equals unique-name count + 1 (the default row)", () => {
		fc.assert(
			fc.property(fc.array(deviceGen(), { maxLength: 20 }), (devices) => {
				const uniqueNames = new Set(devices.map((d) => dedupKey(d.name)));
				const result = buildInputDeviceOptions(devices, null, "System Default");
				return result.deviceOptions.length === uniqueNames.size + 1;
			}),
			{ numRuns: 300 },
		);
	});

	test("idempotent: building from already-deduped device list yields same option count", () => {
		fc.assert(
			fc.property(fc.array(deviceGen(), { maxLength: 20 }), (devices) => {
				const first = buildInputDeviceOptions(devices, null, "System Default");
				// Reconstruct AudioDevice rows from the (deduped) options. The
				// resulting list has unique names, so passing it back through
				// the dedup function yields the same count.
				const dedupedDevices: AudioDevice[] = first.deviceOptions
					.filter((o) => o.id !== "default")
					.map((o, i) => ({
						index: i,
						name: o.label,
						isDefault: false,
						defaultSampleRate: 44_100,
						maxInputChannels: 2,
					}));
				const second = buildInputDeviceOptions(
					dedupedDevices,
					null,
					"System Default",
				);
				return first.deviceOptions.length === second.deviceOptions.length;
			}),
			{ numRuns: 300 },
		);
	});

	test("order-independent for the SET of labels: shuffling devices yields the same set of labels", () => {
		fc.assert(
			fc.property(
				fc.array(deviceGen(), { maxLength: 15 }).chain((devices) =>
					fc.tuple(
						fc.constant(devices),
						fc.shuffledSubarray(devices, {
							minLength: devices.length,
							maxLength: devices.length,
						}),
					),
				),
				([devicesA, devicesB]) => {
					const a = buildInputDeviceOptions(devicesA, null, "System Default");
					const b = buildInputDeviceOptions(devicesB, null, "System Default");
					const labelsA = new Set(
						a.deviceOptions.map((o) => dedupKey(o.label)),
					);
					const labelsB = new Set(
						b.deviceOptions.map((o) => dedupKey(o.label)),
					);
					if (labelsA.size !== labelsB.size) {
						return false;
					}
					for (const k of labelsA) {
						if (!labelsB.has(k)) {
							return false;
						}
					}
					return true;
				},
			),
			{ numRuns: 200 },
		);
	});

	test("output always contains the 'default' option at index 0", () => {
		fc.assert(
			fc.property(fc.array(deviceGen(), { maxLength: 10 }), (devices) => {
				const result = buildInputDeviceOptions(devices, null, "Sys Default");
				return (
					result.deviceOptions.length >= 1 &&
					result.deviceOptions[0]?.id === "default" &&
					result.deviceOptions[0]?.label === "Sys Default"
				);
			}),
			{ numRuns: 200 },
		);
	});
});
