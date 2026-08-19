#!/usr/bin/env node
// Local mirror of the Rust CI gate (rust-ci.yml: fmt -> clippy).
//
// Both checks used to run only in CI, so an unformatted or clippy-dirty commit
// could pass every local hook and still turn `main` red. This runs the exact CI
// commands before the push instead.
//
// On Windows, cargo cannot link from a bare Git Bash shell (lld-link.exe is not
// on PATH), so the commands are routed through vcvars64.bat + LLVM the same way
// a developer shell would be set up. When no usable toolchain is found the check
// reports a skip rather than failing: CI remains the hard gate, and a machine
// without the Rust toolchain must still be able to push frontend-only work.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const crateDir = join(repoRoot, "src-tauri");

const CHECKS = [
	{ label: "cargo fmt", args: "fmt --all -- --check" },
	{
		label: "cargo clippy",
		args: "clippy --all-targets --locked -- -D warnings",
	},
];

const VS_EDITIONS = ["Community", "Professional", "Enterprise", "BuildTools"];

/** vcvars64.bat path for the newest Visual Studio install, or null. */
function findVcvars() {
	const vswhere = join(
		process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
		"Microsoft Visual Studio/Installer/vswhere.exe",
	);
	if (existsSync(vswhere)) {
		// `-products *` is required or vswhere silently ignores standalone Build Tools
		// installs, which is the only "Visual Studio" on plenty of build machines.
		const found = spawnSync(
			vswhere,
			["-latest", "-products", "*", "-property", "installationPath"],
			{
				encoding: "utf8",
			},
		);
		const root = found.stdout?.trim().split(/\r?\n/)[0];
		if (root) {
			const bat = join(root, "VC/Auxiliary/Build/vcvars64.bat");
			if (existsSync(bat)) {
				return bat;
			}
		}
	}
	// vswhere is itself optional; fall back to the conventional layout. Build Tools
	// installs under Program Files (x86), so both roots have to be searched.
	const programRoots = [
		process.env.ProgramFiles ?? "C:\\Program Files",
		process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
	];
	for (const programRoot of programRoots) {
		for (const version of ["18", "2022", "17"]) {
			for (const edition of VS_EDITIONS) {
				const bat = join(
					programRoot,
					`Microsoft Visual Studio/${version}/${edition}/VC/Auxiliary/Build/vcvars64.bat`,
				);
				if (existsSync(bat)) {
					return bat;
				}
			}
		}
	}
	return null;
}

function runWindows(check) {
	const vcvars = findVcvars();
	if (!vcvars) {
		return null;
	}
	const llvm = join(
		process.env.ProgramFiles ?? "C:\\Program Files",
		"LLVM/bin",
	);
	// .cargo/config.toml selects lld-link.exe purely because it links this binary far
	// faster than the MSVC linker. Without LLVM installed that is a hard "linker not
	// found" error, so fall back to the link.exe vcvars64 just put on PATH.
	const llvmInstalled = existsSync(join(llvm, "lld-link.exe"));
	const script = join(mkdtempSync(join(tmpdir(), "winstt-rust-")), "check.bat");
	writeFileSync(
		script,
		[
			"@echo off",
			`call "${vcvars}" >nul 2>&1`,
			...(llvmInstalled
				? [`set PATH=${llvm};%PATH%`]
				: ["set CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER=link.exe"]),
			`cd /d "${crateDir}"`,
			`cargo ${check.args}`,
		].join("\r\n"),
	);
	const shell = process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe";
	return spawnSync(shell, ["/c", script], { stdio: "inherit" }).status ?? 1;
}

function run(check) {
	if (process.platform === "win32") {
		const status = runWindows(check);
		if (status !== null) {
			return status;
		}
	}
	return (
		spawnSync("cargo", check.args.split(" "), {
			cwd: crateDir,
			stdio: "inherit",
		}).status ?? 1
	);
}

if (spawnSync("cargo", ["--version"], { stdio: "ignore" }).status !== 0) {
	process.stdout.write(
		"• rust: cargo not found — skipping fmt/clippy (CI still gates them)\n",
	);
	process.exit(0);
}

for (const check of CHECKS) {
	process.stdout.write(`• rust: ${check.label}\n`);
	const status = run(check);
	if (status !== 0) {
		process.stderr.write(
			`\n✗ ${check.label} failed. This is the same command rust-ci.yml runs —\n` +
				"  fix it here rather than discovering it after the push.\n" +
				(check.label === "cargo fmt"
					? "  Run: bun run format:backend\n"
					: "  Clippy suggests a fix for most lints; do not silence them with #[allow].\n"),
		);
		process.exit(status);
	}
}

process.stdout.write("✓ rust: fmt + clippy clean\n");
