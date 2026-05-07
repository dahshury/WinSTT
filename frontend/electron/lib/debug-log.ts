import fs from "node:fs";
import path from "node:path";
import { app } from "electron";

function getLogPath(): string {
	// Prefer userData (e.g. %APPDATA%/WinSTT/) for log storage.
	// Falls back to the project root only during very early startup before app is ready.
	try {
		return path.join(app.getPath("userData"), "debug.log");
	} catch {
		return path.join(import.meta.dirname, "..", "..", "debug.log");
	}
}

let logStream: fs.WriteStream | null = null;

// Truncate on startup so each run is a fresh log.
try {
	logStream = fs.createWriteStream(getLogPath(), { flags: "w" });
	logStream.write(`=== WinSTT Debug Log — ${new Date().toISOString()} ===\n`);
	logStream.on("error", () => {
		logStream = null;
	});
} catch {
	// ignore
}

process.on("exit", () => {
	logStream?.end();
});

const VERBOSE_TERMINAL = process.env.WINSTT_VERBOSE === "1" || process.argv.includes("--verbose");

function format(tag: string, args: unknown[]): string {
	const ts = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
	const msg = args
		.map((a) => {
			if (typeof a === "string") {
				return a;
			}
			try {
				return JSON.stringify(a);
			} catch {
				return String(a);
			}
		})
		.join(" ");
	return `[${ts}] [${tag}] ${msg}\n`;
}

export function dbg(tag: string, ...args: unknown[]): void {
	const line = format(tag, args);
	try {
		logStream?.write(line);
	} catch {
		// ignore
	}
	console.log(line.trimEnd());
}

/**
 * Verbose log: always written to the file log, but only printed to the terminal
 * when WINSTT_VERBOSE=1 (or `--verbose` CLI flag) is set. Use for high-frequency
 * traces (raw WS frames, per-keystroke hotkey events, per-VAD-transition lines).
 */
export function dbgVerbose(tag: string, ...args: unknown[]): void {
	const line = format(tag, args);
	try {
		logStream?.write(line);
	} catch {
		// ignore
	}
	if (VERBOSE_TERMINAL) {
		console.log(line.trimEnd());
	}
}
