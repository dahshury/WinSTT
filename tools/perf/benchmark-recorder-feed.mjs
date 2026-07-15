#!/usr/bin/env node

import { writeFile } from "node:fs/promises";
import process from "node:process";

const FRAME_SAMPLES = 160;
const FRAME_BYTES = FRAME_SAMPLES * Float32Array.BYTES_PER_ELEMENT;
const DEFAULT_FRAMES = 30_000;
const DIRECT_CAPACITY_FRAMES = 64;

function option(name, fallback) {
	const index = process.argv.indexOf(name);
	return index < 0 ? fallback : process.argv[index + 1];
}

function percentile(values, p) {
	const sorted = values.toSorted((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)];
}

function rounded(value, digits = 3) {
	return Number(value.toFixed(digits));
}

function checksumFrame(frame, frameIndex) {
	let checksum = 0;
	const offset = frameIndex * FRAME_SAMPLES;
	for (let index = 0; index < frame.length; index += 1) {
		checksum += frame[index] * ((offset + index) % 997);
	}
	return checksum;
}

function summary(mode, scenario, callbackNs, started, cpuStarted, stats) {
	const wallMs = performance.now() - started;
	const cpu = process.cpuUsage(cpuStarted);
	const cpuMs = (cpu.user + cpu.system) / 1000;
	const callbackUs = callbackNs.map((value) => Number(value) / 1000);
	return {
		mode,
		scenario: scenario.name,
		frames: scenario.frames,
		callbackMeanUs: rounded(
			callbackUs.reduce((total, value) => total + value, 0) / callbackUs.length,
		),
		callbackP95Us: rounded(percentile(callbackUs, 0.95)),
		callbackMaxUs: rounded(Math.max(...callbackUs)),
		cpuMs: rounded(cpuMs),
		cpuUtilizationPercent: rounded((cpuMs / wallMs) * 100, 1),
		wallMs: rounded(wallMs),
		copiedMiB: rounded(stats.copiedBytes / 1024 / 1024),
		peakBufferedMiB: rounded(stats.peakBufferedBytes / 1024 / 1024),
		droppedFrames: stats.droppedFrames,
		consumedFrames: stats.consumedFrames,
		parity:
			stats.droppedFrames === 0 &&
			stats.consumedFrames === scenario.frames &&
			Math.abs(stats.checksum - stats.expectedChecksum) < 0.01,
	};
}

function benchmarkMirror(frame, scenario) {
	global.gc?.();
	const mirror = new Float32Array(scenario.frames * FRAME_SAMPLES);
	const callbackNs = [];
	let writtenFrames = 0;
	let consumedFrames = 0;
	let copiedBytes = 0;
	let checksum = 0;
	let expectedChecksum = 0;

	const consume = () => {
		const available = writtenFrames - consumedFrames;
		const take = Math.min(available, scenario.drainFrames);
		if (take <= 0) return;
		const startFrame = consumedFrames;
		const tail = mirror.slice(
			startFrame * FRAME_SAMPLES,
			(startFrame + take) * FRAME_SAMPLES,
		);
		copiedBytes += tail.byteLength;
		for (let index = 0; index < take; index += 1) {
			checksum += checksumFrame(
				tail.subarray(index * FRAME_SAMPLES, (index + 1) * FRAME_SAMPLES),
				startFrame + index,
			);
		}
		consumedFrames += take;
	};

	const started = performance.now();
	const cpuStarted = process.cpuUsage();
	for (let frameIndex = 0; frameIndex < scenario.frames; frameIndex += 1) {
		expectedChecksum += checksumFrame(frame, frameIndex);
		const callbackStarted = process.hrtime.bigint();
		mirror.set(frame, writtenFrames * FRAME_SAMPLES);
		writtenFrames += 1;
		callbackNs.push(process.hrtime.bigint() - callbackStarted);
		copiedBytes += FRAME_BYTES;
		if ((frameIndex + 1) % scenario.consumeEvery === 0) consume();
	}
	while (consumedFrames < writtenFrames) consume();
	return summary(
		"mirror-tail-snapshot",
		scenario,
		callbackNs,
		started,
		cpuStarted,
		{
			checksum,
			copiedBytes,
			consumedFrames,
			droppedFrames: 0,
			expectedChecksum,
			peakBufferedBytes: mirror.byteLength,
		},
	);
}

