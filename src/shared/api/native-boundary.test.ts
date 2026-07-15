import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "bun:test";
import { NATIVE_EVENTS } from "./native-events";
import { nativeEventName, reshapeNativeEvent } from "./native-boundary";

const SRC = join(import.meta.dir, "..", "..");

function sourceFiles(directory: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(directory)) {
		const path = join(directory, entry);
		if (statSync(path).isDirectory()) {
			files.push(...sourceFiles(path));
		} else if (/\.(?:ts|tsx)$/.test(entry) && !entry.includes(".test.")) {
			files.push(path);
		}
	}
	return files;
}

describe("native boundary", () => {
	test("production modules do not depend on the retired string command funnel", () => {
		const offenders = sourceFiles(SRC)
			.filter((path) => !path.endsWith("bindings.ts"))
			.filter((path) => {
				const source = readFileSync(path, "utf8");
				return (
					source.includes("native-bridge-adapter") ||
					source.includes("COMMAND_INVOKERS") ||
					/import\([^)]*ipc-channels|from\s+["'][^"']*ipc-channels/.test(source)
				);
			})
			.map((path) => relative(SRC, path))
			.sort();

		expect(offenders).toEqual([]);
	});

	test("maps compatibility event labels to canonical backend names", () => {
		expect(nativeEventName(NATIVE_EVENTS.STT_REALTIME_TEXT)).toBe(
			"realtime:update",
		);
		expect(nativeEventName(NATIVE_EVENTS.STT_WAKEWORD_DETECTED)).toBe(
			"wakeword:detected",
		);
		expect(nativeEventName(NATIVE_EVENTS.STT_CLOUD_RATE_LIMITED)).toBe(
			"stt:cloud-error",
		);
		expect(nativeEventName(NATIVE_EVENTS.STT_RECORDING_START)).toBe(
			"stt:recording-start",
		);
	});

	test("normalizes wake-word and TTS binary event payloads", () => {
		expect(
			reshapeNativeEvent(NATIVE_EVENTS.STT_WAKEWORD_DETECTED, {
				keyword: "computer",
			}),
		).toEqual({ word: "computer" });

		const reshaped = reshapeNativeEvent(NATIVE_EVENTS.TTS_CHUNK, {
			pcm: [1, 2, 3],
		});
		expect(reshaped).toEqual({ pcm: new Uint8Array([1, 2, 3]).buffer });
	});
});
