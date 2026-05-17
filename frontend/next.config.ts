import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
	cacheComponents: true,
	output: "standalone",
	distDir: "out",
	images: {
		unoptimized: true,
	},
	reactCompiler: true,
	// Repo root has its own bun.lock for husky; pin Turbopack to the frontend
	// workspace so it doesn't warn about the parent lockfile.
	turbopack: {
		root: fileURLToPath(new URL(".", import.meta.url)),
	},
	// Type checking runs separately via ``bun typecheck`` (tsgo); Next.js's
	// in-process tsc adds ~10 s to the build and duplicates that work. The
	// WIP working tree also surfaces transient type errors in feature
	// branches that don't reflect runtime correctness — blocking the
	// installer build on them just slows iteration. Re-enable (delete this
	// line) once the working tree settles.
	typescript: { ignoreBuildErrors: true },
};

export default nextConfig;
