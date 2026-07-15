#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const WIDTHS = [1, 2, 4, 8];
const CHUNK_BYTES = 64 * 1024;
const FILE_BYTES = 32 * 1024 * 1024;
const TRIALS = 2;

function option(name, fallback) {
	const index = process.argv.indexOf(name);
	return index < 0 ? fallback : process.argv[index + 1];
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function rounded(value, digits = 2) {
	return Number(value.toFixed(digits));
}

function segmentRanges(totalBytes, width) {
	const segmentBytes = Math.ceil(totalBytes / width);
	return Array.from({ length: width }, (_, index) => {
		const start = index * segmentBytes;
		return { start, end: Math.min(totalBytes - 1, start + segmentBytes - 1) };
	}).filter(({ start, end }) => start <= end);
}

async function runWorker(config) {
	global.gc?.();
	const directory = await mkdtemp(join(tmpdir(), "winstt-range-bench-"));
	const outputPath = join(directory, "artifact.incomplete");
	const file = await open(outputPath, "w+");
	await file.truncate(config.fileBytes);
	let sinkTail = Promise.resolve();
	const waitForSink = () => {
		if (config.scenario.sinkDelayMs <= 0) return Promise.resolve();
		const wait = sinkTail.then(() => sleep(config.scenario.sinkDelayMs));
		sinkTail = wait;
		return wait;
	};
	const baselineRss = process.memoryUsage.rss();
	let peakRss = baselineRss;
	const sample = setInterval(() => {
		peakRss = Math.max(peakRss, process.memoryUsage.rss());
	}, 2);
	const started = performance.now();
	const cpuStarted = process.cpuUsage();
	let transferred = 0;
	try {
		await Promise.all(
			segmentRanges(config.fileBytes, config.width).map(
				async ({ start, end }) => {
					const response = await fetch(
						`${config.baseUrl}/artifact?delay=${config.scenario.serverDelayMs}`,
						{ headers: { Range: `bytes=${start}-${end}` } },
					);
					if (response.status !== 206 || !response.body)
						throw new Error(`expected HTTP 206, received ${response.status}`);
					const expectedRange = `bytes ${start}-${end}/${config.fileBytes}`;
					if (response.headers.get("content-range") !== expectedRange)
						throw new Error(`invalid Content-Range for ${start}-${end}`);
					const reader = response.body.getReader();
					let position = start;
					while (true) {
						const { done, value } = await reader.read();
						if (done) break;
						await waitForSink();
						const { bytesWritten } = await file.write(
							value,
							0,
							value.length,
							position,
						);
						if (bytesWritten !== value.length)
							throw new Error("short fixture write");
						position += bytesWritten;
						transferred += bytesWritten;
					}
					if (position !== end + 1)
						throw new Error(
							`short segment ${start}-${end}: stopped at ${position}`,
						);
				},
			),
		);
		await file.sync();
	} finally {
		clearInterval(sample);
		await file.close();
	}
	peakRss = Math.max(peakRss, process.memoryUsage.rss());
	const durationMs = performance.now() - started;
	const cpu = process.cpuUsage(cpuStarted);
	await rm(directory, { recursive: true, force: true });
	process.stdout.write(
		JSON.stringify({
			width: config.width,
			scenario: config.scenario.name,
			durationMs: rounded(durationMs),
			throughputMiBps: rounded(transferred / 1024 / 1024 / (durationMs / 1000)),
			cpuMs: rounded((cpu.user + cpu.system) / 1000),
			peakRssDeltaMiB: rounded(
				Math.max(0, peakRss - baselineRss) / 1024 / 1024,
			),
			bytes: transferred,
		}),
	);
}

function spawnWorker(config) {
	return new Promise((resolve, reject) => {
		const encoded = Buffer.from(JSON.stringify(config)).toString("base64url");
		const child = spawn(
			process.execPath,
			["--expose-gc", fileURLToPath(import.meta.url), "--worker", encoded],
			{ stdio: ["ignore", "pipe", "pipe"] },
		);
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
		child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
		child.on("error", reject);
		child.on("exit", (code) => {
			if (code !== 0) {
				reject(new Error(`benchmark worker failed (${code}): ${stderr}`));
				return;
			}
			try {
				resolve(JSON.parse(stdout));
			} catch (error) {
				reject(new Error(`invalid worker JSON: ${stdout}\n${error}`));
			}
		});
	});
}

function parseRange(header) {
	const match = /^bytes=(\d+)-(\d+)$/.exec(header ?? "");
	if (!match) return null;
	const start = Number(match[1]);
	const end = Number(match[2]);
	if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return null;
	if (start < 0 || start > end || end >= FILE_BYTES) return null;
	return { start, end };
}

function startFixture() {
	const state = { active: 0, peak: 0 };
	const payload = Buffer.alloc(CHUNK_BYTES, 0x5a);
	const server = http.createServer((request, response) => {
		const url = new URL(request.url ?? "/", "http://127.0.0.1");
		if (url.pathname !== "/artifact") {
			response.writeHead(404).end();
			return;
		}
		const range = parseRange(request.headers.range);
		if (!range) {
			response
				.writeHead(416, { "Content-Range": `bytes */${FILE_BYTES}` })
				.end();
			return;
		}
		const delay = Math.max(0, Number(url.searchParams.get("delay") ?? 0));
		state.active += 1;
		state.peak = Math.max(state.peak, state.active);
		let settled = false;
		const settle = () => {
			if (!settled) {
				settled = true;
				state.active -= 1;
			}
		};
		response.on("close", settle);
		response.on("finish", settle);
		response.writeHead(206, {
			"Accept-Ranges": "bytes",
			"Content-Length": range.end - range.start + 1,
			"Content-Range": `bytes ${range.start}-${range.end}/${FILE_BYTES}`,
			"Content-Type": "application/octet-stream",
			ETag: '"winstt-range-benchmark-v1"',
		});
		let remaining = range.end - range.start + 1;
		const writeNext = async () => {
			if (response.destroyed || remaining <= 0) {
				if (!response.destroyed) response.end();
				return;
			}
			const size = Math.min(remaining, payload.length);
			remaining -= size;
			if (delay > 0) await sleep(delay);
			response.write(payload.subarray(0, size));
			setImmediate(writeNext);
		};
		void writeNext();
	});
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			resolve({
				baseUrl: `http://127.0.0.1:${address.port}`,
				close: () => new Promise((done) => server.close(done)),
				resetPeak: () => {
					state.peak = state.active;
				},
				peak: () => state.peak,
			});
		});
	});
}

