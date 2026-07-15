#!/usr/bin/env node

import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import http from "node:http";
import process from "node:process";
import { fileURLToPath } from "node:url";

const WIDTHS = [1, 2, 4, 8];
const CHUNK_BYTES = 64 * 1024;
const FILE_BYTES = 2 * 1024 * 1024;
const FILE_COUNT = 10;

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

async function downloadOne(baseUrl, id, scenario) {
	const controller = new AbortController();
	const cancellation =
		scenario.cancelEvery > 0 && id % scenario.cancelEvery === 0
			? setTimeout(() => controller.abort(), scenario.cancelAfterMs)
			: null;
	let bytes = 0;
	try {
		const response = await fetch(
			`${baseUrl}/file/${id}?delay=${scenario.networkDelayMs}`,
			{
				signal: controller.signal,
			},
		);
		if (!response.ok || !response.body)
			throw new Error(`HTTP ${response.status}`);
		const reader = response.body.getReader();
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (scenario.sinkDelayMs > 0) await scenario.waitForSink();
		}
		return { bytes, cancelled: false, error: null };
	} catch (error) {
		if (controller.signal.aborted)
			return { bytes, cancelled: true, error: null };
		return { bytes, cancelled: false, error: String(error) };
	} finally {
		if (cancellation) clearTimeout(cancellation);
	}
}

async function runWorker(config) {
	global.gc?.();
	const baselineRss = process.memoryUsage.rss();
	let peakRss = baselineRss;
	let active = 0;
	let peakActive = 0;
	let next = 0;
	const results = [];
	let sinkTail = Promise.resolve();
	config.scenario.waitForSink = () => {
		const wait = sinkTail.then(() => sleep(config.scenario.sinkDelayMs));
		sinkTail = wait;
		return wait;
	};
	const sample = setInterval(() => {
		peakRss = Math.max(peakRss, process.memoryUsage.rss());
	}, 2);
	const started = performance.now();
	const cpuStarted = process.cpuUsage();
	async function worker() {
		while (true) {
			const id = next;
			next += 1;
			if (id >= config.fileCount) return;
			active += 1;
			peakActive = Math.max(peakActive, active);
			results[id] = await downloadOne(config.baseUrl, id, config.scenario);
			active -= 1;
		}
	}
	await Promise.all(Array.from({ length: config.width }, worker));
	clearInterval(sample);
	peakRss = Math.max(peakRss, process.memoryUsage.rss());
	const durationMs = performance.now() - started;
	const cpu = process.cpuUsage(cpuStarted);
	const bytes = results.reduce((total, result) => total + result.bytes, 0);
	const payload = {
		width: config.width,
		scenario: config.scenario.name,
		durationMs: rounded(durationMs),
		throughputMiBps: rounded(bytes / 1024 / 1024 / (durationMs / 1000)),
		cpuMs: rounded((cpu.user + cpu.system) / 1000),
		peakConcurrency: peakActive,
		peakRssDeltaMiB: rounded(Math.max(0, peakRss - baselineRss) / 1024 / 1024),
		completed: results.filter((result) => !result.cancelled && !result.error)
			.length,
		cancelled: results.filter((result) => result.cancelled).length,
		errors: results.filter((result) => result.error).length,
		bytes,
	};
	process.stdout.write(JSON.stringify(payload));
}

