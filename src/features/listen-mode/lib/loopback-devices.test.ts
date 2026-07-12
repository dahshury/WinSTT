import { describe, expect, test } from "bun:test";
import {
	type LoopbackDevice,
	loopbackIndexForName,
	parseLoopbackDevices,
} from "./loopback-devices";

function device(index: number, name: string): LoopbackDevice {
	return {
		index,
		name,
		defaultSampleRate: 48_000,
		maxOutputChannels: 2,
	};
}

const DEVICES: LoopbackDevice[] = [
	device(0, "Speakers (Realtek(R) Audio)"),
	device(1, "LG TV (NVIDIA High Definition Audio)"),
	device(2, "Headphones (2- USB Audio)"),
];

describe("loopbackIndexForName", () => {
	test("returns the exact-match index (case/space-insensitive)", () => {
		expect(
			loopbackIndexForName(DEVICES, "  speakers (realtek(r) audio)  "),
		).toBe(0);
		expect(loopbackIndexForName(DEVICES, "Headphones (2- USB Audio)")).toBe(2);
	});

	test("falls back to a contains-match when framing differs", () => {
		// Backend output name is a substring of the WASAPI loopback name (or vice
		// versa) — still resolves rather than dropping to the default.
		expect(loopbackIndexForName(DEVICES, "LG TV")).toBe(1);
		expect(
			loopbackIndexForName(
				[device(0, "LG TV")],
				"LG TV (NVIDIA High Definition Audio)",
			),
		).toBe(0);
	});

	test("returns null when nothing matches or the name is blank", () => {
		expect(loopbackIndexForName(DEVICES, "Nonexistent Speaker")).toBeNull();
		expect(loopbackIndexForName(DEVICES, "   ")).toBeNull();
		expect(loopbackIndexForName([], "Speakers")).toBeNull();
	});
});

describe("parseLoopbackDevices", () => {
	test("keeps valid rows and drops malformed ones", () => {
		const parsed = parseLoopbackDevices([
			{ index: 0, name: "A", defaultSampleRate: 48_000, maxOutputChannels: 2 },
			{ index: "nope", name: "B" }, // invalid → dropped
			{ index: 1, name: "C", defaultSampleRate: 44_100, maxOutputChannels: 2 },
		]);
		expect(parsed.map((d) => d.name)).toEqual(["A", "C"]);
	});
});