function medians(results) {
	return WIDTHS.flatMap((width) => {
		const scenarios = new Set(results.map(({ scenario }) => scenario));
		return [...scenarios].map((scenario) => {
			const rows = results
				.filter((row) => row.width === width && row.scenario === scenario)
				.sort((left, right) => left.durationMs - right.durationMs);
			const row = rows[Math.floor(rows.length / 2)];
			return { ...row, trial: "median" };
		});
	});
}

function chooseRecommendation(summary) {
	const row = (scenario, width) =>
		summary.find(
			(entry) => entry.scenario === scenario && entry.width === width,
		);
	const one = row("per-connection-latency", 1);
	const four = row("per-connection-latency", 4);
	const sinkOne = row("serialized-sink", 1);
	const sinkFour = row("serialized-sink", 4);
	const speedup = four.throughputMiBps / one.throughputMiBps;
	const sinkRatio = sinkFour.throughputMiBps / sinkOne.throughputMiBps;
	if (speedup >= 1.5 && sinkRatio >= 0.8 && four.peakRssDeltaMiB <= 64) {
		return `Width 4 is the bounded candidate: ${rounded(speedup)}x throughput under per-connection latency, ${rounded(sinkRatio)}x under a serialized sink, and ${four.peakRssDeltaMiB} MiB measured RSS growth. Production still requires 200/206 fallback and crash-safe contiguous resume semantics.`;
	}
	return `Keep one connection per file: width 4 measured ${rounded(speedup)}x under per-connection latency and ${rounded(sinkRatio)}x under a serialized sink, which does not clear the safety threshold.`;
}

async function main() {
	const worker = option("--worker", null);
	if (worker) {
		await runWorker(
			JSON.parse(Buffer.from(worker, "base64url").toString("utf8")),
		);
		return;
	}
	const fixture = await startFixture();
	const scenarios = [
		{ name: "per-connection-latency", serverDelayMs: 2, sinkDelayMs: 0 },
		{ name: "serialized-sink", serverDelayMs: 0, sinkDelayMs: 1 },
	];
	const results = [];
	try {
		for (const scenario of scenarios) {
			for (const width of WIDTHS) {
				for (let trial = 1; trial <= TRIALS; trial += 1) {
					fixture.resetPeak();
					const result = await spawnWorker({
						baseUrl: fixture.baseUrl,
						fileBytes: FILE_BYTES,
						scenario,
						width,
					});
					results.push({ ...result, serverPeak: fixture.peak(), trial });
				}
			}
		}
	} finally {
		await fixture.close();
	}
	const summary = medians(results);
	const recommendation = chooseRecommendation(summary);
	console.table(
		summary.map((row) => ({
			scenario: row.scenario,
			width: row.width,
			ms: row.durationMs,
			MiBps: row.throughputMiBps,
			cpuMs: row.cpuMs,
			serverPeak: row.serverPeak,
			rssMiB: row.peakRssDeltaMiB,
		})),
	);
	console.log(recommendation);
	const output = option("--output", null);
	if (output) {
		await writeFile(
			output,
			`${JSON.stringify(
				{
					generatedAt: new Date().toISOString(),
					machine: {
						platform: process.platform,
						arch: process.arch,
						node: process.version,
					},
					fixture: {
						chunkBytes: CHUNK_BYTES,
						fileBytes: FILE_BYTES,
						localOnly: true,
						trials: TRIALS,
					},
					results,
					summary,
					recommendation,
				},
				null,
				2,
			)}\n`,
		);
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? error.stack : String(error));
	process.exitCode = 1;
});
