// Measure vite cold-start time: spawn vite dev with a unique cacheDir+port,
// capture "ready in N ms" + "optimized X deps in Y ms", then SIGTERM.
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const cacheDir = path.resolve(__dirname, "..", "node_modules", ".vite-profile");
fs.rmSync(cacheDir, { recursive: true, force: true });

const config = process.argv[2] || "vite.profile.config.ts";
const startedAt = Date.now();
const useSandbox = process.argv[3] === "sandbox";
const args = ["vite", "--config", config, "--port", useSandbox ? "3098" : "3099", "--strictPort"];
const env = useSandbox ? { ...process.env, VITE_CACHE_DIR_OVERRIDE: cacheDir } : process.env;
const child = spawn("bunx", args, {
	cwd: path.resolve(__dirname, ".."),
	shell: true,
	stdio: ["ignore", "pipe", "pipe"],
	env,
});

let captured = false;
let readyAt = 0;
const lines = [];
async function hitEntries() {
	const entries = [
		"/index.html",
		"/src/entries/main.tsx",
		"/windows/settings.html",
		"/src/entries/settings.tsx",
		"/windows/overlay.html",
		"/src/entries/overlay.tsx",
	];
	for (const p of entries) {
		const t0 = Date.now();
		try {
			const res = await fetch(`http://localhost:3099${p}`);
			const body = await res.text();
			const dt = Date.now() - t0;
			console.log(`[measure] GET ${p} → ${res.status} (${dt} ms, ${body.length} B)`);
		} catch (e) {
			console.log(`[measure] GET ${p} → ERROR: ${e.message}`);
		}
	}
}
function onChunk(buf) {
	const text = String(buf);
	for (const line of text.split(/\r?\n/)) {
		if (!line.trim()) continue;
		lines.push(line);
		if (!captured && /ready in/i.test(line)) {
			captured = true;
			readyAt = Date.now();
			console.log(`[measure] wall to "ready" = ${readyAt - startedAt} ms`);
			// Wait long enough for server.warmup to make progress. The first
			// request still pays for whatever warmup hasn't finished, but
			// giving it some lead time mirrors real cold start (Python boot
			// is on the wall-clock between Vite ready and Electron loadURL).
			setTimeout(hitEntries, 50);
		}
	}
}
setTimeout(() => {
	if (captured) {
		console.log(`[measure] total wall = ${Date.now() - startedAt} ms`);
		console.log("[measure] vite output:");
		for (const l of lines) console.log("  " + l);
		child.kill("SIGTERM");
		process.exit(0);
	}
}, 30_000);
child.stdout.on("data", onChunk);
child.stderr.on("data", onChunk);
child.on("exit", (code) => {
	if (!captured) {
		console.log(`vite exited (code=${code}) without reaching "ready". Last 30 lines:`);
		console.log(lines.slice(-30).join("\n"));
		process.exit(1);
	}
});
setTimeout(() => {
	if (!captured) {
		console.log("timed out waiting for ready");
		child.kill("SIGTERM");
		process.exit(1);
	}
}, 90_001);
