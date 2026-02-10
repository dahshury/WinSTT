import fs from "node:fs";
import path from "node:path";

const LOG_PATH = path.join(import.meta.dirname, "..", "..", "debug.log");

// Truncate on startup so each run is a fresh log
try {
	fs.writeFileSync(LOG_PATH, `=== WinSTT Debug Log — ${new Date().toISOString()} ===\n`);
} catch {
	// ignore
}

export function dbg(tag: string, ...args: unknown[]) {
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
	const line = `[${ts}] [${tag}] ${msg}\n`;
	try {
		fs.appendFileSync(LOG_PATH, line);
	} catch {
		// ignore
	}
	// Also keep in terminal for convenience
	console.log(line.trimEnd());
}
