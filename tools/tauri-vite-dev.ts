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
