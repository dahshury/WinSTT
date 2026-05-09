#!/usr/bin/env bun

/**
 * FSD Violation Detection Script
 *
 * Detects all Feature-Sliced Design architecture violations according to
 * the rules defined in .cursor/rules/frontend_structure.mdc
 */

import { execSync } from "node:child_process";
import { type Dirent, existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";

/**
 * Get files changed relative to a git ref.
 * Returns absolute paths filtered to src/ TypeScript files.
 */
function getChangedFiles(diffBase: string, srcDir: string): string[] | null {
	try {
		const rootDir = join(srcDir, "..");
		const output = execSync(`git diff --name-only --diff-filter=ACMR ${diffBase} -- src/`, {
			cwd: rootDir,
			encoding: "utf-8",
		});
		return output
			.trim()
			.split("\n")
			.filter((f) => f && TS_FILE_REGEX.test(f))
			.map((f) => join(rootDir, f));
	} catch {
		console.warn(`Warning: git diff failed for base "${diffBase}", falling back to full scan`);
		return null;
	}
}

interface Violation {
	file: string;
	importPath?: string;
	line?: number;
	message: string;
	severity: "critical" | "high" | "medium" | "low";
	suggestion?: string;
	// Additional context for more specific information
	targetLayer?: string | null;
	targetSlice?: string | null;
}

interface ViolationReport {
	appLayerSlices: Violation[];
	artifactFiles: Violation[];
	businessLogicInShared: Violation[];
	circularImports: Violation[];
	crossLayerImports: Violation[];
	deepAliasImports: Violation[];
	deepRelativeImports: Violation[];
	domainBasedFileNaming: Violation[];
	excessiveSlicing: Violation[];
	forbiddenSegments: Violation[];
	godSlices: Violation[];
	hardcodedUrls: Violation[];
	insignificantSlices: Violation[];
	missingPublicApi: Violation[];
	nestedSegments: Violation[];
	processesLayer: Violation[];
	selfImports: Violation[];
	sharedLayerSlices: Violation[];
	summary: {
		total: number;
		bySeverity: Record<string, number>;
		byCategory: Record<string, number>;
	};
	wildcardExports: Violation[];
}

// FSD Layer hierarchy (top to bottom)
// NOTE: WinSTT uses `views/` instead of `pages/` to avoid conflict with Next.js Pages Router.
// The FSD semantic role is identical — views is the route-level composition layer.
const LAYERS = ["app", "views", "widgets", "features", "entities", "shared"] as const;
type Layer = (typeof LAYERS)[number];
const LAYERS_SET = new Set<string>(LAYERS);
const APP_OR_SHARED_SET = new Set<string>(["app", "shared"]);
const COMPOSITION_LAYERS_SET = new Set<string>(["features", "widgets", "views"]);
const ENTITY_TIER_SET = new Set<string>(["entities", "features", "widgets"]);
const ENTITY_TIER_WITH_VIEWS_SET = new Set<string>(["entities", "features", "widgets", "views"]);
const NON_SHARED_COMPOSITION_SET = new Set<string>(["features", "widgets", "views", "app"]);

// Allowed segments (per FSD rules section 3 and section 5)
const ALLOWED_SEGMENTS = ["ui", "api", "model", "lib", "config", "@x", "routes", "i18n"] as const;
const ALLOWED_SEGMENTS_SET = new Set<string>(ALLOWED_SEGMENTS);

// Allowed organizational directories for app layer (per FSD rules section 12)
const APP_LAYER_ALLOWED_DIRS = ["providers", "layouts", "styles", "assets", "api-routes"] as const;
const APP_LAYER_ALLOWED_DIRS_SET = new Set<string>(APP_LAYER_ALLOWED_DIRS);

// Allowed organizational directories for shared layer beyond segments
// These are common patterns that extend FSD for real-world projects
const SHARED_LAYER_ALLOWED_DIRS = ["infrastructure", "ports", "styles"] as const;
const SHARED_LAYER_ALLOWED_DIRS_SET = new Set<string>(SHARED_LAYER_ALLOWED_DIRS);

// Forbidden segment names
const FORBIDDEN_SEGMENTS = [
	"components",
	"hooks",
	"types",
	"utils",
	"helpers",
	"constants",
] as const;
const FORBIDDEN_SEGMENTS_SET = new Set<string>(FORBIDDEN_SEGMENTS);

// Regex patterns (defined at top level for performance)
const PATH_SEPARATOR_REGEX = /[/\\]/;
const TS_FILE_REGEX = /\.(ts|tsx|js|jsx)$/;
const ALIAS_IMPORT_REGEX = /from\s+['"]@\/([^'"]+)['"]/;
const RELATIVE_IMPORT_REGEX = /from\s+['"](\.\.?\/[^'"]+)['"]/;
const WILDCARD_EXPORT_REGEX = /export\s+\*\s+from\s+['"]/;
const IMPORT_STATEMENT_REGEX = /^import\s+.*from\s+['"]/;
const EXPORT_FROM_STATEMENT_REGEX = /^export\s+.*from\s+['"]/;
const TYPE_ONLY_IMPORT_REGEX = /^import\s+type\s+.*from\s+['"]/;
const REQUIRE_ALIAS_REGEX = /require\(\s*['"]@\/([^'"]+)['"]\s*\)/;
const DYNAMIC_IMPORT_ALIAS_REGEX = /import\(\s*['"]@\/([^'"]+)['"]\s*\)/;
const QUOTE_MATCH_REGEX = /"([^"]+)"/;
const DEEP_RELATIVE_IMPORT_REGEX = /from\s+['"](\.\.\/){3,}[^'"]+['"]/;
const ROUTE_HREF_REGEX = /href\s*=\s*['"`]\/[^'"`]+['"`]/;
const ROUTE_HREF_JSX_REGEX = /href=\{\s*['"`]\/[^'"`]+['"`]\s*\}/;
const ROUTE_HREF_TEMPLATE_REGEX = /href=\{`\/[^`]*`\}/;
const ROUTE_TO_REGEX = /to\s*=\s*['"`]\/[^'"`]+['"`]/;
const ROUTE_TO_JSX_REGEX = /to=\{\s*['"`]\/[^'"`]+['"`]\s*\}/;
const ROUTE_TO_TEMPLATE_REGEX = /to=\{`\/[^`]*`\}/;
const ROUTE_PATH_REGEX = /path\s*=\s*['"`]\/[^'"`]+['"`]/;
const ROUTE_ROUTE_REGEX = /route\s*=\s*['"`]\/[^'"`]+['"`]/;
const ROUTE_URL_REGEX = /url\s*=\s*['"`]\/[^'"`]+['"`]/;
const ROUTE_LINK_REGEX = /link\s*=\s*['"`]\/[^'"`]+['"`]/;
// Programmatic navigation patterns: router.push("/path"), navigate("/path")
const ROUTE_ROUTER_PUSH_REGEX = /router\.(push|replace)\(\s*['"`]\/[^'"`]+['"`]/;
const ROUTE_NAVIGATE_REGEX = /navigate\(\s*['"`]\/[^'"`]+['"`]/;
// Template literal programmatic navigation: router.push(`/path/${id}`)
const ROUTE_ROUTER_PUSH_TEMPLATE_REGEX = /router\.(push|replace)\(\s*`\/[^`]*`/;
const ROUTE_NAVIGATE_TEMPLATE_REGEX = /navigate\(\s*`\/[^`]*`/;
const URL_MATCH_REGEX = /['"`](\/[^'"`]+)['"`]/;
const RELATIVE_IMPORT_PATH_REGEX = /from\s+['"](\.\.\/)+([^'"]+)['"]/;

// Artifact file extensions that should not exist in the codebase
const ARTIFACT_EXTENSIONS = [".bak", ".orig", ".backup", ".old", ".tmp"] as const;

// Generic technical-role file names forbidden inside slice segments (Rule 4-4).
// Files should be named after the business domain they represent, not their technical role.
// e.g., model/types.ts -> model/event.ts, lib/utils.ts -> lib/date-formatting.ts
// Exceptions: dto.ts, mapper.ts (acceptable per FSD practical examples), index.ts (re-exports)
const FORBIDDEN_FILE_BASENAMES = [
	"types",
	"utils",
	"helpers",
	"constants",
	"selectors",
	"reducers",
	"actions",
	"thunks",
] as const;
const FORBIDDEN_FILE_BASENAMES_SET = new Set<string>(FORBIDDEN_FILE_BASENAMES);

// Layers that contain slices (domain-based file naming applies only here)
const SLICED_LAYERS: readonly Layer[] = ["views", "widgets", "features", "entities"] as const;
const SLICED_LAYERS_SET = new Set<string>(SLICED_LAYERS);

// Segments where domain-based file naming is enforced
const ENFORCED_SEGMENTS = ["model", "ui", "api", "lib", "config"] as const;
const ENFORCED_SEGMENTS_SET = new Set<string>(ENFORCED_SEGMENTS);

// God slice thresholds per layer (source files only, tests excluded).
// FSD v2.1: "Pages own substantial logic" and features can be complex.
// Steiger (official FSD linter) has no file-count threshold -- this is a
// heuristic for mixed-responsibility detection, not a strict rule.
// Entities/widgets should be more focused; features/views can be larger.
const GOD_SLICE_THRESHOLDS: Record<string, number> = {
	entities: 100,
	features: 250,
	widgets: 100,
	views: 250,
};

// Excessive slicing thresholds per layer (Steiger rule 5-4).
// When a layer has more slices than the threshold, it signals poor abstraction --
// many slices likely share concerns that should be merged or reorganized.
const EXCESSIVE_SLICING_THRESHOLDS: Record<string, number> = {
	entities: 30,
	features: 40,
	widgets: 25,
	views: 50,
};

// Source directory (CWD-independent -- resolved relative to this script file)
// The script lives at frontend/scripts/check-fsd-violations.ts, so
// import.meta.dir points to frontend/scripts/ regardless of where `bun run` is invoked.
const SCRIPT_DIR = import.meta.dir;
const FRONTEND_DIR = join(SCRIPT_DIR, "..");
const srcPath = join(FRONTEND_DIR, "src");

// Test file patterns
const TEST_FILE_PATTERNS = ["__tests__", ".test.", ".spec.", "test/", "tests/"] as const;

const violations: ViolationReport = {
	forbiddenSegments: [],
	crossLayerImports: [],
	nestedSegments: [],
	wildcardExports: [],
	circularImports: [],
	deepRelativeImports: [],
	deepAliasImports: [],
	selfImports: [],
	missingPublicApi: [],
	artifactFiles: [],
	hardcodedUrls: [],
	appLayerSlices: [],
	sharedLayerSlices: [],
	domainBasedFileNaming: [],
	businessLogicInShared: [],
	processesLayer: [],
	godSlices: [],
	insignificantSlices: [],
	excessiveSlicing: [],
	summary: {
		total: 0,
		bySeverity: {},
		byCategory: {},
	},
};

/**
 * Check if a file is a test file (test files have relaxed import rules)
 */
function isTestFile(filePath: string): boolean {
	const normalizedPath = filePath.replace(/\\/g, "/");
	return TEST_FILE_PATTERNS.some((pattern) => normalizedPath.includes(pattern));
}

/**
 * Check if a file is inside an @x directory (cross-reference files)
 * Files in @x directories are meant to expose types/functions for cross-layer use
 */
function isInAtXDirectory(filePath: string): boolean {
	const normalizedPath = filePath.replace(/\\/g, "/");
	return normalizedPath.includes("/@x/") || normalizedPath.includes("\\@x\\");
}

/**
 * Get the layer of a file path
 */
function getLayerFromPath(filePath: string): Layer | null {
	const relativePath = relative(srcPath, filePath);
	const parts = relativePath.split(PATH_SEPARATOR_REGEX);
	const layer = parts[0] as Layer;
	return LAYERS_SET.has(layer) ? layer : null;
}

/**
 * Get the slice name from a file path
 */
function getSliceFromPath(filePath: string, layer?: Layer | null): string | null {
	const relativePath = relative(srcPath, filePath);
	const parts = relativePath.split(PATH_SEPARATOR_REGEX);
	if (parts.length < 2) {
		return null;
	}
	// For app and shared layers, there are no slices
	if (layer === "app" || layer === "shared") {
		return null;
	}
	return parts[1] ?? null;
}

/**
 * Check if a path contains a forbidden segment name
 */
function hasForbiddenSegment(filePath: string): boolean {
	const parts = filePath.split(PATH_SEPARATOR_REGEX);
	for (const part of parts) {
		if (FORBIDDEN_SEGMENTS_SET.has(part)) {
			return true;
		}
	}
	return false;
}

/**
 * Get the segment name from a path
 */
function getSegmentFromPath(filePath: string): string | null {
	const relativePath = relative(srcPath, filePath);
	const parts = relativePath.split(PATH_SEPARATOR_REGEX);

	// Find the first segment in the path
	for (const part of parts) {
		if (ALLOWED_SEGMENTS_SET.has(part)) {
			return part;
		}
		if (FORBIDDEN_SEGMENTS_SET.has(part)) {
			return part;
		}
	}
	return null;
}

/**
 * Check if FORBIDDEN segment names are nested within allowed segments.
 *
 * This specifically checks for the anti-pattern of using forbidden directory names
 * (components, hooks, types, utils, helpers, constants) as organizational folders
 * within slice segments -- EXCEPT where FSD explicitly allows them.
 *
 * FSD-allowed exceptions:
 * - shared/lib/hooks/ -- prescribed location for reusable utility hooks
 *
 * Invalid examples:
 * - entities/user/ui/components/Button.tsx (components is forbidden)
 * - features/auth/model/types/user.ts (types is forbidden at segment level)
 * - features/auth/ui/hooks/useForm.ts (hooks in non-shared slice)
 *
 * Valid examples:
 * - shared/lib/hooks/use-debounced-value.ts (FSD-prescribed location)
 * - entities/app-config/api/config/constants.ts (config subdirectory is fine)
 * - shared/api/orpc/hooks/use-event-stream.ts (deep internal subdir, not a segment)
 */
function hasNestedSegment(filePath: string): boolean {
	const relativePath = relative(srcPath, filePath);
	const parts = relativePath.split(PATH_SEPARATOR_REGEX);

	if (parts.length < 3) {
		return false;
	}

	const layer = parts[0];
	if (!(layer && LAYERS_SET.has(layer))) {
		return false;
	}

	// Determine the segment index based on whether the layer has slices
	// Layers WITHOUT slices: app, shared -> segment at index 1
	// Layers WITH slices: pages, widgets, features, entities -> segment at index 2
	const hasSlices = layer !== undefined && !APP_OR_SHARED_SET.has(layer);
	const segmentIndex = hasSlices ? 2 : 1;

	// Get the segment at the expected position
	const segmentName = parts[segmentIndex];
	if (!segmentName) {
		return false;
	}

	// Only check if the first part is actually a segment
	const isFirstPartSegment = ALLOWED_SEGMENTS_SET.has(segmentName);
	if (!isFirstPartSegment) {
		return false;
	}

	// Look for FORBIDDEN segment names nested within the segment
	for (let i = segmentIndex + 1; i < parts.length - 1; i++) {
		// -1 to exclude filename
		const part = parts[i];
		if (!part) {
			continue;
		}
		// Skip @x as it's a special notation
		if (part === "@x") {
			continue;
		}
		// Skip __tests__ directories
		if (part === "__tests__") {
			continue;
		}
		// Check if this subdirectory uses a forbidden segment name
		if (FORBIDDEN_SEGMENTS_SET.has(part)) {
			// EXCEPTION: shared/lib/hooks/ is FSD-prescribed for reusable utility hooks
			if (
				layer === "shared" &&
				segmentName === "lib" &&
				part === "hooks" &&
				i === segmentIndex + 1
			) {
				continue;
			}
			// EXCEPTION: forbidden names deeply nested (3+ levels below segment) are
			// internal organizational subdirs, not top-level segments -- only flag if
			// the forbidden name is the FIRST directory inside the segment
			if (i > segmentIndex + 1) {
				continue;
			}
			return true;
		}
	}

	return false;
}

/**
 * Parse import statement to extract layer and slice
 */
function parseImport(
	importStatement: string,
	currentFile: string
): {
	layer: Layer | null;
	slice: string | null;
	isCrossLayer: boolean;
	isCrossSlice: boolean;
	isMissingAtX: boolean;
	isTypeOnly: boolean;
	isTestFile: boolean;
	isAtXFile: boolean;
} | null {
	// Match import patterns like '@/features/...', '@/entities/...', etc.
	const aliasMatch = importStatement.match(ALIAS_IMPORT_REGEX);
	const relativeMatch = importStatement.match(RELATIVE_IMPORT_REGEX);

	if (!(aliasMatch || relativeMatch)) {
		return null;
	}

	// Check if this is a type-only import (allowed in some cases)
	const isTypeOnly = TYPE_ONLY_IMPORT_REGEX.test(importStatement);

	// Check if current file is a test file (relaxed import rules)
	const isTest = isTestFile(currentFile);

	// Check if current file is inside an @x directory (cross-reference files)
	const isAtX = isInAtXDirectory(currentFile);

	const currentLayer = getLayerFromPath(currentFile);
	const currentSlice = currentLayer ? getSliceFromPath(currentFile) : null;

	let layer: Layer | null = null;
	let slice: string | null = null;
	let importPath: string | null = null;

	if (aliasMatch) {
		importPath = aliasMatch[1] ?? null;
		if (!importPath) {
			return null;
		}
		const parts = importPath.split("/");
		layer = parts[0] as Layer;

		if (!LAYERS_SET.has(layer)) {
			return null;
		}

		slice = parts.length > 1 ? (parts[1] ?? null) : null;
	} else if (relativeMatch) {
		// Handle relative imports that might cross layer boundaries
		// Check if relative import path contains layer names (e.g., ../../../features/)
		const relativePath = relativeMatch[1];
		if (!relativePath) {
			return null;
		}

		// Check if the relative path mentions a layer name
		for (const layerName of LAYERS) {
			if (relativePath.includes(`/${layerName}/`) || relativePath.endsWith(`/${layerName}`)) {
				// Extract layer from relative path
				const parts = relativePath.split("/");
				const layerIndex = parts.indexOf(layerName);
				if (layerIndex >= 0) {
					layer = layerName as Layer;
					slice = parts.length > layerIndex + 1 ? (parts[layerIndex + 1] ?? null) : null;
					importPath = relativePath;
					break;
				}
			}
		}

		// If no layer found in relative path, it's likely within same slice - return null
		if (!layer) {
			return null;
		}
	} else {
		return null;
	}

	if (!layer) {
		return null;
	}

	// Check for cross-layer violations
	// FSD Rule: Can only import from layers below (higher index = lower layer)
	// app(0) -> pages(1) -> widgets(2) -> features(3) -> entities(4) -> shared(5)
	// Allowed: pages can import from widgets/features/entities/shared (index > 1)
	// Allowed: widgets can import from features/entities/shared (index > 2)
	// Allowed: features can import from entities/shared (index > 3)
	// Allowed: entities can import from shared (index > 4)
	// Allowed: shared can import from nothing (it's the foundation)
	// Special: shared can import TYPE-ONLY from entities (for type definitions)
	// Special: Files in @x directories can import from upper layers (they expose cross-references)
	// Violation: importing from same or higher layer (index < currentIndex)
	// Violation: features/widgets/pages importing from same layer (cross-slice)
	if (currentLayer) {
		const currentIndex = LAYERS.indexOf(currentLayer);
		const importIndex = LAYERS.indexOf(layer);

		// Special case: shared layer cannot import from any other layer
		// EXCEPT: type-only imports from entities are allowed in FSD
		// EXCEPT: files in @x directories are meant to expose cross-references
		if (currentLayer === "shared" && layer !== "shared") {
			// Allow type-only imports from entities (FSD rule)
			if (isTypeOnly && layer === "entities") {
				return {
					layer,
					slice,
					isCrossLayer: false,
					isCrossSlice: false,
					isMissingAtX: false,
					isTypeOnly: true,
					isTestFile: isTest,
					isAtXFile: isAtX,
				};
			}
			// Files in @x directories are meant to re-export from other layers
			// This is a valid pattern for creating cross-layer type bridges
			if (isAtX) {
				return {
					layer,
					slice,
					isCrossLayer: false,
					isCrossSlice: false,
					isMissingAtX: false,
					isTypeOnly,
					isTestFile: isTest,
					isAtXFile: true,
				};
			}
			return {
				layer,
				slice,
				isCrossLayer: true,
				isCrossSlice: slice !== null && slice !== currentSlice,
				isMissingAtX: false,
				isTypeOnly: false,
				isTestFile: isTest,
				isAtXFile: isAtX,
			};
		}

		// For other layers: violation if importing from same layer or higher (upward import)
		// Note: Same-layer cross-slice imports are handled separately below
		// We check importIndex < currentIndex (strictly less) because:
		// - importIndex === currentIndex means same layer (handled separately)
		// - importIndex < currentIndex means upward import (violation)
		if (layer !== "shared" && importIndex < currentIndex && layer !== currentLayer) {
			return {
				layer,
				slice,
				isCrossLayer: true,
				isCrossSlice: slice !== null && slice !== currentSlice,
				isMissingAtX: false,
				isTypeOnly: false,
				isTestFile: isTest,
				isAtXFile: isAtX,
			};
		}
	}

	// Check for cross-slice imports within same layer
	if (currentLayer && layer === currentLayer && slice && slice !== currentSlice) {
		// Entities need @x notation for cross-entity imports
		if (layer === "entities") {
			const hasAtX = importPath?.includes("/@x/") ?? false;
			return {
				layer,
				slice,
				isCrossLayer: false,
				isCrossSlice: true,
				isMissingAtX: !hasAtX,
				isTypeOnly: false,
				isTestFile: isTest,
				isAtXFile: isAtX,
			};
		}

		// Features, widgets, pages should not import from each other
		if (COMPOSITION_LAYERS_SET.has(layer)) {
			return {
				layer,
				slice,
				isCrossLayer: false,
				isCrossSlice: true,
				isMissingAtX: false,
				isTypeOnly: false,
				isTestFile: isTest,
				isAtXFile: isAtX,
			};
		}
	}

	return {
		layer,
		slice,
		isCrossLayer: false,
		isCrossSlice: false,
		isMissingAtX: false,
		isTypeOnly: false,
		isTestFile: isTest,
		isAtXFile: isAtX,
	};
}

/**
 * Check for wildcard exports in index.ts files
 */
function hasWildcardExport(content: string): boolean {
	// Match export * from patterns
	return WILDCARD_EXPORT_REGEX.test(content);
}

/**
 * Check if app layer has slices (should not have slices)
 * App layer can have: segments + organizational dirs (providers, layouts, styles, assets, api-routes)
 */
async function checkAppLayerSlices(): Promise<void> {
	const appDir = join(srcPath, "app");
	if (!existsSync(appDir)) {
		return;
	}

	try {
		const entries = await readdir(appDir, { withFileTypes: true, encoding: "utf8" });
		for (const entry of entries) {
			if (!entry.isDirectory()) {
				continue;
			}
			// Check if it's a segment (allowed)
			const isSegment = ALLOWED_SEGMENTS_SET.has(entry.name);
			if (isSegment) {
				continue;
			}
			// Check if it's an allowed organizational directory for app layer
			const isAllowedAppDir = APP_LAYER_ALLOWED_DIRS_SET.has(entry.name);
			if (isAllowedAppDir) {
				continue;
			}
			const isHidden = entry.name.startsWith(".");
			if (isHidden) {
				continue;
			}
			// Allow underscore-prefixed directories (internal/private)
			const isInternal = entry.name.startsWith("_");
			if (isInternal) {
				continue;
			}
			violations.appLayerSlices.push({
				file: `app/${entry.name}`,
				message: `App layer contains slice-like directory: ${entry.name} (app layer should not have slices)`,
				severity: "high",
				suggestion:
					"Organize by technical intent (providers/, layouts/, styles/, assets/, api-routes/) not by domain slices",
			});
		}
	} catch {
		// Ignore if app directory doesn't exist
	}
}

/**
 * Check if shared layer has slices (should not have slices)
 * Shared layer can have: segments only (ui, api, config, lib, routes, i18n, @x)
 * Plus some extended patterns commonly used: infrastructure, ports
 */
async function checkSharedLayerSlices(): Promise<void> {
	const sharedDir = join(srcPath, "shared");
	if (!existsSync(sharedDir)) {
		return;
	}

	try {
		const entries = await readdir(sharedDir, { withFileTypes: true, encoding: "utf8" });
		for (const entry of entries) {
			if (!entry.isDirectory()) {
				continue;
			}
			// Check if it's a segment (allowed)
			const isSegment = ALLOWED_SEGMENTS_SET.has(entry.name);
			if (isSegment) {
				continue;
			}
			// Check if it's an allowed extended directory for shared layer
			const isAllowedSharedDir = SHARED_LAYER_ALLOWED_DIRS_SET.has(entry.name);
			if (isAllowedSharedDir) {
				continue;
			}
			const isHidden = entry.name.startsWith(".");
			if (isHidden) {
				continue;
			}
			// Exclude test directories
			const isTestDir = entry.name === "__tests__" || entry.name.includes("test");
			if (isTestDir) {
				continue;
			}
			violations.sharedLayerSlices.push({
				file: `shared/${entry.name}`,
				message: `Shared layer contains slice-like directory: ${entry.name} (shared layer should only have segments)`,
				severity: "high",
				suggestion:
					"Shared layer should only contain segments: ui/, api/, config/, lib/, routes/, i18n/",
			});
		}
	} catch {
		// Ignore if shared directory doesn't exist
	}
}

/**
 * Check that every slice in layers with slices has an index.ts public API
 * Layers with slices: pages, widgets, features, entities
 */
async function checkMissingPublicApis(): Promise<void> {
	const layersWithSlices: Layer[] = ["views", "widgets", "features", "entities"];

	for (const layer of layersWithSlices) {
		const layerDir = join(srcPath, layer);
		if (!existsSync(layerDir)) {
			continue;
		}

		try {
			const entries = await readdir(layerDir, { withFileTypes: true, encoding: "utf8" });
			for (const entry of entries) {
				if (!entry.isDirectory()) {
					continue;
				}
				// Skip hidden/internal directories
				if (entry.name.startsWith(".") || entry.name.startsWith("_")) {
					continue;
				}
				// Skip __tests__ directories
				if (entry.name === "__tests__") {
					continue;
				}

				const sliceDir = join(layerDir, entry.name);
				const hasIndexTs = existsSync(join(sliceDir, "index.ts"));
				const hasIndexTsx = existsSync(join(sliceDir, "index.tsx"));

				if (!hasIndexTs && !hasIndexTsx) {
					violations.missingPublicApi.push({
						file: `${layer}/${entry.name}`,
						message: `Slice "${layer}/${entry.name}" is missing index.ts public API`,
						severity: "high",
						suggestion: `Create ${layer}/${entry.name}/index.ts with named exports for the slice's public surface`,
					});
				}
			}
		} catch {
			// Ignore if directory doesn't exist
		}
	}
}

/**
 * Check for artifact files (.bak, .orig, .backup, .old, .tmp)
 */
async function checkArtifactFiles(dir: string): Promise<void> {
	try {
		const entries = await readdir(dir, { withFileTypes: true, encoding: "utf8" });
		for (const entry of entries) {
			const fullPath = join(dir, entry.name);

			if (entry.name.startsWith(".") || entry.name === "node_modules") {
				continue;
			}

			if (entry.isDirectory()) {
				await checkArtifactFiles(fullPath);
			} else if (entry.isFile()) {
				for (const ext of ARTIFACT_EXTENSIONS) {
					if (entry.name.endsWith(ext)) {
						violations.artifactFiles.push({
							file: relative(srcPath, fullPath),
							message: `Artifact file found: ${entry.name} (${ext} files should not be committed)`,
							severity: "high",
							suggestion: `Delete ${entry.name} - artifact/backup files should not be in the codebase`,
						});
						break;
					}
				}
			}
		}
	} catch {
		// Ignore permission errors
	}
}

/**
 * Check if the deprecated processes/ layer exists (FSD v2.1 deprecated it)
 */
function checkProcessesLayer(): void {
	const processesDir = join(srcPath, "processes");
	if (existsSync(processesDir)) {
		violations.processesLayer.push({
			file: "processes/",
			message:
				'Deprecated FSD layer "processes/" exists. The processes layer was removed in FSD v2.1.',
			severity: "high",
			suggestion:
				"Migrate processes/ contents to features/ (for user interactions) or app/ (for global orchestration), then delete the directory.",
		});
	}
}

/**
 * Detect god slices -- slices whose source-file count exceeds the per-layer threshold.
 * Test files are excluded because comprehensive testing should not penalize a slice.
 * Thresholds vary by layer: entities/widgets are expected to be focused (100),
 * while features/pages can own substantial logic per FSD v2.1 (250).
 */
async function checkGodSlices(): Promise<void> {
	for (const layer of SLICED_LAYERS) {
		const layerDir = join(srcPath, layer);
		if (!existsSync(layerDir)) {
			continue;
		}

		const threshold = GOD_SLICE_THRESHOLDS[layer] ?? 100;

		let entries: Dirent[];
		try {
			entries = await readdir(layerDir, { withFileTypes: true, encoding: "utf8" });
		} catch {
			continue;
		}

		for (const entry of entries) {
			if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name.startsWith("_")) {
				continue;
			}

			const sliceDir = join(layerDir, entry.name);
			const allFiles = await scanDirectory(sliceDir);
			// Exclude test files -- comprehensive tests should not penalize a slice
			const sourceFiles = allFiles.filter((f) => !isTestFile(f));
			const fileCount = sourceFiles.length;

			if (fileCount >= threshold) {
				violations.godSlices.push({
					file: `${layer}/${entry.name}`,
					message: `God slice detected: "${layer}/${entry.name}" contains ${fileCount} source files (threshold: ${threshold}). Slices this large indicate overly broad responsibilities.`,
					severity: "medium",
					suggestion: `Split "${layer}/${entry.name}" into smaller, more focused slices with single responsibilities.`,
				});
			}
		}
	}
}

/**
 * Check for business logic in shared/ layer (Rule 4-5).
 *
 * Shared should contain only infrastructure: UI kit, utilities, API client setup,
 * route constants, assets. Business calculations, domain rules, and workflows
 * belong in entities/ or higher layers.
 *
 * Detection heuristics (conservative -- only flags clear violations):
 * 1. Domain-specific subdirectories in shared/lib/ that contain business logic
 *    (e.g., shared/lib/calendar/ with slot reflow algorithms, shared/lib/chat/ with
 *    message preview stores, shared/lib/realtime-projections/ with entity-specific
 *    cache projection logic)
 * 2. Zustand/Redux stores in shared/ that manage domain-specific state
 *    (as opposed to generic UI state like theme, sidebar open/closed)
 */
async function checkBusinessLogicInShared(): Promise<void> {
	const sharedLibDir = join(srcPath, "shared", "lib");
	if (!existsSync(sharedLibDir)) {
		return;
	}

	// ─── Heuristic 1: Domain-specific directories in shared/lib/ ───
	// These directories contain business logic that belongs in entities/ or features/.
	// Add WinSTT-specific entries here when violations are discovered.
	// Format: "<directory-name>": { target: "<where to move>", reason: "<why it's business logic>" }
	const DOMAIN_DIRECTORIES: Record<string, { target: string; reason: string }> = {};

	try {
		const entries = await readdir(sharedLibDir, { withFileTypes: true, encoding: "utf8" });
		for (const entry of entries) {
			if (!entry.isDirectory()) {
				continue;
			}
			const domainInfo = DOMAIN_DIRECTORIES[entry.name];
			if (domainInfo) {
				const dirPath = join(sharedLibDir, entry.name);
				const files = await scanDirectory(dirPath);
				// Only flag if there are actual non-test source files
				const sourceFiles = files.filter((f) => !isTestFile(f));
				if (sourceFiles.length > 0) {
					violations.businessLogicInShared.push({
						file: `shared/lib/${entry.name}/`,
						message: `Business logic in shared/: "shared/lib/${entry.name}/" contains ${sourceFiles.length} source file(s) with domain-specific logic. ${domainInfo.reason}`,
						severity: "medium",
						suggestion: `Move to ${domainInfo.target}. Shared should only contain infrastructure (UI kit, utilities, API client setup).`,
					});
				}
			}
		}
	} catch {
		// Ignore if directory doesn't exist
	}

	// ─── Heuristic 2: Specific files with business logic in shared/lib/ ───
	// Individual files that implement domain-specific business rules rather than
	// infrastructure utilities. Add WinSTT-specific entries as they are discovered.
	const BUSINESS_LOGIC_FILES: Record<string, { target: string; reason: string }> = {};

	for (const [filePath, info] of Object.entries(BUSINESS_LOGIC_FILES)) {
		const fullPath = join(sharedLibDir, filePath);
		if (existsSync(fullPath)) {
			violations.businessLogicInShared.push({
				file: `shared/lib/${filePath}`,
				message: `Business logic in shared/: "${filePath}" contains domain-specific logic. ${info.reason}`,
				severity: "medium",
				suggestion: `Move to ${info.target}. Shared should only contain infrastructure (UI kit, utilities, API client setup).`,
			});
		}
	}

	// ─── Heuristic 3: Domain-specific Zustand stores in shared/ ───
	// Stores that manage domain-specific state (not generic UI state) should
	// live in entities/ or features/. Generic UI state stores are OK in shared/.
	const storeDir = join(sharedLibDir, "store");
	if (!existsSync(storeDir)) {
		return;
	}

	// Generic UI state stores that are OK in shared/ (conservative allowlist).
	// Add WinSTT-specific generic UI stores here as needed.
	const ALLOWED_SHARED_STORES = new Set<string>([]);

	try {
		const storeEntries = await readdir(storeDir, { withFileTypes: true, encoding: "utf8" });
		for (const entry of storeEntries) {
			if (!entry.isFile() || !TS_FILE_REGEX.test(entry.name)) {
				continue;
			}
			if (isTestFile(entry.name) || entry.name === "index.ts") {
				continue;
			}
			if (ALLOWED_SHARED_STORES.has(entry.name)) {
				continue;
			}

			// Any store not in the allowlist is a potential domain store
			const storeName = entry.name.replace(/\.(ts|tsx)$/, "");
			violations.businessLogicInShared.push({
				file: `shared/lib/store/${entry.name}`,
				message: `Domain-specific store in shared/: "${entry.name}" manages domain state that likely belongs in a higher layer`,
				severity: "medium",
				suggestion: `Move to the owning entity or feature (e.g., entities/${storeName.replace(/-store$/, "")}/model/ or features/${storeName.replace(/-store$/, "")}/model/). Shared stores should only manage generic UI state (theme, locale, sidebar open/closed).`,
			});
		}
	} catch {
		// Ignore if directory doesn't exist
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Circular Import Detection (between FSD slices)
// ─────────────────────────────────────────────────────────────────────────────

/** Map from normalized file path to set of normalized dependency file paths */
type SliceGraph = Map<string, Set<string>>;

/**
 * Resolve an alias import path (e.g., "entities/event/model/foo") to an
 * absolute file path under srcPath. Tries .ts, .tsx, /index.ts, /index.tsx.
 */
function resolveAliasImport(importPath: string): string | null {
	const base = join(srcPath, importPath);
	const candidates = [
		`${base}.ts`,
		`${base}.tsx`,
		join(base, "index.ts"),
		join(base, "index.tsx"),
		`${base}.js`,
		`${base}.jsx`,
	];
	for (const candidate of candidates) {
		if (existsSync(candidate)) {
			return candidate;
		}
	}
	return null;
}

/**
 * Get the slice identifier for a file: "layer/slice" (e.g., "entities/event").
 * Returns null for app and shared layers (no slices) or files outside FSD.
 */
function getSliceId(filePath: string): string | null {
	const layer = getLayerFromPath(filePath);
	if (!layer || layer === "app" || layer === "shared") {
		return null;
	}
	const slice = getSliceFromPath(filePath, layer);
	if (!slice) {
		return null;
	}
	return `${layer}/${slice}`;
}

/**
 * Build an import graph at the SLICE level (not file level).
 * Each node is a slice identifier ("entities/event"), and edges represent
 * at least one file in slice A importing from a file in slice B.
 * Only tracks cross-slice imports (same-slice imports are ignored).
 */
function buildSliceImportGraph(allFiles: readonly string[]): SliceGraph {
	const graph: SliceGraph = new Map();

	for (const filePath of allFiles) {
		const sourceSliceId = getSliceId(filePath);
		if (!sourceSliceId) {
			continue;
		}
		if (!graph.has(sourceSliceId)) {
			graph.set(sourceSliceId, new Set());
		}

		let content: string;
		try {
			// Use Bun's synchronous file read for performance
			content = require("node:fs").readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const lines = content.split("\n");
		for (const line of lines) {
			if (!line) {
				continue;
			}
			// Only check alias imports (cross-slice imports use @/ alias)
			const aliasMatch = line.match(ALIAS_IMPORT_REGEX);
			if (!aliasMatch?.[1]) {
				continue;
			}
			const importPath = aliasMatch[1];
			const parts = importPath.split("/");
			const importLayer = parts[0] as Layer;
			if (!LAYERS_SET.has(importLayer) || importLayer === "app" || importLayer === "shared") {
				continue;
			}
			const importSlice = parts[1];
			if (!importSlice) {
				continue;
			}
			// Skip @x imports -- the @x notation is the FSD-sanctioned mechanism
			// for cross-entity references. Even bidirectional @x between two entities
			// is an accepted pattern (the @x directory limits the exposed surface).
			// The crossLayerImports check already flags MISSING @x notation.
			if (parts[2] === "@x") {
				continue;
			}
			const targetSliceId = `${importLayer}/${importSlice}`;
			// Only track cross-slice edges
			if (targetSliceId !== sourceSliceId) {
				const deps = graph.get(sourceSliceId);
				if (deps) {
					deps.add(targetSliceId);
				}
			}
		}
	}

	return graph;
}

/**
 * Detect cycles in the slice import graph using iterative DFS.
 * Returns an array of cycles, where each cycle is an array of slice IDs.
 */
function detectSliceCycles(graph: SliceGraph): string[][] {
	const visited = new Set<string>();
	const inStack = new Set<string>();
	const stack: string[] = [];
	const cycles: string[][] = [];
	const cycleKeys = new Set<string>();

	const dfs = (node: string): void => {
		visited.add(node);
		inStack.add(node);
		stack.push(node);

		const deps = graph.get(node);
		if (deps) {
			for (const dep of deps) {
				if (!visited.has(dep)) {
					dfs(dep);
					continue;
				}
				if (inStack.has(dep)) {
					const startIndex = stack.indexOf(dep);
					if (startIndex >= 0) {
						const cycle = stack.slice(startIndex);
						// Normalize cycle key: rotate to start with smallest element
						const sorted = [...cycle];
						const minIdx = sorted.indexOf(sorted.reduce((a, b) => (a < b ? a : b)));
						const normalized = [...sorted.slice(minIdx), ...sorted.slice(0, minIdx)];
						const key = normalized.join(" -> ");
						if (!cycleKeys.has(key)) {
							cycleKeys.add(key);
							cycles.push(cycle);
						}
					}
				}
			}
		}

		stack.pop();
		inStack.delete(node);
	};

	for (const node of graph.keys()) {
		if (!visited.has(node)) {
			dfs(node);
		}
	}

	return cycles;
}

/**
 * Check for circular imports between FSD slices.
 * Builds a slice-level import graph and detects cycles via DFS.
 */
function checkCircularImports(allFiles: readonly string[]): void {
	const graph = buildSliceImportGraph(allFiles);
	const cycles = detectSliceCycles(graph);

	for (const cycle of cycles) {
		const pretty = cycle.map((s) => s).join(" -> ") + ` -> ${cycle[0]}`;
		violations.circularImports.push({
			file: cycle[0] ?? "unknown",
			message: `Circular import detected between slices: ${pretty}`,
			severity: "critical",
			suggestion:
				"Break the cycle by extracting shared logic to a lower layer (entities/ or shared/), using @x notation for entity cross-references, or composing from a higher layer.",
		});
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Insignificant Slice Detection (Steiger rule: insignificant-slice)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Detect slices in entities/ or features/ that are only imported by a single
 * page. Such slices should be colocated inside that page's slice to reduce
 * unnecessary abstraction.
 *
 * Approach: For each slice in entities/features, scan all files in layers
 * above (pages, widgets, features for entities; pages, widgets for features)
 * and count how many distinct PAGE slices import from it. If exactly 1 page
 * slice uses it and no widgets/features use it, it's insignificant.
 *
 * Conservative heuristic: Only flag slices that are BOTH:
 * 1. Used by exactly 1 page and 0 other higher-layer consumers
 * 2. Small (≤ 5 source files) -- larger slices are intentionally separated
 *    for organizational clarity even with a single consumer
 */
async function checkInsignificantSlices(allFiles: readonly string[]): Promise<void> {
	const layersToCheck: Layer[] = ["entities", "features"];
	// Only flag small single-consumer slices (large ones are kept for clarity)
	const INSIGNIFICANT_MAX_FILES = 5;

	for (const targetLayer of layersToCheck) {
		const layerDir = join(srcPath, targetLayer);
		if (!existsSync(layerDir)) {
			continue;
		}

		let entries: Dirent[];
		try {
			entries = await readdir(layerDir, { withFileTypes: true, encoding: "utf8" });
		} catch {
			continue;
		}

		const sliceNames = entries
			.filter((e) => e.isDirectory() && !e.name.startsWith(".") && !e.name.startsWith("_"))
			.map((e) => e.name);

		for (const sliceName of sliceNames) {
			const sliceImportPrefix = `${targetLayer}/${sliceName}`;

			// Check slice size first (skip large slices -- they're intentionally separated)
			const sliceDir = join(layerDir, sliceName);
			let sliceFiles: string[];
			try {
				sliceFiles = await scanDirectory(sliceDir);
			} catch {
				continue;
			}
			const sourceFiles = sliceFiles.filter((f) => !isTestFile(f));
			if (sourceFiles.length > INSIGNIFICANT_MAX_FILES) {
				continue; // Large slices are intentionally separate
			}

			// Track which page slices import from this slice
			const importingPageSlices = new Set<string>();
			// Track whether any non-page higher-layer slice imports from it
			let usedByNonPageHigherLayer = false;

			for (const filePath of allFiles) {
				const fileLayer = getLayerFromPath(filePath);
				if (!fileLayer) {
					continue;
				}
				// Skip same layer and lower layers
				const fileLayerIndex = LAYERS.indexOf(fileLayer);
				const targetLayerIndex = LAYERS.indexOf(targetLayer);
				if (fileLayerIndex >= targetLayerIndex) {
					continue;
				}
				// Skip test files
				if (isTestFile(filePath)) {
					continue;
				}

				let content: string;
				try {
					content = require("node:fs").readFileSync(filePath, "utf-8");
				} catch {
					continue;
				}

				// Check if this file imports from the target slice
				const importPattern = new RegExp(`from\\s+['"]@/${sliceImportPrefix}(?:[/'"])`);
				if (!importPattern.test(content)) {
					continue;
				}

				// This file imports from the target slice
				if (fileLayer === "views") {
					const pageSlice = getSliceFromPath(filePath, fileLayer);
					if (pageSlice) {
						importingPageSlices.add(pageSlice);
					}
				} else {
					// widgets, features (for entities), or app layer
					usedByNonPageHigherLayer = true;
					break; // No need to check further
				}
			}

			// Flag if exactly 1 page uses this slice and no other higher-layer slices use it
			if (!usedByNonPageHigherLayer && importingPageSlices.size === 1) {
				const onlyPage = Array.from(importingPageSlices)[0];
				violations.insignificantSlices.push({
					file: sliceImportPrefix,
					message: `Insignificant slice: "${sliceImportPrefix}" is only used by views/${onlyPage} and has only ${sourceFiles.length} source file(s). Consider colocating it inside that view.`,
					severity: "low",
					suggestion: `Move ${sliceImportPrefix}/ contents into views/${onlyPage}/ to reduce unnecessary abstraction. Slices should be reusable across multiple consumers.`,
				});
			}
		}
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Excessive Slicing Detection (Steiger rule: excessive-slicing)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Detect layers with too many slices, which indicates poor abstraction --
 * many slices likely share concerns that should be merged or reorganized.
 */
async function checkExcessiveSlicing(): Promise<void> {
	for (const layer of SLICED_LAYERS) {
		const layerDir = join(srcPath, layer);
		if (!existsSync(layerDir)) {
			continue;
		}

		const threshold = EXCESSIVE_SLICING_THRESHOLDS[layer];
		if (!threshold) {
			continue;
		}

		let entries: Dirent[];
		try {
			entries = await readdir(layerDir, { withFileTypes: true, encoding: "utf8" });
		} catch {
			continue;
		}

		const sliceCount = entries.filter(
			(e) => e.isDirectory() && !e.name.startsWith(".") && !e.name.startsWith("_")
		).length;

		if (sliceCount > threshold) {
			violations.excessiveSlicing.push({
				file: `${layer}/`,
				message: `Excessive slicing: "${layer}/" contains ${sliceCount} slices (threshold: ${threshold}). Too many slices indicate poor abstraction.`,
				severity: "medium",
				suggestion: `Merge related slices or reorganize the ${layer}/ layer. Consider grouping related slices or extracting common patterns.`,
			});
		}
	}
}

/**
 * Recursively scan directory for files
 */
async function scanDirectory(dir: string, fileList: string[] = []): Promise<string[]> {
	try {
		const entries = await readdir(dir, { withFileTypes: true, encoding: "utf8" });

		for (const entry of entries) {
			const fullPath = join(dir, entry.name);

			// Skip node_modules, .next, dist, etc.
			if (entry.name.startsWith(".") || entry.name === "node_modules") {
				continue;
			}

			if (entry.isDirectory()) {
				await scanDirectory(fullPath, fileList);
			} else if (entry.isFile() && TS_FILE_REGEX.test(entry.name)) {
				// Only check TypeScript/JavaScript files
				fileList.push(fullPath);
			}
		}
	} catch (error) {
		// Ignore permission errors
		if ((error as NodeJS.ErrnoException).code !== "EACCES") {
			console.error(`Error scanning ${dir}:`, error);
		}
	}

	return fileList;
}

/**
 * Analyze a single file for violations
 */
async function analyzeFile(filePath: string): Promise<void> {
	try {
		const content = await readFile(filePath, "utf-8");
		const relativePath = relative(srcPath, filePath);
		const layer = getLayerFromPath(filePath);

		// Check for forbidden segment names in path
		if (hasForbiddenSegment(filePath)) {
			const segment = getSegmentFromPath(filePath);
			if (segment && FORBIDDEN_SEGMENTS_SET.has(segment)) {
				let suggestion = "";
				switch (segment) {
					case "hooks":
						suggestion =
							"Move to model/ (domain-specific), api/ (query/mutation), ui/ (UI behavior), or shared/lib/hooks/ (reusable)";
						break;
					case "types":
						suggestion =
							"Move to model/ (business types), api/ (API types), or same file as component (props)";
						break;
					case "utils":
						suggestion = "Move to lib/ (slice-specific) or shared/lib/ (shared utilities)";
						break;
					case "components":
						suggestion = "Move to ui/ segment (components are UI by definition)";
						break;
					case "helpers":
						suggestion = "Move to lib/ segment";
						break;
					case "constants":
						suggestion = "Move to config/ segment";
						break;
					default:
						suggestion = "Move to appropriate segment (ui/, api/, model/, lib/, or config/)";
						break;
				}

				violations.forbiddenSegments.push({
					file: relativePath,
					message: `Forbidden segment name: "${segment}"`,
					severity: "high",
					suggestion,
				});
			}
		}

		// Check for nested segments
		if (hasNestedSegment(filePath)) {
			violations.nestedSegments.push({
				file: relativePath,
				message: "Nested segment structure detected (e.g., ui/components/, ui/hooks/)",
				severity: "medium",
				suggestion: "Flatten structure: move nested segments to appropriate top-level segments",
			});
		}

		// Check for generic technical-role file names within slice segments (Rule 4-4)
		// Only applies to sliced layers (pages, widgets, features, entities)
		// Only checks files inside known segments (model/, ui/, api/, lib/, config/)
		if (layer && SLICED_LAYERS_SET.has(layer) && !isTestFile(filePath)) {
			const parts = relativePath.split(PATH_SEPARATOR_REGEX);
			// Expected structure: layer/slice/segment/...file
			// parts[0] = layer, parts[1] = slice, parts[2] = segment, last = filename
			if (parts.length >= 4) {
				const segmentName = parts[2];
				const fileName = basename(filePath);
				const fileBaseName = fileName.replace(/\.(ts|tsx|js|jsx)$/, "");

				if (
					segmentName &&
					ENFORCED_SEGMENTS_SET.has(segmentName) &&
					FORBIDDEN_FILE_BASENAMES_SET.has(fileBaseName)
				) {
					const slice = parts[1] ?? "unknown";
					let suggestion = "";
					switch (fileBaseName) {
						case "types":
							suggestion = `Rename to a domain-specific name (e.g., ${slice}.ts, ${slice}-types.ts, or ${slice}.types.ts) that describes the business domain`;
							break;
						case "utils":
						case "helpers":
							suggestion = `Rename to describe the domain purpose (e.g., ${slice}-formatting.ts, date-helpers.ts, or ${slice}-transforms.ts)`;
							break;
						case "constants":
							suggestion = `Rename to describe the domain (e.g., ${slice}-defaults.ts, ${slice}-config.ts)`;
							break;
						case "selectors":
							suggestion = `Rename to describe the domain (e.g., ${slice}-selectors.ts or ${slice}.selectors.ts)`;
							break;
						case "reducers":
						case "actions":
						case "thunks":
							suggestion = `Rename to describe the domain (e.g., ${slice}.ts, ${slice}-store.ts, or ${slice}-${fileBaseName}.ts)`;
							break;
						default:
							suggestion = `Rename to a domain-specific name that describes the business purpose`;
							break;
					}

					violations.domainBasedFileNaming.push({
						file: relativePath,
						message: `Generic technical-role file name: "${fileName}" in ${layer}/${slice}/${segmentName}/ -- name files after the business domain, not their technical role`,
						severity: "medium",
						suggestion,
					});
				}
			}
		}

		// Check for wildcard exports in index.ts files
		if (
			(basename(filePath) === "index.ts" || basename(filePath) === "index.tsx") &&
			hasWildcardExport(content)
		) {
			violations.wildcardExports.push({
				file: relativePath,
				message: "Wildcard export found (export * from)",
				severity: "low",
				suggestion: 'Use named exports instead: export { Item } from "./item"',
			});
		}

		// Check for deep relative imports (bypassing public APIs)
		// Only flag if the import likely crosses slice boundaries
		// Deep relative imports within the same slice are allowed per FSD rules
		if (layer && layer !== "app" && layer !== "shared") {
			const currentSlice = getSliceFromPath(filePath, layer);
			if (currentSlice) {
				const lines = content.split("\n");
				for (let index = 0; index < lines.length; index++) {
					const line = lines[index];
					if (!line) {
						continue;
					}
					if (DEEP_RELATIVE_IMPORT_REGEX.test(line)) {
						// Extract the relative import path
						const relativeMatch = line.match(RELATIVE_IMPORT_PATH_REGEX);
						if (relativeMatch?.[2]) {
							const importPath = relativeMatch[2];
							// Count how many ../ are in the import
							const upLevels = relativeMatch[1]?.match(/\.\.\//g)?.length ?? 0;

							// If the import path contains a layer name, it's likely crossing boundaries
							// This is a heuristic - if the path mentions another layer, it's suspicious
							const containsLayerName = LAYERS.some(
								(l) => importPath.includes(`/${l}/`) || importPath.startsWith(`${l}/`)
							);

							// If it's a very deep import (4+ levels) and mentions a layer, flag it
							// OR if it contains segment-like patterns that suggest cross-slice access
							if (containsLayerName && upLevels >= 3) {
								violations.deepRelativeImports.push({
									file: relativePath,
									line: index + 1,
									message: "Deep relative import detected (bypassing public API)",
									severity: "high",
									suggestion:
										"Import from slice public API (index.ts) instead of deep relative paths",
								});
							}
						}
					}
				}
			}
		}

		// Check for hardcoded URLs in entities/features/widgets (not allowed below pages layer)
		// Per FSD Section 14: Lower layers never hardcode URLs.
		if (layer && ENTITY_TIER_SET.has(layer)) {
			const lines = content.split("\n");
			for (let index = 0; index < lines.length; index++) {
				const line = lines[index];
				if (!line) {
					continue;
				}
				const trimmed = line.trim();
				// Skip comments (single-line, JSDoc, block comments)
				if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) {
					continue;
				}
				// Skip import/export statements (module imports, not URL references)
				if (IMPORT_STATEMENT_REGEX.test(trimmed) || EXPORT_FROM_STATEMENT_REGEX.test(trimmed)) {
					continue;
				}
				// Check for hardcoded route paths in JSX/TSX (e.g., href="/dashboard", to="/post/123"),
				// JSX expression forms (href={"/path"}), template literals (href={`/path/${id}`}),
				// and programmatic navigation (router.push("/login"), navigate("/dashboard"))
				const routeProps = [
					ROUTE_HREF_REGEX,
					ROUTE_HREF_JSX_REGEX,
					ROUTE_HREF_TEMPLATE_REGEX,
					ROUTE_TO_REGEX,
					ROUTE_TO_JSX_REGEX,
					ROUTE_TO_TEMPLATE_REGEX,
					ROUTE_PATH_REGEX,
					ROUTE_ROUTE_REGEX,
					ROUTE_URL_REGEX,
					ROUTE_LINK_REGEX,
					ROUTE_ROUTER_PUSH_REGEX,
					ROUTE_NAVIGATE_REGEX,
					ROUTE_ROUTER_PUSH_TEMPLATE_REGEX,
					ROUTE_NAVIGATE_TEMPLATE_REGEX,
				];
				for (const pattern of routeProps) {
					if (pattern.test(line)) {
						const match = line.match(URL_MATCH_REGEX);
						if (match?.[1]) {
							// Skip if it's a shared/routes reference
							const hasSharedRoutes =
								line.includes("shared/routes") || line.includes("@/shared/routes");
							if (!hasSharedRoutes) {
								violations.hardcodedUrls.push({
									file: relativePath,
									line: index + 1,
									message: `Hardcoded URL detected: ${match[1]} (lower layers should not hardcode URLs)`,
									severity: "high",
									suggestion: "Accept routes as props or derive from shared/routes",
								});
								break; // Only report once per line
							}
						}
					}
				}
			}
		}

		// Check for self-imports via own index.ts and deep alias imports into other slices
		if (layer && !APP_OR_SHARED_SET.has(layer)) {
			const currentSlice = getSliceFromPath(filePath, layer);
			if (currentSlice) {
				const lines = content.split("\n");
				let inBlockComment = false;
				for (let index = 0; index < lines.length; index++) {
					const line = lines[index];
					if (!line) {
						continue;
					}
					const trimmed = line.trim();
					// Track block comment state
					if (trimmed.startsWith("/*") || trimmed.startsWith("/**")) {
						inBlockComment = true;
					}
					if (inBlockComment) {
						if (trimmed.includes("*/")) {
							inBlockComment = false;
						}
						continue;
					}
					// Skip single-line comments
					if (trimmed.startsWith("//")) {
						continue;
					}
					const aliasMatch = line.match(ALIAS_IMPORT_REGEX);
					if (!aliasMatch?.[1]) {
						continue;
					}
					const importPath = aliasMatch[1];
					const importParts = importPath.split("/");
					const importLayer = importParts[0] as Layer;
					const importSlice = importParts[1];

					if (!LAYERS_SET.has(importLayer)) {
						continue;
					}

					// CHECK 1: Self-import via own slice's index.ts (circular risk)
					// e.g. from within entities/event/*, importing from "@/entities/event"
					if (importLayer === layer && importSlice === currentSlice && importParts.length === 2) {
						// Skip @x files - they legitimately re-export from their own slice
						if (!isInAtXDirectory(filePath)) {
							violations.selfImports.push({
								file: relativePath,
								line: index + 1,
								message: `Self-import via own index.ts: "@/${importPath}" (circular dependency risk)`,
								severity: "high",
								suggestion:
									"Use relative imports within the same slice instead of importing from own index.ts",
								importPath: line.trim(),
							});
						}
					}

					// CHECK 2: Self-import via deep absolute path into own slice
					// e.g. from within entities/event/*, importing from "@/entities/event/model/..."
					if (importLayer === layer && importSlice === currentSlice && importParts.length > 2) {
						if (!isInAtXDirectory(filePath)) {
							violations.selfImports.push({
								file: relativePath,
								line: index + 1,
								message: `Absolute self-import: "@/${importPath}" (should use relative path within same slice)`,
								severity: "medium",
								suggestion: "Use relative imports within the same slice instead of absolute paths",
								importPath: line.trim(),
							});
						}
					}

					// CHECK 3: Deep alias imports into other slices (bypassing public API)
					// e.g. "@/entities/event/model/event.types" instead of "@/entities/event"
					// Only applies to layers with slices (entities, features, widgets, pages)
					if (
						ENTITY_TIER_WITH_VIEWS_SET.has(importLayer) &&
						importSlice &&
						importParts.length > 2 &&
						!(importLayer === layer && importSlice === currentSlice) // Skip self (handled above)
					) {
						// Allow @x imports - they are the sanctioned cross-entity bridge
						const isAtXImport = importParts[2] === "@x";
						// Allow index.client.ts imports (Next.js pattern)
						const isClientIndex = importParts[2] === "index.client";
						if (!isAtXImport && !isClientIndex && !isTestFile(filePath)) {
							violations.deepAliasImports.push({
								file: relativePath,
								line: index + 1,
								message: `Deep import bypassing public API: "@/${importPath}" → should import from "@/${importLayer}/${importSlice}"`,
								severity: "high",
								suggestion: `Import from "@/${importLayer}/${importSlice}" (public API) instead of reaching into internals. Add missing exports to ${importLayer}/${importSlice}/index.ts if needed.`,
								importPath: line.trim(),
								targetLayer: importLayer,
								targetSlice: importSlice,
							});
						}
					}
				}
			}
		}

		// Check imports for cross-layer violations
		if (layer) {
			const lines = content.split("\n");
			for (let index = 0; index < lines.length; index++) {
				const line = lines[index];
				if (!line) {
					continue;
				}
				const importMatch = line.match(IMPORT_STATEMENT_REGEX);
				const exportFromMatch = line.match(EXPORT_FROM_STATEMENT_REGEX);
				if (importMatch || exportFromMatch) {
					const importInfo = parseImport(line, filePath);
					if (importInfo) {
						// Skip type-only imports from entities to shared (allowed in FSD)
						if (importInfo.isTypeOnly && layer === "shared" && importInfo.layer === "entities") {
							continue;
						}
						// Skip violations in @x files (they are meant to expose cross-layer references)
						if (importInfo.isAtXFile) {
							continue;
						}
						// Skip violations in test files (they need access to higher layers for testing)
						if (importInfo.isTestFile) {
							continue;
						}
						// Always report shared importing from features/widgets/pages/app (critical violation)
						// But exclude @x files and test files
						if (
							layer === "shared" &&
							importInfo.layer &&
							NON_SHARED_COMPOSITION_SET.has(importInfo.layer)
						) {
							violations.crossLayerImports.push({
								file: relativePath,
								line: index + 1,
								message: `Cross-layer import: ${layer} importing from ${importInfo.layer} (violates layer hierarchy)`,
								severity: "critical",
								suggestion: `Shared layer cannot import from ${importInfo.layer}. Extract shared logic to shared/ or move to appropriate layer.`,
								targetLayer: importInfo.layer ?? null,
								targetSlice: importInfo.slice ?? null,
								importPath: line,
							});
							continue;
						}
						if (importInfo.isCrossLayer) {
							// Determine appropriate suggestion based on layers involved
							let suggestion = "";
							if (layer === "shared" && importInfo.layer) {
								suggestion = `Shared layer cannot import from ${importInfo.layer}. Move providers to app/ and import directly, or extract shared logic.`;
							} else if (layer === "features" && importInfo.layer === "widgets") {
								suggestion =
									"Features cannot import from widgets. Import directly from the source feature (e.g., @/features/ai-chat instead of @/widgets/chat).";
							} else if (layer === "features" && importInfo.layer === "features") {
								suggestion =
									"Features cannot import from other features. Extract shared logic to entities/ or shared/.";
							} else if (importInfo.layer === "shared") {
								suggestion = "Extract shared logic to shared/ layer.";
							} else {
								suggestion = `Extract shared logic to ${importInfo.layer ? "a lower layer" : "a lower layer"}.`;
							}

							violations.crossLayerImports.push({
								file: relativePath,
								line: index + 1,
								message: `Cross-layer import: ${layer} importing from ${importInfo.layer} (violates layer hierarchy)`,
								severity: "critical",
								suggestion,
								targetLayer: importInfo.layer ?? null,
								targetSlice: importInfo.slice ?? null,
								importPath: line,
							});
						} else if (importInfo.isCrossSlice && layer === "entities" && importInfo.isMissingAtX) {
							const currentSlice = getSliceFromPath(filePath);
							violations.crossLayerImports.push({
								file: relativePath,
								line: index + 1,
								message: `Cross-entity import missing @x notation: importing from entities/${importInfo.slice} without @x/`,
								severity: "critical",
								suggestion: `Create entities/${currentSlice ?? "slice"}/@x/${importInfo.slice ?? "entity"}.ts and import from there`,
								targetLayer: layer,
								targetSlice: importInfo.slice ?? null,
								importPath: line,
							});
						} else if (importInfo.isCrossSlice && COMPOSITION_LAYERS_SET.has(layer)) {
							violations.crossLayerImports.push({
								file: relativePath,
								line: index + 1,
								message: `Cross-slice import in ${layer} layer: importing from ${layer}/${importInfo.slice}`,
								severity: "critical",
								suggestion: "Extract shared logic to entities/ or shared/",
								targetLayer: layer,
								targetSlice: importInfo.slice ?? null,
								importPath: line,
							});
						}
					}
				}
			}
		}

		// Check require() and dynamic import() calls for cross-layer violations
		// These bypass the static import/export check above
		if (layer && !isTestFile(filePath) && !isInAtXDirectory(filePath)) {
			const lines = content.split("\n");
			for (let index = 0; index < lines.length; index++) {
				const line = lines[index];
				if (!line) {
					continue;
				}
				const trimmed = line.trim();
				// Skip comments
				if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) {
					continue;
				}
				// Check require("@/...") and import("@/...")
				const requireMatch = line.match(REQUIRE_ALIAS_REGEX);
				const dynamicImportMatch = !line.match(IMPORT_STATEMENT_REGEX)
					? line.match(DYNAMIC_IMPORT_ALIAS_REGEX)
					: null;
				const match = requireMatch || dynamicImportMatch;
				if (match?.[1]) {
					const importPath = match[1];
					const parts = importPath.split("/");
					const importLayer = parts[0] as Layer;
					if (!LAYERS_SET.has(importLayer)) {
						continue;
					}
					const importSlice = parts.length > 1 ? (parts[1] ?? null) : null;
					const currentIndex = LAYERS.indexOf(layer);
					const importIndex = LAYERS.indexOf(importLayer);
					const callType = requireMatch ? "require()" : "dynamic import()";

					// Upward cross-layer violation
					if (importIndex < currentIndex && importLayer !== layer) {
						violations.crossLayerImports.push({
							file: relativePath,
							line: index + 1,
							message: `Cross-layer ${callType}: ${layer} importing from ${importLayer} (violates layer hierarchy)`,
							severity: "critical",
							suggestion: `Move this dependency to a higher layer or extract shared logic to a lower layer.`,
							targetLayer: importLayer,
							targetSlice: importSlice,
							importPath: trimmed,
						});
					}
					// shared importing from any other layer (except type-only entities, handled above for static imports)
					else if (layer === "shared" && importLayer !== "shared") {
						violations.crossLayerImports.push({
							file: relativePath,
							line: index + 1,
							message: `Cross-layer ${callType}: shared importing from ${importLayer} (violates layer hierarchy)`,
							severity: "critical",
							suggestion: `Shared layer cannot import from ${importLayer}. Move this provider to app/ or widgets/ layer.`,
							targetLayer: importLayer,
							targetSlice: importSlice,
							importPath: trimmed,
						});
					}
				}
			}
		}
	} catch (error) {
		console.error(`Error analyzing ${filePath}:`, error);
	}
}

/**
 * Generate summary statistics
 */
function generateSummary(): void {
	violations.summary.total =
		violations.forbiddenSegments.length +
		violations.crossLayerImports.length +
		violations.nestedSegments.length +
		violations.wildcardExports.length +
		violations.circularImports.length +
		violations.deepRelativeImports.length +
		violations.deepAliasImports.length +
		violations.selfImports.length +
		violations.missingPublicApi.length +
		violations.artifactFiles.length +
		violations.hardcodedUrls.length +
		violations.appLayerSlices.length +
		violations.sharedLayerSlices.length +
		violations.domainBasedFileNaming.length +
		violations.businessLogicInShared.length +
		violations.processesLayer.length +
		violations.godSlices.length +
		violations.insignificantSlices.length +
		violations.excessiveSlicing.length;

	violations.summary.byCategory = {
		forbiddenSegments: violations.forbiddenSegments.length,
		crossLayerImports: violations.crossLayerImports.length,
		nestedSegments: violations.nestedSegments.length,
		wildcardExports: violations.wildcardExports.length,
		circularImports: violations.circularImports.length,
		deepRelativeImports: violations.deepRelativeImports.length,
		deepAliasImports: violations.deepAliasImports.length,
		selfImports: violations.selfImports.length,
		missingPublicApi: violations.missingPublicApi.length,
		artifactFiles: violations.artifactFiles.length,
		hardcodedUrls: violations.hardcodedUrls.length,
		appLayerSlices: violations.appLayerSlices.length,
		sharedLayerSlices: violations.sharedLayerSlices.length,
		domainBasedFileNaming: violations.domainBasedFileNaming.length,
		businessLogicInShared: violations.businessLogicInShared.length,
		processesLayer: violations.processesLayer.length,
		godSlices: violations.godSlices.length,
		insignificantSlices: violations.insignificantSlices.length,
		excessiveSlicing: violations.excessiveSlicing.length,
	};

	const allViolations = [
		...violations.forbiddenSegments,
		...violations.crossLayerImports,
		...violations.nestedSegments,
		...violations.wildcardExports,
		...violations.circularImports,
		...violations.deepRelativeImports,
		...violations.deepAliasImports,
		...violations.selfImports,
		...violations.missingPublicApi,
		...violations.artifactFiles,
		...violations.hardcodedUrls,
		...violations.appLayerSlices,
		...violations.sharedLayerSlices,
		...violations.domainBasedFileNaming,
		...violations.businessLogicInShared,
		...violations.processesLayer,
		...violations.godSlices,
		...violations.insignificantSlices,
		...violations.excessiveSlicing,
	];

	violations.summary.bySeverity = {
		critical: allViolations.filter((v) => v.severity === "critical").length,
		high: allViolations.filter((v) => v.severity === "high").length,
		medium: allViolations.filter((v) => v.severity === "medium").length,
		low: allViolations.filter((v) => v.severity === "low").length,
	};
}

/**
 * Write violations to markdown files (100 per file)
 */
async function writeViolationsToFiles(): Promise<void> {
	const docsDir = join(srcPath, "..", "docs", "violations");

	// Clear existing violations directory to avoid stale files
	try {
		if (existsSync(docsDir)) {
			await rm(docsDir, { recursive: true, force: true });
		}
	} catch (error) {
		console.error(`Error clearing directory ${docsDir}:`, error);
	}

	// Create directory
	try {
		await mkdir(docsDir, { recursive: true });
	} catch (error) {
		console.error(`Error creating directory ${docsDir}:`, error);
		return;
	}

	// Collect all violations
	const allViolations = [
		...violations.crossLayerImports.map((v) => ({
			...v,
			category: "Cross-Layer Imports",
		})),
		...violations.forbiddenSegments.map((v) => ({
			...v,
			category: "Forbidden Segments",
		})),
		...violations.nestedSegments.map((v) => ({
			...v,
			category: "Nested Segments",
		})),
		...violations.wildcardExports.map((v) => ({
			...v,
			category: "Wildcard Exports",
		})),
		...violations.circularImports.map((v) => ({
			...v,
			category: "Circular Imports",
		})),
		...violations.deepRelativeImports.map((v) => ({
			...v,
			category: "Deep Relative Imports",
		})),
		...violations.deepAliasImports.map((v) => ({
			...v,
			category: "Deep Alias Imports (Bypassing Public API)",
		})),
		...violations.selfImports.map((v) => ({
			...v,
			category: "Self-Imports (Circular Risk)",
		})),
		...violations.missingPublicApi.map((v) => ({
			...v,
			category: "Missing Public API (index.ts)",
		})),
		...violations.artifactFiles.map((v) => ({
			...v,
			category: "Artifact Files",
		})),
		...violations.hardcodedUrls.map((v) => ({
			...v,
			category: "Hardcoded URLs",
		})),
		...violations.appLayerSlices.map((v) => ({
			...v,
			category: "App Layer Slices",
		})),
		...violations.sharedLayerSlices.map((v) => ({
			...v,
			category: "Shared Layer Slices",
		})),
		...violations.domainBasedFileNaming.map((v) => ({
			...v,
			category: "Domain-Based File Naming",
		})),
		...violations.businessLogicInShared.map((v) => ({
			...v,
			category: "Business Logic in Shared",
		})),
		...violations.processesLayer.map((v) => ({
			...v,
			category: "Deprecated Processes Layer",
		})),
		...violations.godSlices.map((v) => ({
			...v,
			category: "God Slices (Oversized)",
		})),
		...violations.insignificantSlices.map((v) => ({
			...v,
			category: "Insignificant Slices",
		})),
		...violations.excessiveSlicing.map((v) => ({
			...v,
			category: "Excessive Slicing",
		})),
	];

	// Split into chunks of 100
	const chunkSize = 100;
	const chunks: Array<Array<Violation & { category: string }>> = [];

	for (let i = 0; i < allViolations.length; i += chunkSize) {
		chunks.push(allViolations.slice(i, i + chunkSize));
	}

	// Write each chunk to a file
	for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
		const chunk = chunks[chunkIndex];
		if (!chunk) {
			continue;
		}
		const chunkNumber = String(chunkIndex + 1).padStart(3, "0");
		const fileName = `violations-${chunkNumber}.md`;
		const filePath = join(docsDir, fileName);

		let content = `# FSD Violations Report - Part ${chunkIndex + 1} of ${chunks.length}\n\n`;
		content += `**Generated:** ${new Date().toISOString()}\n\n`;
		content += `**Total Violations in this file:** ${chunk.length}\n\n`;
		content += "---\n\n";

		// Group by category
		const byCategory: Record<string, Array<Violation & { category: string }>> = {};
		for (const v of chunk) {
			if (!v) {
				continue;
			}
			const category = v.category;
			if (!byCategory[category]) {
				byCategory[category] = [];
			}
			const categoryArray = byCategory[category];
			if (categoryArray) {
				categoryArray.push(v);
			}
		}

		// Write violations as table grouped by category
		for (const [category, categoryViolations] of Object.entries(byCategory)) {
			if (!categoryViolations) {
				continue;
			}
			content += `## ${category}\n\n`;
			content += `**Count:** ${categoryViolations.length}\n\n`;

			// Show description once at the top if all violations have the same message pattern
			const firstViolation = categoryViolations[0];
			if (firstViolation) {
				// Extract the common description pattern (remove file-specific details)
				const commonDescription = extractCommonDescription(firstViolation.message, category);
				const additionalInfo = extractAdditionalInfo(category, categoryViolations);
				content += `**Description:** ${commonDescription}${additionalInfo}\n\n`;
			}

			content += "| Step | Source Lines | Target Location |\n";
			content += "| ---- | ----------- | --------------- |\n";

			for (let i = 0; i < categoryViolations.length; i++) {
				const v = categoryViolations[i];
				if (!v) {
					continue;
				}

				const step = i + 1;
				const sourceLines = v.line ? `${v.file}:${v.line}` : v.file;
				const targetLocation = extractTargetLocation(v.suggestion, v.file, v.category, v);

				// Escape pipe characters in table cells
				const escapeCell = (text: string): string => text.replace(/\|/g, "\\|").replace(/\n/g, " ");

				content += `| ${step} | ${escapeCell(sourceLines)} | ${escapeCell(targetLocation)} |\n`;
			}
			content += "\n";
		}

		// Add navigation footer
		content += "\n---\n\n";
		content += "**Navigation:**\n";
		if (chunkIndex > 0) {
			const prevNumber = String(chunkIndex).padStart(3, "0");
			content += `- [Previous](./violations-${prevNumber}.md)\n`;
		}
		if (chunkIndex < chunks.length - 1) {
			const nextNumber = String(chunkIndex + 2).padStart(3, "0");
			content += `- [Next](./violations-${nextNumber}.md)\n`;
		}
		content += "- [Back to Index](../fsd-compliance-report.md)\n";

		try {
			await writeFile(filePath, content, "utf-8");
			console.log(` Written ${fileName} (${chunk.length} violations)`);
		} catch (error) {
			console.error(`Error writing ${filePath}:`, error);
		}
	}

	console.log(`\n Written ${chunks.length} violation file(s) to ${docsDir}\n`);
}

/**
 * Extract common description pattern for a category
 */
function extractCommonDescription(message: string, category: string): string {
	// Remove file-specific details and keep the general pattern
	if (category === "Cross-Layer Imports") {
		if (message.includes("Cross-layer import:")) {
			return "Cross-layer import violates layer hierarchy";
		}
		if (message.includes("Cross-slice import")) {
			return "Cross-slice import in same layer";
		}
		if (message.includes("Cross-entity import")) {
			return "Cross-entity import missing @x notation";
		}
	}
	if (category === "Nested Segments") {
		return "Nested segment structure detected (e.g., ui/components/, ui/hooks/)";
	}
	if (category === "Hardcoded URLs") {
		return "Hardcoded URL detected in lower layers (should use shared/routes or props)";
	}
	if (category === "Shared Layer Slices") {
		return "Shared layer contains slice-like directory (should only have segments)";
	}
	if (category === "Forbidden Segments") {
		return "Forbidden segment name detected (should use ui/, api/, model/, lib/, or config/)";
	}
	if (category === "Wildcard Exports") {
		return "Wildcard export found in public API (should use named exports)";
	}
	if (category === "Deep Relative Imports") {
		return "Deep relative import detected (bypassing public API)";
	}
	if (category === "Deep Alias Imports (Bypassing Public API)") {
		return "Deep alias import bypasses slice public API (should import from index.ts)";
	}
	if (category === "Self-Imports (Circular Risk)") {
		return "File imports from its own slice's index.ts or via absolute self-path (creates circular dependency risk)";
	}
	if (category === "Missing Public API (index.ts)") {
		return "Slice is missing index.ts public API file";
	}
	if (category === "Artifact Files") {
		return "Artifact/backup file found in codebase (should be deleted)";
	}
	if (category === "Domain-Based File Naming") {
		return "Generic technical-role file name found in slice segment -- name files after the business domain, not their technical role (e.g., types.ts -> user.ts)";
	}
	if (category === "Business Logic in Shared") {
		return "Business logic detected in shared/ layer -- shared should only contain infrastructure (UI kit, utilities, API client setup, route constants). Domain rules and business calculations belong in entities/ or features/.";
	}
	if (category === "Deprecated Processes Layer") {
		return "The processes/ layer is deprecated in FSD v2.1 -- migrate to features/ or app/";
	}
	if (category === "God Slices (Oversized)") {
		return "Slice exceeds per-layer source-file threshold -- indicates overly broad responsibilities that should be split";
	}
	if (category === "Circular Imports") {
		return "Circular import dependency detected between FSD slices -- break the cycle by extracting shared logic to a lower layer";
	}
	if (category === "Insignificant Slices") {
		return "Slice is only used by a single page -- consider colocating it inside that page to reduce unnecessary abstraction";
	}
	if (category === "Excessive Slicing") {
		return "Layer contains too many slices -- indicates poor abstraction that should be reorganized";
	}
	// Fallback to original message if no pattern matches
	return message;
}

/**
 * Extract additional info to add to description
 */
function extractAdditionalInfo(
	category: string,
	violationsList: Array<Violation & { category: string }>
): string {
	if (category === "Cross-Layer Imports") {
		// Check violation types - cross-slice vs cross-layer
		const crossSliceCount = violationsList.filter((v) => v.message.includes("Cross-slice")).length;
		const crossLayerCount = violationsList.length - crossSliceCount;

		if (crossSliceCount > 0 && crossLayerCount === 0) {
			return ". Extract shared logic to entities/ or shared/.";
		}
		if (crossLayerCount > 0 && crossSliceCount === 0) {
			// Check if all have same target layer
			const targetLayers = new Set<string>();
			for (const v of violationsList) {
				if (v.targetLayer) {
					targetLayers.add(v.targetLayer);
				}
			}
			if (targetLayers.size === 1) {
				const layer = Array.from(targetLayers)[0];
				if (layer) {
					return `. Extract shared logic to ${layer}/ layer.`;
				}
			}
		}
		return ". Extract shared logic to entities/ or shared/.";
	}
	if (category === "Nested Segments") {
		return ". Flatten structure by moving nested segments to appropriate top-level segments.";
	}
	if (category === "Hardcoded URLs") {
		return ". Use shared/routes constants or accept routes as props.";
	}
	if (category === "Shared Layer Slices") {
		return ". Reorganize to segments: ui/, api/, config/, lib/, routes/, i18n/.";
	}
	if (category === "Domain-Based File Naming") {
		return ". Rename files to reflect the business domain they represent.";
	}
	return "";
}

/**
 * Extract target location from suggestion or infer from violation
 */
function extractTargetLocation(
	suggestion: string | undefined,
	file: string,
	category: string,
	violation?: Violation
): string {
	if (suggestion) {
		// Try to extract target location from suggestion
		const locationMatch = suggestion.match(/`([^`]+)`/g);
		if (locationMatch && locationMatch.length > 0) {
			// Get the last match which is usually the target
			const lastMatch = locationMatch.at(-1);
			if (lastMatch) {
				return lastMatch.replace(/`/g, "");
			}
		}
		// Check for common patterns
		if (suggestion.includes("shared/")) {
			return "shared/{segment}/";
		}
		if (suggestion.includes("entities/")) {
			return "entities/{entity}/{segment}/";
		}
		if (suggestion.includes("features/")) {
			return "features/{feature}/{segment}/";
		}
	}

	// Infer from file path and category
	const parts = file.split(PATH_SEPARATOR_REGEX);
	if (category === "Forbidden Segments") {
		// Move to appropriate segment
		if (file.includes("hooks")) {
			return `${parts.slice(0, -2).join("/")}/model/ or api/`;
		}
		if (file.includes("types")) {
			return `${parts.slice(0, -2).join("/")}/model/`;
		}
		if (file.includes("utils") || file.includes("helpers")) {
			return `${parts.slice(0, -2).join("/")}/lib/`;
		}
		if (file.includes("components")) {
			return `${parts.slice(0, -2).join("/")}/ui/`;
		}
		if (file.includes("constants")) {
			return `${parts.slice(0, -2).join("/")}/config/`;
		}
	}

	if (category === "Nested Segments") {
		// Flatten to top-level segment
		const layerIndex = parts.findIndex((p) =>
			["features", "entities", "widgets", "views"].includes(p)
		);
		if (layerIndex >= 0) {
			return `${parts.slice(0, layerIndex + 2).join("/")}/`;
		}
	}

	if (category === "Cross-Layer Imports") {
		// Handle cross-slice vs cross-layer differently
		if (violation?.message?.includes("Cross-slice")) {
			// Cross-slice import within same layer
			const fileParts = file.split(PATH_SEPARATOR_REGEX);
			const sourceLayer = fileParts[0];
			const sourceSlice = fileParts[1];
			const targetSlice = violation.targetSlice;

			if (sourceLayer === "features" && targetSlice) {
				return `entities/{entity}/ or shared/lib/ (extract shared logic from ${targetSlice})`;
			}
			if (sourceLayer === "widgets" && targetSlice) {
				return `features/ or entities/ (extract shared logic from ${targetSlice})`;
			}
			if (sourceLayer === "views" && targetSlice) {
				return `widgets/, features/, or entities/ (extract shared logic from ${targetSlice})`;
			}
			if (sourceLayer === "entities" && targetSlice) {
				return `entities/${sourceSlice ?? "current"}/@x/${targetSlice}.ts (use @x notation)`;
			}
			return "entities/ or shared/";
		}

		// Cross-layer import
		if (violation?.targetLayer) {
			if (violation.targetLayer === "shared") {
				return "shared/{segment}/";
			}
			if (violation.targetLayer === "entities") {
				if (violation.targetSlice) {
					return `entities/${violation.targetSlice}/`;
				}
				return "entities/{entity}/";
			}
			if (violation.targetLayer === "features" && violation.targetSlice) {
				return `entities/ or shared/ (extract from features/${violation.targetSlice})`;
			}
			return `${violation.targetLayer}/`;
		}
		if (suggestion?.includes("shared/")) {
			return "shared/{segment}/";
		}
		if (suggestion?.includes("entities/")) {
			return "entities/{entity}/";
		}
		// Try to extract from file path
		const fileParts = file.split(PATH_SEPARATOR_REGEX);
		if (fileParts[0] === "shared") {
			return "Move logic to entities/ or remove dependency";
		}
		if (fileParts[0] === "entities") {
			return "Move to shared/ or extract to lower layer";
		}
		if (fileParts[0] === "features") {
			return "Extract to entities/ or shared/";
		}
		return "See description above";
	}

	if (category === "Hardcoded URLs") {
		return "shared/routes/ or accept as props";
	}

	if (category === "Shared Layer Slices") {
		return "shared/{segment}/ (ui/, api/, config/, lib/, routes/, i18n/)";
	}

	if (category === "Domain-Based File Naming") {
		// Suggest renaming in same location with domain-based name
		const fileParts = file.split(PATH_SEPARATOR_REGEX);
		const dir = fileParts.slice(0, -1).join("/");
		const slice = fileParts[1] ?? "domain";
		return `${dir}/${slice}.ts (or other domain-specific name)`;
	}

	return "See suggestion";
}

/**
 * Format and print the violation report
 */
function printReport(): void {
	console.log(`\n${"=".repeat(80)}`);
	console.log("FSD VIOLATION REPORT");
	console.log("=".repeat(80));
	console.log(`\nScanning directory: ${srcPath}\n`);

	// Summary
	console.log(" SUMMARY");
	console.log("-".repeat(80));
	console.log(`Total Violations: ${violations.summary.total}`);
	console.log("\nBy Severity:");
	console.log(`  Critical: ${violations.summary.bySeverity.critical}`);
	console.log(`  High:     ${violations.summary.bySeverity.high}`);
	console.log(`  Medium:   ${violations.summary.bySeverity.medium}`);
	console.log(`  Low:      ${violations.summary.bySeverity.low}`);
	console.log("\nBy Category:");
	console.log(`  Forbidden Segments:    ${violations.summary.byCategory.forbiddenSegments}`);
	console.log(`  Cross-Layer Imports:   ${violations.summary.byCategory.crossLayerImports}`);
	console.log(`  Deep Alias Imports:    ${violations.summary.byCategory.deepAliasImports}`);
	console.log(`  Self-Imports:          ${violations.summary.byCategory.selfImports}`);
	console.log(`  Missing Public API:    ${violations.summary.byCategory.missingPublicApi}`);
	console.log(`  Artifact Files:        ${violations.summary.byCategory.artifactFiles}`);
	console.log(`  Nested Segments:       ${violations.summary.byCategory.nestedSegments}`);
	console.log(`  Wildcard Exports:      ${violations.summary.byCategory.wildcardExports}`);
	console.log(`  Circular Imports:      ${violations.summary.byCategory.circularImports}`);
	console.log(`  Deep Relative Imports: ${violations.summary.byCategory.deepRelativeImports}`);
	console.log(`  Hardcoded URLs:        ${violations.summary.byCategory.hardcodedUrls}`);
	console.log(`  App Layer Slices:      ${violations.summary.byCategory.appLayerSlices}`);
	console.log(`  Shared Layer Slices:   ${violations.summary.byCategory.sharedLayerSlices}`);
	console.log(`  Domain File Naming:    ${violations.summary.byCategory.domainBasedFileNaming}`);
	console.log(`  Business in Shared:    ${violations.summary.byCategory.businessLogicInShared}`);
	console.log(`  Processes Layer:       ${violations.summary.byCategory.processesLayer}`);
	console.log(`  God Slices:            ${violations.summary.byCategory.godSlices}`);
	console.log(`  Insignificant Slices:  ${violations.summary.byCategory.insignificantSlices}`);
	console.log(`  Excessive Slicing:     ${violations.summary.byCategory.excessiveSlicing}`);

	// Processes Layer (Deprecated)
	if (violations.processesLayer.length > 0) {
		console.log("\n\n  HIGH: Deprecated Processes Layer");
		console.log("=".repeat(80));
		for (let i = 0; i < violations.processesLayer.length; i++) {
			const v = violations.processesLayer[i];
			if (!v) {
				continue;
			}
			console.log(`\n${i + 1}. ${v.file}`);
			console.log(`   ${v.message}`);
			if (v.suggestion) {
				console.log(`    ${v.suggestion}`);
			}
		}
	}

	// Business Logic in Shared
	if (violations.businessLogicInShared.length > 0) {
		console.log("\n\n  MEDIUM: Business Logic in Shared Layer");
		console.log("=".repeat(80));
		for (let i = 0; i < violations.businessLogicInShared.length; i++) {
			const v = violations.businessLogicInShared[i];
			if (!v) {
				continue;
			}
			console.log(`\n${i + 1}. ${v.file}`);
			console.log(`   ${v.message}`);
			if (v.suggestion) {
				console.log(`    ${v.suggestion}`);
			}
		}
	}

	// God Slices
	if (violations.godSlices.length > 0) {
		console.log("\n\n  MEDIUM: God Slices (Oversized)");
		console.log("=".repeat(80));
		for (let i = 0; i < violations.godSlices.length; i++) {
			const v = violations.godSlices[i];
			if (!v) {
				continue;
			}
			console.log(`\n${i + 1}. ${v.file}`);
			console.log(`   ${v.message}`);
			if (v.suggestion) {
				console.log(`    ${v.suggestion}`);
			}
		}
	}

	// Critical: Circular Imports
	if (violations.circularImports.length > 0) {
		console.log("\n\n CRITICAL: Circular Imports Between Slices");
		console.log("=".repeat(80));
		for (let i = 0; i < violations.circularImports.length; i++) {
			const v = violations.circularImports[i];
			if (!v) {
				continue;
			}
			console.log(`\n${i + 1}. ${v.file}`);
			console.log(`   ${v.message}`);
			if (v.suggestion) {
				console.log(`    ${v.suggestion}`);
			}
		}
	}

	// Low: Insignificant Slices
	if (violations.insignificantSlices.length > 0) {
		console.log("\n\nℹ  LOW: Insignificant Slices (Single Consumer)");
		console.log("=".repeat(80));
		for (let i = 0; i < violations.insignificantSlices.length; i++) {
			const v = violations.insignificantSlices[i];
			if (!v) {
				continue;
			}
			console.log(`\n${i + 1}. ${v.file}`);
			console.log(`   ${v.message}`);
			if (v.suggestion) {
				console.log(`    ${v.suggestion}`);
			}
		}
	}

	// Medium: Excessive Slicing
	if (violations.excessiveSlicing.length > 0) {
		console.log("\n\n  MEDIUM: Excessive Slicing");
		console.log("=".repeat(80));
		for (let i = 0; i < violations.excessiveSlicing.length; i++) {
			const v = violations.excessiveSlicing[i];
			if (!v) {
				continue;
			}
			console.log(`\n${i + 1}. ${v.file}`);
			console.log(`   ${v.message}`);
			if (v.suggestion) {
				console.log(`    ${v.suggestion}`);
			}
		}
	}

	// Critical Violations
	if (violations.crossLayerImports.length > 0) {
		console.log("\n\n CRITICAL: Cross-Layer Import Violations");
		console.log("=".repeat(80));
		for (let i = 0; i < violations.crossLayerImports.length; i++) {
			const v = violations.crossLayerImports[i];
			if (!v) {
				continue;
			}
			const lineInfo = v.line ? `:${v.line}` : "";
			console.log(`\n${i + 1}. ${v.file}${lineInfo}`);
			console.log(`   ${v.message}`);
			if (v.suggestion) {
				console.log(`    ${v.suggestion}`);
			}
		}
	}

	// High Severity Violations
	if (violations.forbiddenSegments.length > 0) {
		console.log("\n\n  HIGH: Forbidden Segment Names");
		console.log("=".repeat(80));

		// Group by segment type
		const bySegment: Record<string, Violation[]> = {};
		for (const v of violations.forbiddenSegments) {
			const match = v.message.match(QUOTE_MATCH_REGEX);
			const segment = match?.[1] ?? "unknown";
			if (!bySegment[segment]) {
				bySegment[segment] = [];
			}
			bySegment[segment].push(v);
		}

		for (const [segment, segViolations] of Object.entries(bySegment)) {
			console.log(`\n${segment}/ (${segViolations.length} files):`);
			for (const v of segViolations.slice(0, 10)) {
				console.log(`  - ${v.file}`);
			}
			if (segViolations.length > 10) {
				console.log(`  ... and ${segViolations.length - 10} more`);
			}
			if (segViolations[0]?.suggestion) {
				console.log(`   ${segViolations[0].suggestion}`);
			}
		}
	}

	// Medium Severity Violations
	if (violations.nestedSegments.length > 0) {
		console.log("\n\n  MEDIUM: Nested Segment Structures");
		console.log("=".repeat(80));
		const nestedToShow = violations.nestedSegments.slice(0, 20);
		for (let i = 0; i < nestedToShow.length; i++) {
			const v = nestedToShow[i];
			if (!v) {
				continue;
			}
			console.log(`\n${i + 1}. ${v.file}`);
			console.log(`   ${v.message}`);
			if (v.suggestion) {
				console.log(`    ${v.suggestion}`);
			}
		}
		if (violations.nestedSegments.length > 20) {
			console.log(`\n... and ${violations.nestedSegments.length - 20} more`);
		}
	}

	// High Severity: Deep Alias Imports (Bypassing Public API)
	if (violations.deepAliasImports.length > 0) {
		console.log("\n\n  HIGH: Deep Alias Imports (Bypassing Public API)");
		console.log("=".repeat(80));
		const deepAliasToShow = violations.deepAliasImports.slice(0, 30);
		for (let i = 0; i < deepAliasToShow.length; i++) {
			const v = deepAliasToShow[i];
			if (!v) {
				continue;
			}
			const lineInfo = v.line ? `:${v.line}` : "";
			console.log(`\n${i + 1}. ${v.file}${lineInfo}`);
			console.log(`   ${v.message}`);
			if (v.suggestion) {
				console.log(`    ${v.suggestion}`);
			}
		}
		if (violations.deepAliasImports.length > 30) {
			console.log(`\n... and ${violations.deepAliasImports.length - 30} more`);
		}
	}

	// High Severity: Self-Imports (Circular Risk)
	if (violations.selfImports.length > 0) {
		console.log("\n\n  HIGH: Self-Imports via Own index.ts (Circular Risk)");
		console.log("=".repeat(80));
		const selfToShow = violations.selfImports.slice(0, 30);
		for (let i = 0; i < selfToShow.length; i++) {
			const v = selfToShow[i];
			if (!v) {
				continue;
			}
			const lineInfo = v.line ? `:${v.line}` : "";
			console.log(`\n${i + 1}. ${v.file}${lineInfo}`);
			console.log(`   ${v.message}`);
			if (v.suggestion) {
				console.log(`    ${v.suggestion}`);
			}
		}
		if (violations.selfImports.length > 30) {
			console.log(`\n... and ${violations.selfImports.length - 30} more`);
		}
	}

	// High Severity: Missing Public API
	if (violations.missingPublicApi.length > 0) {
		console.log("\n\n  HIGH: Missing Public API (index.ts)");
		console.log("=".repeat(80));
		for (let i = 0; i < violations.missingPublicApi.length; i++) {
			const v = violations.missingPublicApi[i];
			if (!v) {
				continue;
			}
			console.log(`\n${i + 1}. ${v.file}`);
			console.log(`   ${v.message}`);
			if (v.suggestion) {
				console.log(`    ${v.suggestion}`);
			}
		}
	}

	// High Severity: Artifact Files
	if (violations.artifactFiles.length > 0) {
		console.log("\n\n  HIGH: Artifact Files (Should Be Deleted)");
		console.log("=".repeat(80));
		for (let i = 0; i < violations.artifactFiles.length; i++) {
			const v = violations.artifactFiles[i];
			if (!v) {
				continue;
			}
			console.log(`\n${i + 1}. ${v.file}`);
			console.log(`   ${v.message}`);
			if (v.suggestion) {
				console.log(`    ${v.suggestion}`);
			}
		}
	}

	// High Severity: Deep Relative Imports
	if (violations.deepRelativeImports.length > 0) {
		console.log("\n\n  HIGH: Deep Relative Imports (Bypassing Public APIs)");
		console.log("=".repeat(80));
		const deepToShow = violations.deepRelativeImports.slice(0, 20);
		for (let i = 0; i < deepToShow.length; i++) {
			const v = deepToShow[i];
			if (!v) {
				continue;
			}
			const lineInfo = v.line ? `:${v.line}` : "";
			console.log(`\n${i + 1}. ${v.file}${lineInfo}`);
			console.log(`   ${v.message}`);
			if (v.suggestion) {
				console.log(`    ${v.suggestion}`);
			}
		}
		if (violations.deepRelativeImports.length > 20) {
			console.log(`\n... and ${violations.deepRelativeImports.length - 20} more`);
		}
	}

	// High Severity: Hardcoded URLs
	if (violations.hardcodedUrls.length > 0) {
		console.log("\n\n  HIGH: Hardcoded URLs in Lower Layers");
		console.log("=".repeat(80));
		const urlToShow = violations.hardcodedUrls.slice(0, 20);
		for (let i = 0; i < urlToShow.length; i++) {
			const v = urlToShow[i];
			if (!v) {
				continue;
			}
			const lineInfo = v.line ? `:${v.line}` : "";
			console.log(`\n${i + 1}. ${v.file}${lineInfo}`);
			console.log(`   ${v.message}`);
			if (v.suggestion) {
				console.log(`    ${v.suggestion}`);
			}
		}
		if (violations.hardcodedUrls.length > 20) {
			console.log(`\n... and ${violations.hardcodedUrls.length - 20} more`);
		}
	}

	// High Severity: App/Shared Layer Slices
	if (violations.appLayerSlices.length > 0) {
		console.log("\n\n  HIGH: App Layer Contains Slices");
		console.log("=".repeat(80));
		for (let i = 0; i < violations.appLayerSlices.length; i++) {
			const v = violations.appLayerSlices[i];
			if (!v) {
				continue;
			}
			console.log(`\n${i + 1}. ${v.file}`);
			console.log(`   ${v.message}`);
			if (v.suggestion) {
				console.log(`    ${v.suggestion}`);
			}
		}
	}

	if (violations.sharedLayerSlices.length > 0) {
		console.log("\n\n  HIGH: Shared Layer Contains Slices");
		console.log("=".repeat(80));
		for (let i = 0; i < violations.sharedLayerSlices.length; i++) {
			const v = violations.sharedLayerSlices[i];
			if (!v) {
				continue;
			}
			console.log(`\n${i + 1}. ${v.file}`);
			console.log(`   ${v.message}`);
			if (v.suggestion) {
				console.log(`    ${v.suggestion}`);
			}
		}
	}

	// Medium Severity: Domain-Based File Naming
	if (violations.domainBasedFileNaming.length > 0) {
		console.log("\n\n  MEDIUM: Domain-Based File Naming Violations");
		console.log("=".repeat(80));
		const namingToShow = violations.domainBasedFileNaming.slice(0, 20);
		for (let i = 0; i < namingToShow.length; i++) {
			const v = namingToShow[i];
			if (!v) {
				continue;
			}
			console.log(`\n${i + 1}. ${v.file}`);
			console.log(`   ${v.message}`);
			if (v.suggestion) {
				console.log(`    ${v.suggestion}`);
			}
		}
		if (violations.domainBasedFileNaming.length > 20) {
			console.log(`\n... and ${violations.domainBasedFileNaming.length - 20} more`);
		}
	}

	// Low Severity Violations
	if (violations.wildcardExports.length > 0) {
		console.log("\n\nℹ  LOW: Wildcard Exports in Public APIs");
		console.log("=".repeat(80));
		const wildcardToShow = violations.wildcardExports.slice(0, 10);
		for (let i = 0; i < wildcardToShow.length; i++) {
			const v = wildcardToShow[i];
			if (!v) {
				continue;
			}
			console.log(`\n${i + 1}. ${v.file}`);
			console.log(`   ${v.message}`);
			if (v.suggestion) {
				console.log(`    ${v.suggestion}`);
			}
		}
		if (violations.wildcardExports.length > 10) {
			console.log(`\n... and ${violations.wildcardExports.length - 10} more`);
		}
	}

	console.log(`\n${"=".repeat(80)}`);
	console.log("Report Complete");
	console.log(`${"=".repeat(80)}\n`);
}

/**
 * Main execution
 */
async function main(): Promise<void> {
	// Parse --diff-base flag for incremental mode
	const diffBaseIndex = process.argv.indexOf("--diff-base");
	const diffBase = diffBaseIndex >= 0 ? process.argv[diffBaseIndex + 1] : undefined;

	let incrementalFiles: string[] | null = null;
	if (diffBase) {
		incrementalFiles = getChangedFiles(diffBase, srcPath);
		if (incrementalFiles && incrementalFiles.length === 0) {
			console.log("No FSD-relevant files changed. Skipping analysis.");
			// Still write empty JSON if --json flag is set
			if (process.argv.includes("--json")) {
				const jsonPath = join(srcPath, "..", "fsd-violations.json");
				await writeFile(
					jsonPath,
					JSON.stringify(
						{
							violations: {},
							summary: { total: 0, bySeverity: {}, byCategory: {} },
						},
						null,
						2
					)
				);
			}
			return;
		}
		if (incrementalFiles) {
			console.log(
				`Incremental scan: ${incrementalFiles.length} changed files (base: ${diffBase})\n`
			);
		}
	}

	if (!incrementalFiles) {
		console.log("Scanning for FSD violations...\n");
	}

	// Structure checks always run in full (they check directory structure, not file contents)
	await Promise.all([
		checkAppLayerSlices(),
		checkSharedLayerSlices(),
		checkMissingPublicApis(),
		checkArtifactFiles(srcPath),
		checkGodSlices(),
		checkBusinessLogicInShared(),
		checkExcessiveSlicing(),
	]);
	checkProcessesLayer();

	const files = incrementalFiles ?? (await scanDirectory(srcPath));
	console.log(`Found ${files.length} files to analyze\n`);

	// Analyze files (per-file checks)
	for (const file of files) {
		await analyzeFile(file);
	}

	// Cross-file checks (need the full file list)
	checkCircularImports(files);
	await checkInsignificantSlices(files);

	// Generate summary
	generateSummary();

	// Print report
	printReport();

	// Write violations to markdown files
	await writeViolationsToFiles();

	// Write JSON output if --json flag is set
	if (process.argv.includes("--json")) {
		const jsonPath = join(srcPath, "..", "fsd-violations.json");
		await writeFile(
			jsonPath,
			JSON.stringify(
				{
					violations: {
						crossLayerImports: violations.crossLayerImports,
						forbiddenSegments: violations.forbiddenSegments,
						deepAliasImports: violations.deepAliasImports,
						selfImports: violations.selfImports,
						missingPublicApi: violations.missingPublicApi,
						hardcodedUrls: violations.hardcodedUrls,
						domainBasedFileNaming: violations.domainBasedFileNaming,
						processesLayer: violations.processesLayer,
						godSlices: violations.godSlices,
						circularImports: violations.circularImports,
						insignificantSlices: violations.insignificantSlices,
						excessiveSlicing: violations.excessiveSlicing,
					},
					summary: violations.summary,
				},
				null,
				2
			)
		);
	}

	// Exit with error code if critical or high violations found
	if (
		(violations.summary.bySeverity.critical ?? 0) > 0 ||
		(violations.summary.bySeverity.high ?? 0) > 0
	) {
		process.exit(1);
	}
}

main().catch((error) => {
	console.error("Fatal error:", error);
	process.exit(1);
});
