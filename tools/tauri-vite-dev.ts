// Tauri `beforeDevCommand` for the renderer dev server.
//
// MUST run under node, NOT bun (`tauri.conf.json` invokes
// `node tools/tauri-vite-dev.ts`). Under the bun runtime, Vite 8's
// (rolldown-vite) dev HTTP server *binds* the socket — it even shows up as a
// listener and `server.listen()` resolves + `printUrls()` prints — but it
// never actually services requests, so every connection to :1420 is refused.
// Tauri then times out waiting for the dev URL and the WebViews load a dead
// page (ERR_CONNECTION_REFUSED). node serves correctly. Node >= 22.18 strips
// the TS types in this file natively, no flag needed.
//
// This is a single long-lived process on purpose: Tauri kills the
// beforeDevCommand process directly on exit, and a single process (vs.
// `bun run dev`, which spawns vite as a child) avoids orphaning a server that
// would keep holding :1420 and break the next `tauri dev` via `strictPort`.
import { createServer, type ViteDevServer } from "vite";

let server: ViteDevServer | undefined;
let shuttingDown = false;

async function shutdown(code: number): Promise<never> {
	if (shuttingDown) {
		process.exit(code);
	}

	shuttingDown = true;
	try {
		await server?.close();
	} catch {
		// The Tauri dev supervisor is already tearing this process down.
	}
	process.exit(code);
}

function fatal(error: unknown): never {
	if (shuttingDown) {
		process.exit(0);
	}

	console.error(error);
	process.exit(1);
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"] as const) {
	process.on(signal, () => {
		void shutdown(0);
	});
}

process.on("uncaughtException", fatal);
process.on("unhandledRejection", fatal);

try {
	server = await createServer();
	await server.listen();
	server.printUrls();
} catch (error) {
	fatal(error);
}

await new Promise(() => {});
