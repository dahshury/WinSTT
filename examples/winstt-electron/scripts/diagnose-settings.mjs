// Runs the renderer's exact settings-codec against the on-disk JSON to
// surface WHICH field is failing validation. The .mjs is run via bun.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const f = "C:/Users/MASTE/AppData/Roaming/winstt/winstt-settings.json";
const rawText = readFileSync(f, "utf-8").replace(/^﻿/, "");
const raw = JSON.parse(rawText);

// Load the renderer's schema. We need it from the frontend/src tree —
// import via the bun's TS support.
const { appSettingsSchema } = await import(
	"file:///" + join(import.meta.dirname, "..", "frontend", "src", "shared", "config", "settings-schema.ts").replace(/\\/g, "/")
);

const result = appSettingsSchema.safeParse(raw);
if (result.success) {
	console.log("SAFEPARSE OK — disk passes schema");
	console.log("  model.model =", result.data.model.model);
	process.exit(0);
}

console.log("SAFEPARSE FAILED");
console.log("Issues:");
for (const issue of result.error.issues) {
	console.log(`  - path=${issue.path.join(".")}  code=${issue.code}  msg=${issue.message}`);
}
