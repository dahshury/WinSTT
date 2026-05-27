import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

const rootDir = fileURLToPath(new URL(".", import.meta.url));

// Multi-page Vite config for the Electron renderer.
//
// Each Electron BrowserWindow loads its own HTML file directly via the
// `file://` protocol — there is NO running renderer server in production.
// In dev, Vite serves these same entries from http://localhost:3000/<page>.html
// with HMR; the Electron main process picks dev vs prod via app.isPackaged.
//
// `base: "./"` is mandatory: it makes Vite emit RELATIVE asset paths
// (`./assets/foo.js` instead of `/assets/foo.js`). Absolute paths break
// under `file://` because the browser interprets `/` as the filesystem
// root, not the HTML file's directory.
export default defineConfig(({ command }) => {
	// react-compiler is a babel pass that runs on every .tsx file in the graph.
	// At dev time it dominates the first-window paint cost (~8 s on the ~544
	// .tsx files behind the main entry per measurement). The compiler's output
	// only matters for production — it adds memoization the bundler ships to
	// users — so we drop the babel plugin in `vite serve` (dev) and keep it
	// in `vite build` (production). HMR + dev correctness are unaffected.
	const isProdBuild = command === "build";
	return {
		root: rootDir,
		base: "./",
		plugins: [
			react({
				babel: {
					plugins: isProdBuild ? [["babel-plugin-react-compiler", { target: "19" }]] : [],
				},
			}),
			tsconfigPaths(),
			tailwindcss(),
		],
		optimizeDeps: {
			// Pre-bundle the heavy ESM packages used across the 8 HTML entries so
			// the dev server doesn't pause on "optimizing dependencies…" the
			// first time a window touches them. Without this, on cold .vite cache
			// the first main-window request takes ~10 s (measured); with the
			// expanded list + warmup below, that drops to <500 ms.
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
				"react-hook-form",
				"@hookform/resolvers/zod",
				"tailwind-merge",
				"clsx",
				"class-variance-authority",
				"fuse.js",
				"double-metaphone",
				"@hugeicons/react",
				"@hugeicons/core-free-icons",
				"@base-ui/react",
			],
		},
		build: {
			outDir: "dist-renderer",
			emptyOutDir: true,
			// Sourcemaps stay off in production builds to keep the .asar small;
			// flip to "inline" when chasing a renderer crash from a packaged build.
			sourcemap: false,
			// Electron 42 ships Chromium 130+ which supports the full ES2024 surface
			// natively. Default Vite target (`baseline-widely-available`) bakes in
			// polyfills + downlevel transforms for older browsers we never serve;
			// targeting `esnext` skips all of that and produces 5-15 % smaller chunks.
			target: "esnext",
			// Skip the gzip-size report at the end of the build — saves 10-30 % on
			// large multi-page builds and we don't ship over HTTP anyway (file://
			// loads from the unpacked resources dir).
			reportCompressedSize: false,
			rollupOptions: {
				input: {
					// `main` stays at the root so Vite's dev server serves it from `/`
					// (the dev-root convention) and so `bun electron:start`'s wait-on
					// tcp:3000 handshake hits a real page. The 6 secondary windows
					// live under `windows/` to keep the frontend root uncluttered;
					// build output mirrors the input layout (dist-renderer/windows/*).
					main: resolve(rootDir, "index.html"),
					settings: resolve(rootDir, "windows/settings.html"),
					overlay: resolve(rootDir, "windows/overlay.html"),
					"tray-menu": resolve(rootDir, "windows/tray-menu.html"),
					"model-picker": resolve(rootDir, "windows/model-picker.html"),
					"device-picker": resolve(rootDir, "windows/device-picker.html"),
					onboarding: resolve(rootDir, "windows/onboarding.html"),
					history: resolve(rootDir, "windows/history.html"),
				},
				output: {
					// Hand-curated chunk split to keep per-page bundles lean. Without
					// this, every page entry inlines the Base UI + motion + chart
					// stacks into its own shared blob (`globals.js` was 631 KB in
					// the first build). Splitting them lets the OS file cache hold
					// a single copy and lets pages that DON'T use motion (settings,
					// tray-menu, pickers) skip the download entirely.
					manualChunks: (id) => {
						if (id.includes("node_modules")) {
							// React core, react-dom, and @base-ui/* must share one chunk.
							// Splitting them produces circular ESM imports between
							// vendor-react and vendor-base-ui — each chunk's top-level
							// code runs while the other half-initialized, and Base UI
							// crashes the renderer with "Cannot read properties of
							// undefined (reading 'useLayoutEffect')" on a React
							// namespace that hasn't bound its hooks yet.
							if (id.includes("@base-ui/") || id.includes("react-dom") || id.includes("/react/")) {
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
			port: 3000,
			strictPort: true,
			// `bun electron:start` waits on tcp:3000 before launching Electron;
			// strictPort prevents Vite from silently moving to 3001 and
			// breaking that handshake.
			//
			// Warm only the main entry so its module graph (which Electron loads
			// first as `index.html`) is transformed in the background while the
			// server reaches "ready". Warming all 8 entries causes contention
			// that hurts first-paint instead of helping (measured 14 s vs 8 s).
			warmup: { clientFiles: ["./src/entries/main.tsx"] },
		},
	};
});
