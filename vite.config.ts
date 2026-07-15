import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
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

const CORE_PRELOAD_PREFIXES = [
	"react-",
	"globals-",
	"ipc-client-",
	"setting-",
	"springs-",
	"audio-visualizer-",
	"update-settings-",
	"connect-server-",
	"listen-mode-",
] as const;

function resolveModulePreloads(
	_filename: string,
	dependencies: string[],
	context: { hostId: string; hostType: "html" | "js" },
): string[] {
	if (context.hostType !== "html") {
		return dependencies;
	}

	return dependencies.filter((dependency) => {
		const fileName = dependency.slice(dependency.lastIndexOf("/") + 1);
		return CORE_PRELOAD_PREFIXES.some((prefix) => fileName.startsWith(prefix));
	});
}

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

let devSettingsRevision = 0;

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
								revision: devSettingsRevision,
								settings: await readDevSettings(),
							});
							return;
						}
						if (req.method === "POST" || req.method === "PATCH") {
							const body = await readJsonBody(req);
							const patch = isRecord(body) ? body["settings"] : undefined;
							const baseRevision = isRecord(body)
								? body["baseRevision"]
								: undefined;
							if (
								typeof baseRevision === "number" &&
								baseRevision !== devSettingsRevision
							) {
								sendJson(res, 200, {
									applied: false,
									changedSections: [],
									revision: devSettingsRevision,
									settings: await readDevSettings(),
								});
								return;
							}
							const settings = await writeDevSettings(patch);
							devSettingsRevision += 1;
							sendJson(res, 200, {
								applied: true,
								changedSections: isRecord(patch) ? Object.keys(patch) : [],
								revision: devSettingsRevision,
								settings,
							});
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

const hugeiconsBarrelImport =
	/import\s*\{([^}]+)\}\s*from\s*["']@hugeicons\/core-free-icons["'];?/g;
let hugeiconsExportModules: Map<string, string> | undefined;

function hugeiconsModuleFor(exportName: string): string {
	if (!hugeiconsExportModules) {
		const indexSource = readFileSync(
			resolve(
				rootDir,
				"node_modules/@hugeicons/core-free-icons/dist/esm/index.js",
			),
			"utf8",
		);
		hugeiconsExportModules = new Map();
		for (const match of indexSource.matchAll(
			/export \{([^}]+)\} from ['"]\.\/([^'"]+)\.js['"];/g,
		)) {
			const [, specifiers, moduleName] = match;
			if (!specifiers || !moduleName) {
				continue;
			}
			for (const exportMatch of specifiers.matchAll(/default as (\w+)/g)) {
				const exportName = exportMatch[1];
				if (exportName) {
					hugeiconsExportModules.set(exportName, moduleName);
				}
			}
		}
	}

	const moduleName = hugeiconsExportModules.get(exportName);
	if (!moduleName) {
		throw new Error(`Hugeicons export ${exportName} has no direct ESM module`);
	}
	return moduleName;
}

/**
 * The Hugeicons root barrel re-exports several thousand icon modules. Rolldown
 * must parse all of them even though WinSTT uses only a small subset. Keep the
 * ergonomic, type-checked named imports in source and lower them to direct ESM
 * modules before Vite resolves dependencies.
 */