function spawnWorker(config) {
	return new Promise((resolve, reject) => {
		const encoded = Buffer.from(JSON.stringify(config)).toString("base64url");
		const child = spawn(
			process.execPath,
			["--expose-gc", fileURLToPath(import.meta.url), "--worker", encoded],
			{
				stdio: ["ignore", "pipe", "pipe"],
			},
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

function startFixture() {
	const state = { active: 0, peak: 0 };
	const payload = Buffer.alloc(CHUNK_BYTES, 0x5a);
	let networkTail = Promise.resolve();
	const waitForNetwork = (delay) => {
		const wait = networkTail.then(() => sleep(delay));
		networkTail = wait;
		return wait;
	};
	const server = http.createServer((request, response) => {
		const url = new URL(request.url ?? "/", "http://127.0.0.1");
		if (!url.pathname.startsWith("/file/")) {
			response.writeHead(404).end();
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
		response.writeHead(200, {
			"Content-Length": FILE_BYTES,
			"Content-Type": "application/octet-stream",
		});
		let remaining = FILE_BYTES;
		const writeNext = async () => {
			if (response.destroyed || remaining <= 0) {
				if (!response.destroyed) response.end();
				return;
			}
			const size = Math.min(remaining, payload.length);
			remaining -= size;
			if (delay > 0) await waitForNetwork(delay);
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

function chooseRecommendation(results) {
	const normal = results.filter((row) => row.scenario !== "cancellation-storm");
	const byWidth = new Map(
		WIDTHS.map((width) => [width, normal.filter((row) => row.width === width)]),
	);
	const scores = WIDTHS.map((width) => {
		const rows = byWidth.get(width);
		const throughput = rows.reduce(
			(total, row) => total + row.throughputMiBps,
			0,
		);
		const memory = Math.max(...rows.map((row) => row.peakRssDeltaMiB));
		return { width, throughput, memory };
	});
	const width2 = scores.find((score) => score.width === 2);
	const wider = scores.filter((score) => score.width > 2);
	const clearWinner = wider.find(
		(score) =>
			score.throughput >= width2.throughput * 1.25 &&
			score.memory <= width2.memory * 2,
	);
	return clearWinner
		? `Width ${clearWinner.width} clears the 25% aggregate-throughput threshold without exceeding 2x width-2 memory; validate on real model files before changing the default.`
		: "Keep the production default at 2 workers: wider pools did not clear the evidence threshold across network and sink bottlenecks.";
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
		{
			name: "slow-network-fast-sink",
			networkDelayMs: 3,
			sinkDelayMs: 0,
			cancelEvery: 0,
			cancelAfterMs: 0,
		},
		{
			name: "fast-network-slow-sink",
			networkDelayMs: 0,
			sinkDelayMs: 3,
			cancelEvery: 0,
			cancelAfterMs: 0,
		},
		{
			name: "cancellation-storm",
			networkDelayMs: 3,
			sinkDelayMs: 2,
			cancelEvery: 2,
			cancelAfterMs: 20,
		},
	];
	const results = [];
	try {
		for (const scenario of scenarios) {
			for (const width of WIDTHS) {
				fixture.resetPeak();
				const result = await spawnWorker({
					baseUrl: fixture.baseUrl,
					fileCount: FILE_COUNT,
					scenario,
					width,
				});
				results.push({ ...result, serverPeakConcurrency: fixture.peak() });
			}
		}
	} finally {
		await fixture.close();
	}
	const recommendation = chooseRecommendation(results);
	const payload = {
		generatedAt: new Date().toISOString(),
		machine: {
			platform: process.platform,
			arch: process.arch,
			node: process.version,
		},
		fixture: {
			chunkBytes: CHUNK_BYTES,
			fileBytes: FILE_BYTES,
			fileCount: FILE_COUNT,
			localOnly: true,
		},
		results,
		recommendation,
	};
	console.table(
		results.map((row) => ({
			scenario: row.scenario,
			width: row.width,
			ms: row.durationMs,
			MiBps: row.throughputMiBps,
			cpuMs: row.cpuMs,
			peak: row.serverPeakConcurrency,
			rssMiB: row.peakRssDeltaMiB,
			cancelled: row.cancelled,
			errors: row.errors,
		})),
	);
	console.log(recommendation);
	const output = option("--output", null);
	if (output) await writeFile(output, `${JSON.stringify(payload, null, 2)}\n`);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.stack : String(error));
	process.exitCode = 1;
});
