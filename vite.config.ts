import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { visualizer } from "rollup-plugin-visualizer";
import { defineConfig } from "vite";

const rootDir = fileURLToPath(new URL(".", import.meta.url));
const host = process.env.TAURI_DEV_HOST;

// Multi-page Vite config for the Tauri renderer (ported from WinSTT's the reference
// renderer `frontend/vite.config.ts`). Each Tauri WebviewWindow loads its own
// HTML file (main at the root, 8 secondary under windows/). Output → `dist`
// (Tauri `frontendDist: "../dist"`); dev server on the Tauri-fixed port 1420.
//
// `base: "./"` keeps asset paths relative so the packaged `file://`-style load
// of each window's HTML resolves assets from the HTML file's directory.
export default defineConfig(({ command }) => {
	// react-compiler is a babel pass over every .tsx in the graph. It only
	// matters for production (ships memoization), and at dev time it dominates
	// first-window paint (~8 s). Gate it on `vite build` (production) only.
	const isProdBuild = command === "build";
	return {
		root: rootDir,
		base: "./",
		// Vite 8 resolves tsconfig `paths` (@/*, @spec/*, @picker, @picker/*)
		// natively — replaces vite-tsconfig-paths.
		resolve: { tsconfigPaths: true },
		plugins: [
			react(),
			...(isProdBuild ? [babel({ presets: [reactCompilerPreset()] })] : []),
			tailwindcss(),
			// Build-only bundle treemap → dist/stats.html, so chunk layout (and the
			// per-locale lazy split) stays visible. Never runs in dev.
			...(isProdBuild
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
				"fuse.js",
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
			reportCompressedSize: false,
			rollupOptions: {
				input: {
					// `main` stays at the root so the Tauri dev server serves it from `/`.
					// The 8 secondary windows live under `windows/`; build output mirrors
					// the input layout (dist/windows/*).
					main: resolve(rootDir, "index.html"),
					settings: resolve(rootDir, "windows/settings.html"),
					overlay: resolve(rootDir, "windows/overlay.html"),
					"tray-menu": resolve(rootDir, "windows/tray-menu.html"),
					"model-picker": resolve(rootDir, "windows/model-picker.html"),
					"device-picker": resolve(rootDir, "windows/device-picker.html"),
					onboarding: resolve(rootDir, "windows/onboarding.html"),
					history: resolve(rootDir, "windows/history.html"),
					// Debug-only context-awareness playground (CONTEXT_PLAYGROUND_ENABLED).
					"context-playground": resolve(rootDir, "windows/context-playground.html"),
				},
				output: {
					manualChunks: (id) => {
						if (id.includes("node_modules")) {
							// INVARIANT: React core, react-dom, and @base-ui/* must share
							// ONE chunk. Splitting them produces circular ESM imports
							// between vendor-react and vendor-base-ui and crashes the
							// webview with "Cannot read properties of undefined (reading
							// 'useLayoutEffect')" on an unbound React namespace.
							if (
								id.includes("@base-ui/") ||
								id.includes("react-dom") ||
								id.includes("/react/")
							) {
								return "vendor-react";
							}
							if (id.includes("/motion/") || id.includes("framer-motion")) {
								return "vendor-motion";
							}
							if (id.includes("@hugeicons/")) {
								return "vendor-hugeicons";
							}
							if (id.includes("use-intl") || id.includes("@formatjs/")) {
								return "vendor-intl";
							}
							if (id.includes("zustand")) {
								return "vendor-zustand";
							}
						}
					},
				},
			},
		},
		server: {
			// Tauri expects a fixed port and fails if it's not available.
			port: 1420,
			strictPort: true,
			host: host || false,
			hmr: host
				? {
						protocol: "ws",
						host,
						port: 1421,
					}
				: undefined,
			watch: {
				// Tell Vite to ignore watching `src-tauri`.
				ignored: ["**/src-tauri/**"],
			},
			// Warm only the main entry so its module graph is transformed in the
			// background; warming all 9 entries regresses first-paint.
			warmup: { clientFiles: ["./src/entries/main.tsx"] },
		},
	};
});
