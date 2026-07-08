import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = resolve(here, "../../src");
const publicDir = resolve(here, "../../public");
const runsFile = resolve(here, "../out/benchmark-runs.json");
const tauriStub = resolve(here, "tauri-stub.ts");

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((res, rej) => {
		let raw = "";
		req.on("data", (c) => {
			raw += c;
		});
		req.on("end", () => res(raw));
		req.on("error", rej);
	});
}

function json(res: ServerResponse, status: number, body: unknown): void {
	res.statusCode = status;
	res.setHeader("content-type", "application/json");
	res.end(JSON.stringify(body));
}

function readRuns(): unknown[] {
	if (!existsSync(runsFile)) return [];
	try {
		const parsed = JSON.parse(readFileSync(runsFile, "utf8"));
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

/** Dev-server middleware backing an append-only JSON file of benchmark runs.
 *  GET → all runs, POST → append one, DELETE → clear. */
function benchmarkPersistence(): Plugin {
	return {
		name: "benchmark-runs-persistence",
		configureServer(server) {
			server.middlewares.use("/api/benchmark-runs", (req, res) => {
				void (async () => {
					if (req.method === "GET") {
						json(res, 200, { runs: readRuns() });
						return;
					}
					if (req.method === "POST") {
						const run = JSON.parse((await readBody(req)) || "{}");
						const runs = readRuns();
						runs.push(run);
						mkdirSync(dirname(runsFile), { recursive: true });
						writeFileSync(runsFile, `${JSON.stringify(runs, null, "\t")}\n`);
						json(res, 200, { ok: true, count: runs.length });
						return;
					}
					if (req.method === "DELETE") {
						mkdirSync(dirname(runsFile), { recursive: true });
						writeFileSync(runsFile, "[]\n");
						json(res, 200, { ok: true });
						return;
					}
					json(res, 405, { error: "method not allowed" });
				})().catch((err) => json(res, 500, { error: String(err) }));
			});
		},
	};
}

const stubTauri = (find: RegExp) => ({ find, replacement: tauriStub });

export default defineConfig({
	root: here,
	publicDir,
	plugins: [react(), tailwindcss(), benchmarkPersistence()],
	resolve: {
		alias: [
			// App components that transitively import Tauri get a browser stub.
			stubTauri(/^@tauri-apps\/api$/),
			stubTauri(/^@tauri-apps\/api\/.*/),
			stubTauri(/^@tauri-apps\/plugin-.*/),
			{ find: /^@\/(.*)$/, replacement: `${srcDir}/$1` },
		],
	},
	server: { port: 5273, strictPort: false },
});
