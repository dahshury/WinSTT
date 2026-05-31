#!/usr/bin/env node
/*
 * Compile electron/native/src/winstt-ocr.cpp → electron/native/bin/winstt-ocr.exe
 *
 * C++/WinRT (Windows.Media.Ocr) → MSVC + Windows SDK cppwinrt headers ONLY.
 * gcc/clang lack the SDK projection headers, so unlike the other two helpers
 * there is no fallback compiler. OCR is an OPTIONAL last-resort context
 * fallback: if MSVC/SDK isn't present, we WARN and skip — the app degrades to
 * UIA-only context (winstt-context.exe), which is the primary path anyway.
 * No-op on non-Windows. Skips if the binary is newer than the source.
 */
"use strict";

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

if (process.platform !== "win32") process.exit(0);

const projectRoot = path.resolve(__dirname, "..", "..");
const srcFile = path.join(projectRoot, "electron", "native", "src", "winstt-ocr.cpp");
const outDir = path.join(projectRoot, "electron", "native", "bin");
const outFile = path.join(outDir, "winstt-ocr.exe");

function log(msg) {
	console.log(`[winstt-ocr] ${msg}`);
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
		log("MSVC not found — skipping OCR helper (UIA context still works)");
		return false;
	}
	log(`Trying MSVC via ${vcvars}`);
	const batFile = path.join(outDir, "_msvc_ocr_build.bat");
	fs.writeFileSync(
		batFile,
		[
			"@echo off",
			`call "${vcvars}"`,
			// cppwinrt projection headers live under <SDK>\Include\<ver>\cppwinrt,
			// which vcvars does NOT add to INCLUDE — add it explicitly. The env
			// vars are set by vcvars64 (WindowsSDKVersion has a trailing backslash).
			"cl /std:c++17 /EHsc /O2 /nologo " +
				'/I"%WindowsSdkDir%Include\\%WindowsSDKVersion%cppwinrt" ' +
				`"${srcFile}" /Fe:"${outFile}" ` +
				"/link windowsapp.lib gdi32.lib user32.lib",
		].join("\r\n"),
		"utf-8"
	);
	const result = spawnSync("cmd.exe", ["/c", batFile], { stdio: "inherit", cwd: outDir });
	try {
		fs.unlinkSync(batFile);
	} catch {
		// best-effort
	}
	if (result.status === 0 && fs.existsSync(outFile)) {
		log("Built with MSVC (C++/WinRT)");
		for (const ext of [".obj", ".pdb"]) {
			const stray = path.join(outDir, `winstt-ocr${ext}`);
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

function main() {
	ensureDir(outDir);
	if (isUpToDate()) {
		log("Binary is up-to-date, skipping build");
		return;
	}
	if (tryMsvc()) return;
	console.warn(
		"[winstt-ocr] No MSVC/Windows SDK — OCR fallback unavailable. " +
			"Context awareness still works via UIA (winstt-context.exe)."
	);
}

main();
