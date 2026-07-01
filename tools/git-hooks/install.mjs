#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const hooksDir = resolve(repoRoot, ".husky");

if (!existsSync(hooksDir)) {
	process.exit(0);
}

const revParse = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
	cwd: repoRoot,
	encoding: "utf8",
	stdio: ["ignore", "pipe", "ignore"],
});

if (revParse.status !== 0 || revParse.stdout.trim() !== "true") {
	process.exit(0);
}

const config = spawnSync("git", ["config", "core.hooksPath", ".husky"], {
	cwd: repoRoot,
	stdio: "inherit",
});

process.exit(config.status ?? 1);