function hugeiconsDirectImports() {
	return {
		name: "winstt-hugeicons-direct-imports",
		// Rolldown handles the large barrel efficiently in production, while the
		// dev server benefits from avoiding thousands of eagerly scanned modules.
		apply: "serve" as const,
		enforce: "pre" as const,
		transform: {
			// Rolldown evaluates these native filters before crossing into this JS
			// hook. Without them, calling an otherwise-cheap transform for every
			// module costs more than the barrel optimization saves.
			filter: {
				id: { include: /\.[cm]?[jt]sx?$/, exclude: /node_modules/ },
				code: /@hugeicons\/core-free-icons/,
			},
			handler(code: string, id: string) {
				let transformed = false;
				const output = code.replace(
					hugeiconsBarrelImport,
					(_match, names: string) => {
						const directImports = names
							.split(",")
							.map((name) => name.trim())
							.filter(Boolean)
							.map((specifier) => {
								const [imported, local = imported] =
									specifier.split(/\s+as\s+/);
								if (!imported) {
									throw new Error(`Invalid Hugeicons import in ${id}`);
								}
								const moduleName = hugeiconsModuleFor(imported);
								return `import ${local} from "@hugeicons/core-free-icons/${moduleName}";`;
							});
						transformed = directImports.length > 0;
						return directImports.join("\n");
					},
				);

				return transformed ? { code: output, map: null } : undefined;
			},
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
			hugeiconsDirectImports(),
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
			// Settings panels are lazy modules, so their component entry points are
			// discovered after the initial dependency crawl unless Vite expands the
			// package exports up front. A late optimizer rebuild invalidates dynamic
			// imports that are already in flight (most visibly the Appearance panel).
			// Hugeicons is already lowered to small direct ESM imports by the plugin
			// above; excluding its full package prefix keeps each newly seen icon from
			// triggering another optimizer rebuild.
			exclude: ["@hugeicons/core-free-icons"],
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
				"@base-ui/react",
				"@base-ui/react/*",
				"@tauri-apps/api/core",
				"@tauri-apps/api/event",
				"@tauri-apps/api/window",
			],
		},
		build: {
			outDir: "dist",
			emptyOutDir: true,
			// Keep a machine-readable graph beside the HTML so CI can enforce the
			// real main-window startup budget (static imports only; lazy surfaces are
			// intentionally excluded).
			manifest: true,
			sourcemap: false,
			// Tauri's webview (WebView2 / WebKitGTK) supports the modern ES surface.
			target: "esnext",
			// All supported Tauri webviews implement native modulepreload. Restore a
			// bounded set of graph-specific hints without shipping Vite's compatibility
			// polyfill. Each HTML entry receives only core chunks from its own static
			// graph, avoiding both cross-window leakage and an eager request per tiny
			// icon/helper chunk. Dynamic feature imports retain Vite's normal on-demand
			// dependency preloading when the user opens them.
			modulePreload: {
				polyfill: false,
				resolveDependencies: resolveModulePreloads,
			},
			reportCompressedSize: false,
			rolldownOptions: {
				onLog(level, log, handler) {
					// Hugeicons publishes array literals with a misplaced PURE marker.
					// Rolldown safely ignores it, but reporting the same third-party
					// warning thousands of times floods and slows release-build output.
					if (
						log.code === "INVALID_ANNOTATION" &&
						log.id?.includes("@hugeicons/core-free-icons")
					) {
						return;
					}
					handler(level, log);
				},
				input: {
					// `main` stays at the root so the Tauri dev server serves it from `/`.
					// Secondary windows live under `windows/`; build output mirrors
					// the input layout (dist/windows/*).
					main: resolve(rootDir, "index.html"),
					settings: resolve(rootDir, "windows/settings.html"),
					"whats-new": resolve(rootDir, "windows/whats-new.html"),
					overlay: resolve(rootDir, "windows/overlay.html"),
					"tray-menu": resolve(rootDir, "windows/tray-menu.html"),
					"tray-indicator": resolve(rootDir, "windows/tray-indicator.html"),
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
				// Let Rolldown split by the actual multi-entry import graph. Broad
				// package-level vendor chunks make the small main pill download and
				// parse Base UI, Motion, and icon modules that are only used by
				// settings/onboarding windows. Automatic shared chunks preserve reuse
				// where graphs overlap without pulling secondary-window code into the
				// startup path.
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
				// These repo-local trees are outside the renderer. In particular, Vite
				// does not inherit `.gitignore`, so vendored apps under `examples/`
				// otherwise trigger unrelated full-page reloads when their HTML changes.
				ignored: ["**/src-tauri/**", "**/examples/**"],
			},
			// Warm only the main entry so its module graph is transformed in the
			// background; warming every entry regresses first-paint.
			warmup: { clientFiles: ["./src/entries/main.tsx"] },
		},
	};
});
