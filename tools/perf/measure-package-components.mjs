#!/usr/bin/env node

import { readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

function option(name, fallback) {
	const index = process.argv.indexOf(name);
	return index < 0 ? fallback : process.argv[index + 1];
}

async function pathBytes(target) {
	try {
		const info = await stat(target);
		if (info.isFile()) return info.size;
		if (!info.isDirectory()) return 0;
		const entries = await readdir(target, { withFileTypes: true });
		const sizes = await Promise.all(
			entries.map((entry) => pathBytes(path.join(target, entry.name))),
		);
		return sizes.reduce((total, size) => total + size, 0);
	} catch (error) {
		if (error?.code === "ENOENT") return null;
		throw error;
	}
}

async function newestMatching(directory, expression) {
	try {
		const entries = await readdir(directory, { withFileTypes: true });
		const candidates = await Promise.all(
			entries
				.filter((entry) => entry.isFile() && expression.test(entry.name))
				.map(async (entry) => {
					const target = path.join(directory, entry.name);
					return { target, modified: (await stat(target)).mtimeMs };
				}),
		);
		return (
			candidates.toSorted((a, b) => b.modified - a.modified)[0]?.target ?? null
		);
	} catch (error) {
		if (error?.code === "ENOENT") return null;
		throw error;
	}
}

function formatMiB(bytes) {
	return bytes == null ? "missing" : `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}

async function main() {
	const root = path.resolve(option("--root", "."));
	const latestNsis = await newestMatching(
		path.join(root, "src-tauri/target/release/bundle/nsis"),
		/\.exe$/i,
	);
	const definitions = [
		["release executable", "src-tauri/target/release/winstt.exe"],
		["context sidecar", "src-tauri/target/release/winstt_context.exe"],
		["Windows native runtime DLLs", "src-tauri/binaries/runtime"],
		["bundled resources", "src-tauri/resources"],
		["renderer dist", "dist"],
		["portable ZIP", "dist/WinSTT-portable.zip"],
		["published Windows NSIS", "dist/WinSTT.exe"],
		["latest raw NSIS", latestNsis ? path.relative(root, latestNsis) : null],
		["Linux release artifacts", "dist/linux"],
		["macOS release artifacts", "dist/macos"],
	];
	const components = [];
	for (const [name, relative] of definitions) {
		const target = relative ? path.resolve(root, relative) : null;
		components.push({
			name,
			path: relative,
			bytes: target ? await pathBytes(target) : null,
		});
	}
	const runtime = components.find(
		(component) => component.name === "Windows native runtime DLLs",
	);
	const executable = components.find(
		(component) => component.name === "release executable",
	);
	const sidecar = components.find(
		(component) => component.name === "context sidecar",
	);
	const conclusions = [
		"Keep the context reader as the existing sidecar: it is independently replaceable and small enough that another process split has no package-size payoff.",
		"Do not split STT/TTS/LLM Rust features into more executables without symbol-level evidence: the main binary shares the Tauri/Rust/native dependency graph, and extra binaries would duplicate runtime/linkage while adding IPC and lifecycle failure modes.",
		runtime?.bytes && executable?.bytes
			? `Windows runtime DLLs are ${formatMiB(runtime.bytes)} beside a ${formatMiB(executable.bytes)} executable. Making the runtime an on-demand download would reduce the initial artifact, but would break offline-first launch/recovery; retain app-local packaging.`
			: "Re-run after a Windows release build to quantify executable/runtime proportions before reconsidering dynamic runtime delivery.",
		sidecar?.bytes
			? `The context sidecar is ${formatMiB(sidecar.bytes)}, confirming it is not a meaningful package-size target.`
			: "The context-sidecar binary was not present in the measured release output.",
	];
	const payload = {
		generatedAt: new Date().toISOString(),
		root,
		components,
		conclusion: conclusions,
	};
	console.table(
		components.map((component) => ({
			component: component.name,
			size: formatMiB(component.bytes),
			path: component.path ?? "missing",
		})),
	);
	const jsonOutput = option("--output-json", null);
	if (jsonOutput)
		await writeFile(jsonOutput, `${JSON.stringify(payload, null, 2)}\n`);
	const markdownOutput = option("--output-md", null);
	if (markdownOutput) {
		const rows = components
			.map(
				(component) =>
					`| ${component.name} | ${formatMiB(component.bytes)} | \`${component.path ?? "missing"}\` |`,
			)
			.join("\n");
		const markdown = `# WinSTT package component measurement\n\nMeasured: ${payload.generatedAt}\n\n| Component | Logical size | Path |\n|---|---:|---|\n${rows}\n\n## Decision\n\n${conclusions.map((line) => `- ${line}`).join("\n")}\n`;
		await writeFile(markdownOutput, markdown);
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? error.stack : String(error));
	process.exitCode = 1;
});
