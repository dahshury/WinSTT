import { cpSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

const standaloneRoot = path.join(projectRoot, "out", "standalone");
const standaloneServer = path.join(standaloneRoot, "server.js");
const sourceStaticDir = path.join(projectRoot, "out", "static");
const targetStaticDir = path.join(standaloneRoot, "out", "static");
const sourcePublicDir = path.join(projectRoot, "public");
const targetPublicDir = path.join(standaloneRoot, "public");

if (!existsSync(standaloneServer)) {
	throw new Error(
		`Next standalone server not found at ${standaloneServer}. Run "bun run build" first.`
	);
}

if (!existsSync(sourceStaticDir)) {
	throw new Error(`Next static assets not found at ${sourceStaticDir}.`);
}

mkdirSync(path.dirname(targetStaticDir), { recursive: true });
cpSync(sourceStaticDir, targetStaticDir, { force: true, recursive: true });

if (existsSync(sourcePublicDir)) {
	cpSync(sourcePublicDir, targetPublicDir, { force: true, recursive: true });
}

console.log("[prepare-next-standalone] copied out/static -> out/standalone/out/static");
if (existsSync(sourcePublicDir)) {
	console.log("[prepare-next-standalone] copied public -> out/standalone/public");
}