function benchmarkDirect(frame, scenario) {
	global.gc?.();
	const slots = Array.from(
		{ length: DIRECT_CAPACITY_FRAMES },
		() => new Float32Array(FRAME_SAMPLES),
	);
	const frameIds = new Int32Array(DIRECT_CAPACITY_FRAMES);
	const callbackNs = [];
	let head = 0;
	let size = 0;
	let copiedBytes = 0;
	let droppedFrames = 0;
	let consumedFrames = 0;
	let checksum = 0;
	let expectedChecksum = 0;
	let peakFrames = 0;

	const consume = () => {
		const take = Math.min(size, scenario.drainFrames);
		for (let index = 0; index < take; index += 1) {
			const slot = (head + index) % DIRECT_CAPACITY_FRAMES;
			checksum += checksumFrame(slots[slot], frameIds[slot]);
		}
		head = (head + take) % DIRECT_CAPACITY_FRAMES;
		size -= take;
		consumedFrames += take;
	};

	const started = performance.now();
	const cpuStarted = process.cpuUsage();
	for (let frameIndex = 0; frameIndex < scenario.frames; frameIndex += 1) {
		expectedChecksum += checksumFrame(frame, frameIndex);
		const callbackStarted = process.hrtime.bigint();
		if (size === DIRECT_CAPACITY_FRAMES) {
			droppedFrames += 1;
		} else {
			const slot = (head + size) % DIRECT_CAPACITY_FRAMES;
			slots[slot].set(frame);
			frameIds[slot] = frameIndex;
			size += 1;
			copiedBytes += FRAME_BYTES;
			peakFrames = Math.max(peakFrames, size);
		}
		callbackNs.push(process.hrtime.bigint() - callbackStarted);
		if ((frameIndex + 1) % scenario.consumeEvery === 0) consume();
	}
	while (size > 0) consume();
	return summary(
		"bounded-direct-ring",
		scenario,
		callbackNs,
		started,
		cpuStarted,
		{
			checksum,
			copiedBytes,
			consumedFrames,
			droppedFrames,
			expectedChecksum,
			peakBufferedBytes: peakFrames * FRAME_BYTES,
		},
	);
}

async function main() {
	const frames = Number(option("--frames", DEFAULT_FRAMES));
	if (!Number.isInteger(frames) || frames < 100) {
		throw new Error("--frames must be an integer >= 100");
	}
	const frame = Float32Array.from(
		{ length: FRAME_SAMPLES },
		(_, index) => Math.sin(index * 0.071) * 0.5,
	);
	const scenarios = [
		{ name: "fast-consumer", frames, consumeEvery: 1, drainFrames: 8 },
		{ name: "paced-consumer", frames, consumeEvery: 4, drainFrames: 4 },
		{ name: "slow-consumer", frames, consumeEvery: 8, drainFrames: 2 },
	];
	const results = scenarios.flatMap((scenario) => [
		benchmarkMirror(frame, scenario),
		benchmarkDirect(frame, scenario),
	]);
	const direct = results.filter((row) => row.mode === "bounded-direct-ring");
	const recommendation = direct.every(
		(row) => row.parity && row.droppedFrames === 0,
	)
		? "Direct feed preserved parity in all loads; validate with a real native engine before promotion."
		: "Keep the production mirror: the bounded direct prototype loses frames/parity under consumer backpressure.";
	const payload = {
		generatedAt: new Date().toISOString(),
		machine: {
			platform: process.platform,
			arch: process.arch,
			node: process.version,
		},
		configuration: {
			frameSamples: FRAME_SAMPLES,
			frames,
			directCapacityFrames: DIRECT_CAPACITY_FRAMES,
		},
		results,
		recommendation,
	};
	console.table(
		results.map((row) => ({
			mode: row.mode,
			scenario: row.scenario,
			callbackP95Us: row.callbackP95Us,
			cpuMs: row.cpuMs,
			copiedMiB: row.copiedMiB,
			peakMiB: row.peakBufferedMiB,
			drops: row.droppedFrames,
			parity: row.parity,
		})),
	);
	console.log(recommendation);
	const output = option("--output", null);
	if (output) await writeFile(output, `${JSON.stringify(payload, null, 2)}\n`);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
