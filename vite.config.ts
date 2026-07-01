import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { visualizer } from "rollup-plugin-visualizer";
import { defineConfig } from "vite";
import {
	readDevSettings,
	resolveWinsttAppDataDir,
	writeDevSettings,
} from "./tools/winstt-dev-settings-store";

const rootDir = fileURLToPath(new URL(".", import.meta.url));
const host = process.env["TAURI_DEV_HOST"];
const devServerHost = host || "127.0.0.1";

function sendJson(res: ServerResponse, status: number, body: unknown): void {
	res.statusCode = status;
	res.setHeader("Content-Type", "application/json; charset=utf-8");
	res.end(JSON.stringify(body));
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
	return new Promise((resolveBody, reject) => {
		let raw = "";
		req.setEncoding("utf8");
		req.on("data", (chunk: string) => {
			raw += chunk;
		});
		req.on("end", () => {
			if (raw.trim() === "") {
				resolveBody({});
				return;
			}
			try {
				resolveBody(JSON.parse(raw) as unknown);
			} catch (err) {
				reject(err);
			}
		});
		req.on("error", reject);
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function winsttDevSettingsBridge() {
	return {
		name: "winstt-dev-settings-bridge",
		apply: "serve" as const,
		configureServer(server: {
			middlewares: {
				use: (
					path: string,
					handler: (req: IncomingMessage, res: ServerResponse) => void,
				) => void;
			};
		}) {
			server.middlewares.use("/__winstt/settings", (req, res) => {
				void (async () => {
					try {
						if (req.method === "GET") {
							sendJson(res, 200, {
								appDataDir: resolveWinsttAppDataDir(),
								settings: await readDevSettings(),
							});
							return;
						}
						if (req.method === "POST" || req.method === "PATCH") {
							const body = await readJsonBody(req);
							const patch = isRecord(body) ? body["settings"] : undefined;
							sendJson(res, 200, { settings: await writeDevSettings(patch) });
							return;
						}
						sendJson(res, 405, { error: "Method not allowed" });
					} catch (err) {
						sendJson(res, 500, {
							error: err instanceof Error ? err.message : String(err),
						});
					}
				})();
			});
		},
	};
}

// Multi-page Vite config for the Tauri renderer (ported from WinSTT's the reference
// renderer `frontend/vite.config.ts`). Each Tauri WebviewWindow loads its own
// HTML file (main at the root, secondary windows under windows/). Output → `dist`
// (Tauri `frontendDist: "../dist"`); dev server on the Tauri-fixed port 1420.
//
// `base: "./"` keeps asset paths relative so the packaged `file://`-style load
// of each window's HTML resolves assets from the HTML file's directory.
export default defineConfig(({ command }) => {
	// react-compiler is a babel pass over every .tsx in the graph. It only
	// matters for production (ships memoization), and at dev time it dominates
	// first-window paint (~8 s). Gate it on `vite build` (production) only.
	const isProdBuild = command === "build";
	const isAnalyzeBuild =
		isProdBuild &&
		(process.env["ANALYZE"] === "1" || process.env["VITE_ANALYZE"] === "1");
	const includeContextPlayground =
		!isProdBuild ||
		process.env["CONTEXT_PLAYGROUND"] === "1" ||
		process.env["VITE_CONTEXT_PLAYGROUND"] === "1";
	return {
		root: rootDir,
		base: "./",
		// Vite 8 resolves tsconfig `paths` (@/*) natively — replaces
		// vite-tsconfig-paths.
		resolve: { tsconfigPaths: true },
		plugins: [
			// `messages/*.json` are pulled in via a dynamic `import()` in
			// IntlProvider (`shared/i18n/loadMessages`), which HMR does NOT re-run on
			// a JSON edit — so adding/changing a key otherwise leaves the running app
			// rendering raw key paths (e.g. `settings.appDataUsageTitle`) until a
			// manual reload. Force a full reload on any message change so new keys
			// resolve immediately.
			{
				name: "winstt-i18n-full-reload",
				handleHotUpdate({ file, server }) {
					const normalized = file.replaceAll("\\", "/");
					if (
						normalized.includes("/messages/") &&
						normalized.endsWith(".json")
					) {
						server.ws.send({ type: "full-reload" });
						return [];
					}
					return undefined;
				},
			},
			winsttDevSettingsBridge(),
			react(),
			...(isProdBuild ? [babel({ presets: [reactCompilerPreset()] })] : []),
			tailwindcss(),
			// Optional build-only bundle treemap writes dist/stats.html. Enable with
			// ANALYZE=1 or VITE_ANALYZE=1 when inspecting chunk layout (including
			// the per-locale lazy split).
			...(isAnalyzeBuild
				? [
						visualizer({
							filename: "dist/stats.html",
							gzipSize: true,
							template: "treemap",
						}),
					]
				: []),
		],
		// Tauri: don't obscure Rust errors; ignore src-tauri in the watcher.
		clearScreen: false,
		envPrefix: ["VITE_", "TAURI_ENV_*"],
		optimizeDeps: {
			include: [
				"react",
				"react-dom",
				"react-dom/client",
				"react/jsx-runtime",
				"react/jsx-dev-runtime",
				"use-intl",
				"use-intl/react",
				"zustand",
				"zustand/middleware",
				"zustand/shallow",
				"motion",
				"motion/react",
				"virtua",
				"zod",
				"tailwind-merge",
				"clsx",
				"class-variance-authority",
				"double-metaphone",
				"@hugeicons/react",
				"@hugeicons/core-free-icons",
				"@base-ui/react",
				"@tauri-apps/api/core",
				"@tauri-apps/api/event",
				"@tauri-apps/api/window",
			],
		},
		build: {
			outDir: "dist",
			emptyOutDir: true,
			sourcemap: false,
			// Tauri's webview (WebView2 / WebKitGTK) supports the modern ES surface.
			target: "esnext",
			modulePreload: false,
			reportCompressedSize: false,
			rollupOptions: {
				input: {
					// `main` stays at the root so the Tauri dev server serves it from `/`.
					// Secondary windows live under `windows/`; build output mirrors
					// the input layout (dist/windows/*).
					main: resolve(rootDir, "index.html"),
					settings: resolve(rootDir, "windows/settings.html"),
					overlay: resolve(rootDir, "windows/overlay.html"),
					"tray-menu": resolve(rootDir, "windows/tray-menu.html"),
					"model-picker": resolve(rootDir, "windows/model-picker.html"),
					"device-picker": resolve(rootDir, "windows/device-picker.html"),
					"model-footprint": resolve(rootDir, "windows/model-footprint.html"),
					onboarding: resolve(rootDir, "windows/onboarding.html"),
					history: resolve(rootDir, "windows/history.html"),
					...(includeContextPlayground
						? {
								"context-playground": resolve(
									rootDir,
									"windows/context-playground.html",
								),
							}
						: {}),
				},
				output: {
					manualChunks: (id) => {
						const normalizedId = id.replaceAll("\\", "/");
						if (normalizedId.includes("node_modules")) {
							if (normalizedId.includes("@base-ui/")) {
								return "vendor-base-ui";
							}
							if (
								normalizedId.includes("react-dom") ||
								normalizedId.includes("/react/")
							) {
								return "vendor-react";
							}
							if (
								normalizedId.includes("/motion/") ||
								normalizedId.includes("framer-motion")
							) {
								return "vendor-motion";
							}
							if (normalizedId.includes("@hugeicons/")) {
								return "vendor-hugeicons";
							}
							if (
								normalizedId.includes("use-intl") ||
								normalizedId.includes("@formatjs/")
							) {
								return "vendor-intl";
							}
							if (normalizedId.includes("zustand")) {
								return "vendor-zustand";
							}
						}
						return undefined;
					},
				},
			},
		},
		server: {
			// Tauri expects a fixed port and fails if it's not available.
			port: 1420,
			strictPort: true,
			host: devServerHost,
			// WebView2 aggressively disk-caches dev assets and keeps serving stale
			// JS/JSON across reloads (and even dev-server restarts) — the reason
			// past UI fixes and newly-added i18n keys "never load" until the cache
			// is manually cleared. `no-store` makes the dev server tell the webview
			// never to cache, so a reload always picks up the latest modules.
			headers: { "Cache-Control": "no-store" },
			// Omit `hmr` entirely when there's no TAURI_DEV_HOST — under
			// `exactOptionalPropertyTypes` an explicit `hmr: undefined` is rejected,
			// so spread the key in conditionally instead.
			...(host
				? {
						hmr: {
							protocol: "ws",
							host,
							port: 1421,
						},
					}
				: {}),
			watch: {
				// Tell Vite to ignore watching `src-tauri`.
				ignored: ["**/src-tauri/**"],
			},
			// Warm only the main entry so its module graph is transformed in the
			// background; warming every entry regresses first-paint.
			warmup: { clientFiles: ["./src/entries/main.tsx"] },
		},
	};
});
