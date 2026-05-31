#!/usr/bin/env node
/*
 * Compile electron/native/src/winstt-paste.c → electron/native/bin/winstt-paste.exe
 *
 * Tries MSVC (cl.exe via vcvars64.bat), then MinGW gcc, then clang.
 * No-op on non-Windows. Skips if the existing binary is newer than
 * the source.
 */
"use strict";

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

if (process.platform !== "win32") process.exit(0);

const projectRoot = path.resolve(__dirname, "..", "..");
const srcFile = path.join(projectRoot, "electron", "native", "src", "winstt-paste.c");
const outDir = path.join(projectRoot, "electron", "native", "bin");
const outFile = path.join(outDir, "winstt-paste.exe");

function log(msg) {
	console.log(`[winstt-paste] ${msg}`);
}

function ensureDir(dir) {
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function isUpToDate() {
	if (!fs.existsSync(outFile)) return false;
	if (!fs.existsSync(srcFile)) return true;
	try {
		return fs.statSync(outFile).mtimeMs >= fs.statSync(srcFile).mtimeMs;
	} catch {
		return false;
	}
}

function quote(p) {
	// cmd.exe doesn't use backslash escapes — just wrap in double quotes.
	// Paths with embedded quotes can't be passed to cmd.exe anyway.
	return `"${p}"`;
}

function findVcvars64() {
	const candidates = [
		"C:/Program Files/Microsoft Visual Studio/2022/BuildTools/VC/Auxiliary/Build/vcvars64.bat",
		"C:/Program Files/Microsoft Visual Studio/2022/Community/VC/Auxiliary/Build/vcvars64.bat",
		"C:/Program Files/Microsoft Visual Studio/2022/Professional/VC/Auxiliary/Build/vcvars64.bat",
		"C:/Program Files/Microsoft Visual Studio/2022/Enterprise/VC/Auxiliary/Build/vcvars64.bat",
		"C:/Program Files (x86)/Microsoft Visual Studio/2019/BuildTools/VC/Auxiliary/Build/vcvars64.bat",
		"C:/Program Files (x86)/Microsoft Visual Studio/2019/Community/VC/Auxiliary/Build/vcvars64.bat",
		"C:/Program Files (x86)/Microsoft Visual Studio/2019/Professional/VC/Auxiliary/Build/vcvars64.bat",
		"C:/Program Files (x86)/Microsoft Visual Studio/2019/Enterprise/VC/Auxiliary/Build/vcvars64.bat",
	];
	for (const candidate of candidates) {
		if (fs.existsSync(candidate)) return candidate;
	}
	return null;
}

function tryMsvc() {
	const vcvars = findVcvars64();
	if (!vcvars) {
		log("MSVC not found (no vcvars64.bat in Visual Studio install paths)");
		return false;
	}
	log(`Trying MSVC via ${vcvars}`);
	// Write a temp .bat file because cmd.exe quoting through Node's spawn is a
	// minefield — the arg parser will mangle backslash-escaped quotes inside
	// the call to vcvars64.bat. A .bat is unambiguous.
	const batFile = path.join(outDir, "_msvc_build.bat");
	fs.writeFileSync(
		batFile,
		[
			"@echo off",
			`call "${vcvars}"`,
			`cl /O2 /nologo "${srcFile}" /Fe:"${outFile}" user32.lib`,
		].join("\r\n"),
		"utf-8"
	);
	const result = spawnSync("cmd.exe", ["/c", batFile], {
		stdio: "inherit",
		cwd: outDir,
	});
	try {
		fs.unlinkSync(batFile);
	} catch {
		// best-effort
	}
	if (result.status === 0 && fs.existsSync(outFile)) {
		log("Built with MSVC");
		// MSVC drops .obj files in cwd; clean them up.
		for (const ext of [".obj", ".pdb"]) {
			const stray = path.join(outDir, `winstt-paste${ext}`);
			if (fs.existsSync(stray)) {
				try {
					fs.unlinkSync(stray);
				} catch {
					// best-effort
				}
			}
		}
		return true;
	}
	log("MSVC compile failed");
	return false;
}

function tryGcc() {
	const result = spawnSync("gcc", ["--version"], { stdio: "pipe", shell: true });
	if (result.status !== 0 || result.error) {
		log("gcc not on PATH");
		return false;
	}
	log("Trying gcc (MinGW-w64)");
	const compileResult = spawnSync("gcc", ["-O2", srcFile, "-o", outFile, "-luser32"], {
		stdio: "inherit",
		cwd: projectRoot,
		shell: false,
	});
	if (compileResult.status === 0 && fs.existsSync(outFile)) {
		log("Built with gcc");
		return true;
	}
	return false;
}

function tryClang() {
	const result = spawnSync("clang", ["--version"], { stdio: "pipe", shell: true });
	if (result.status !== 0 || result.error) {
		log("clang not on PATH");
		return false;
	}
	log("Trying clang");
	const compileResult = spawnSync("clang", ["-O2", srcFile, "-o", outFile, "-luser32"], {
		stdio: "inherit",
		cwd: projectRoot,
		shell: false,
	});
	if (compileResult.status === 0 && fs.existsSync(outFile)) {
		log("Built with clang");
		return true;
	}
	return false;
}

function main() {
	ensureDir(outDir);

	if (isUpToDate()) {
		log("Binary is up-to-date, skipping build");
		return;
	}

	if (tryMsvc()) return;
	if (tryGcc()) return;
	if (tryClang()) return;

	console.warn(
		"[winstt-paste] No compiler available — paste will fall back to the slower PowerShell path.\n" +
			"[winstt-paste] Install Visual Studio Build Tools, MinGW-w64, or LLVM/Clang to enable native paste."
	);
}

main();
