#!/usr/bin/env bun

/**
 * FSD Violation Detection Script
 *
 * Detects all Feature-Sliced Design architecture violations according to
 * the rules defined in:
 *   - frontend/CLAUDE.md (project-specific FSD rulebook)
 *   - frontend/.fsd-ledger/ (per-rule provenance + residuals; the rules
 *     here are derived from the official FSD spec at https://fsd.how
 *     — see .fsd-ledger/_COVERAGE_MATRIX.md for the cross-reference)
 *
 * Stack assumptions:
 *   - Bundler: Vite (multi-page Electron renderer; one HTML + one
 *     src/entries/<name>.tsx per BrowserWindow). No Next.js, no router
 *     framework — the old Next-era guards (App-Router app/ re-exports,
 *     Pages-Router pages/_app.tsx, middleware.ts, instrumentation.ts)
 *     have been removed.
 *   - FSD layer rename: WinSTT keeps the FSD `pages` layer as `src/views/`
 *     (originally a Next.js Pages-Router collision workaround; kept post
 *     the Vite migration for import stability).
 */

import { execSync } from "node:child_process";
import { type Dirent, existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

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
	// Batch B — Public API & Cross-Import Hardening
	atxMisuse: Violation[];
	authInEntities: Violation[];
	authInPageWidget: Violation[];
	authPagePairing: Violation[];
	businessLogicInShared: Violation[];
	circularImports: Violation[];
	crossLayerImports: Violation[];
	// Batch C — Entity/Feature semantics & shared-layer purity
	crudInEntities: Violation[];
	deepAliasImports: Violation[];
	deepRelativeImports: Violation[];
	domainBasedFileNaming: Violation[];
	// Batch D — Framework boundaries (Electron / Vite / React-Query / routes)
	electronBoundary: Violation[];
	excessiveSlicing: Violation[];
	featureInfraSmuggling: Violation[];
	forbiddenSegments: Violation[];
	genericFeatureName: Violation[];
	godSlices: Violation[];
	hardcodedUrls: Violation[];
	httpClientOutsideShared: Violation[];
	indexTheater: Violation[];
	insignificantSlices: Violation[];
	launderedCrossImports: Violation[];
	localDtoInEntities: Violation[];
	misplacedApiRequest: Violation[];
	misplacedDtoMapper: Violation[];
	misplacedTypes: Violation[];
	missingPublicApi: Violation[];
	multiPurposeFeature: Violation[];
	nestedSegments: Violation[];
	// Batch A — Layer & Structure Integrity
	nonCanonicalLayers: Violation[];
	nonCanonicalSegments: Violation[];
	processesLayer: Violation[];
	reactQueryPlacement: Violation[];
	redirectOwnership: Violation[];
	reservedTermNaming: Violation[];
	routerPlacement: Violation[];
	scatteredDomain: Violation[];
	segmentAsSlice: Violation[];
	selfImports: Violation[];
	sharedAggregateImports: Violation[];
	sharedLayerSlices: Violation[];
	sharedNameMirrorsSlice: Violation[];
	sharedQueryKeys: Violation[];
	sliceGroupCode: Violation[];
	summary: {
		total: number;
		bySeverity: Record<string, number>;
		byCategory: Record<string, number>;
	};
	wildcardExports: Violation[];
}

// FSD Layer hierarchy (top to bottom)
// NOTE: WinSTT uses `views/` instead of `pages/` to avoid conflict with Pages-style routers.
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
// These are common patterns that extend FSD for real-world projects.
// `auth` is EXPLICITLY sanctioned by the FSD auth guide (ex-auth Rex-auth-05):
// "create `src/shared/auth/` (token store + refresh logic)". Without it here
// checkSharedLayerSlices would FALSE-POSITIVE flag the sanctioned `shared/auth/`
// directory. Likewise `assets`, `styles`, `fonts`, `mocks` are common shared
// infrastructure folders the FSD examples sanction.
const SHARED_LAYER_ALLOWED_DIRS = [
	"infrastructure",
	"ports",
	"styles",
	"auth",
	"assets",
	"fonts",
	"mocks",
] as const;
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

/**
 * Resolve the src/ directory to scan.
 *
 * Test-harness override (Batch A / Step 0): a `--src <dir>` argv flag OR a
 * `FSD_SRC_DIR` environment variable points the scanner at a throwaway fixture
 * tree instead of the real `frontend/src/`. When NEITHER is set, this returns
 * exactly `join(FRONTEND_DIR, "src")` — the original hardcoded default — so the
 * default run is byte-identical in behavior to before this override existed.
 *
 * Resolution order: `--src` argv (highest) > `FSD_SRC_DIR` env > default.
 * Relative override paths are resolved against the current working directory.
 */
function resolveSrcPath(): string {
	const defaultSrc = join(FRONTEND_DIR, "src");
	const srcFlagIndex = process.argv.indexOf("--src");
	const argvSrc = srcFlagIndex >= 0 ? process.argv[srcFlagIndex + 1] : undefined;
	const envSrc = process.env.FSD_SRC_DIR;
	const override = argvSrc ?? envSrc;
	if (!override) {
		return defaultSrc;
	}
	return isAbsolute(override) ? override : resolve(process.cwd(), override);
}

const srcPath = resolveSrcPath();

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
	nonCanonicalLayers: [],
	nonCanonicalSegments: [],
	atxMisuse: [],
	indexTheater: [],
	launderedCrossImports: [],
	sharedAggregateImports: [],
	sliceGroupCode: [],
	segmentAsSlice: [],
	scatteredDomain: [],
	reservedTermNaming: [],
	sharedNameMirrorsSlice: [],
	processesLayer: [],
	godSlices: [],
	insignificantSlices: [],
	excessiveSlicing: [],
	// Batch C — Entity/Feature semantics & shared-layer purity
	crudInEntities: [],
	authInEntities: [],
	localDtoInEntities: [],
	misplacedDtoMapper: [],
	misplacedTypes: [],
	httpClientOutsideShared: [],
	misplacedApiRequest: [],
	sharedQueryKeys: [],
	genericFeatureName: [],
	featureInfraSmuggling: [],
	multiPurposeFeature: [],
	authInPageWidget: [],
	authPagePairing: [],
	// Batch D — Framework boundaries
	electronBoundary: [],
	routerPlacement: [],
	reactQueryPlacement: [],
	redirectOwnership: [],
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
				message: `src/app/${entry.name}/ is a business-domain slice — the app layer is slice-free and may contain only technical segments (FSD Rref-layers-03).`,
				severity: "high",
				suggestion: `Move src/app/${entry.name}/: a domain concept → src/entities/${entry.name}/ (with ui/ api/ model/ index.ts); a user interaction → src/features/${entry.name}/; app-wide wiring → an app segment (providers/, layouts/, styles/, assets/, api-routes/). Keep ONLY technical segments directly under src/app/. Do not rename ${entry.name}/ to a fake segment to hide it.`,
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
				message: `src/shared/${entry.name}/ is a business-domain slice — the shared layer is slice-free and may contain only technical segments (FSD Rref-layers-03).`,
				severity: "high",
				suggestion: `Move src/shared/${entry.name}/: a domain concept → src/entities/${entry.name}/ (with ui/ api/ model/ index.ts); a user interaction → src/features/${entry.name}/. Keep ONLY technical segments directly under src/shared/ (ui/ api/ lib/ config/ routes/ i18n/, plus sanctioned infrastructure/ ports/ auth/ assets/ fonts/ mocks/). Do not rename ${entry.name}/ to a fake segment (services/, models/, modules/) or hide it inside shared/ui/${entry.name}/ — that is the same violation.`,
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
				"Delete src/processes/ (also applies to synonyms flows/ workflows/ sagas/). Relocate its code: router-level/multi-page orchestration → src/app/ (e.g. src/app/providers/ or app routing); a concrete reusable multi-step interaction → src/features/<feature>/. Do not recreate it under src/app/processes/ or disguise it as a fake widget.",
		});
	}
}

// ===========================================================================
// Batch A — Layer & Structure Integrity
// Implements: ref-layers (01–04), und-naming (01–04), gs-overview (01,03,05,06),
// iss-desegmented (01,02,03), mig-combined (01,02 structural), skill (06,07,09,10).
// All checks below are STRUCTURAL (path/dir analysis) and additive — they do not
// alter any pre-existing category. The real WinSTT src/ is FSD-clean, so every
// allowlist below is tuned to keep it at baseline Total=1.
// ===========================================================================

// The only valid top-level FSD layer directories under src/ for WinSTT.
// `views` is WinSTT's deliberate, sanctioned rename of FSD `pages` (originally
// to dodge the Next.js Pages-Router collision; the rename stuck after the
// migration to Vite because flipping it back would touch every `@/views/*`
// import for zero architectural gain).
const CANONICAL_LAYERS_SET = new Set<string>([
	"app",
	"views",
	"widgets",
	"features",
	"entities",
	"shared",
]);

// Sanctioned NON-layer top-level directories under src/. These are not FSD
// layers — they are project conventions that must exist alongside the layers
// without being flagged by checkNonCanonicalLayers. Files inside these dirs
// are treated as "outside FSD" (getLayerFromPath returns null), so the
// layer-aware import checks correctly skip them while the structural checks
// (wildcardExports, artifactFiles, etc.) still apply per-file.
//
// `entries/` is the Vite multi-page Electron renderer bootstrap location.
// Each Electron BrowserWindow loads its own HTML file from frontend/ root;
// each HTML's <script> tag points at `src/entries/<name>.tsx`, which does
// `createRoot(...).render(<View />)` and composes the FSD `app/` layout
// stack around a `views/<view>` page. There is one .tsx per window
// (main, settings, overlay, tray-menu, model-picker, device-picker,
// onboarding). The vite.config.ts `rollupOptions.input` map is the
// canonical list of valid entries; this script does NOT enforce that
// listing — that is the build's job.
//
// Semantically these files belong to the FSD `app/` layer (they ARE the
// renderer bootstrap), but Vite needs them at a stable input path that
// matches the HTML reference, so they live at src/entries/ rather than
// inside src/app/. Treat this as a Vite-imposed deviation from canonical
// FSD layout, not a slice or a new layer.
const RENDERER_BOOTSTRAP_ALLOWED_DIRS_SET = new Set<string>(["entries"]);

// Deprecated `processes` layer + its documented synonyms / ad-hoc-layer revivals
// (ref-layers-04, und-naming-03, mig-combined-01, skill-09/10). Any of these as a
// top-level dir (or singular/cased variant) is the deprecated processes layer.
const PROCESSES_SYNONYMS_SET = new Set<string>([
	"processes",
	"process",
	"proc",
	"procs",
	"flows",
	"flow",
	"workflows",
	"workflow",
	"sagas",
	"saga",
	"scenarios",
	"scenario",
	"orchestration",
	"orchestrations",
	"wizards",
	"wizard",
]);

// Generic technical-role / package-by-layer names that masquerade as a layer
// (und-naming-01, gs-overview-01, iss-desegmented-03, skill-10). Used both as the
// top-level-layer denylist (with a canonical-target hint) and the slice-internal
// generic-folder denylist (iss-desegmented-01).
const GENERIC_GROUPING_TO_TARGET: Record<string, string> = {
	components: "ui",
	component: "ui",
	comps: "ui",
	parts: "ui",
	blocks: "ui",
	views: "ui", // `views` as a *segment* (not the top-level layer) is a UI synonym
	view: "ui",
	containers: "ui",
	container: "ui",
	pages: "ui",
	screens: "ui",
	screen: "ui",
	hooks: "model",
	hook: "model",
	store: "model",
	stores: "model",
	state: "model",
	states: "model",
	logic: "model",
	domain: "model",
	models: "model",
	actions: "model",
	action: "model",
	reducers: "model",
	reducer: "model",
	selectors: "model",
	selector: "model",
	getters: "model",
	getter: "model",
	thunks: "model",
	thunk: "model",
	slices: "model",
	types: "model",
	type: "model",
	typedefs: "model",
	typedef: "model",
	tipos: "model",
	utils: "lib",
	util: "lib",
	utilities: "lib",
	utility: "lib",
	helpers: "lib",
	helper: "lib",
	hilfen: "lib",
	fns: "lib",
	common: "lib",
	commons: "lib",
	core: "lib",
	misc: "lib",
	shared: "lib",
	services: "api",
	service: "api",
	requests: "api",
	request: "api",
	queries: "api",
	query: "api",
	endpoints: "api",
	endpoint: "api",
	controllers: "api",
	controller: "api",
	constants: "config",
	constant: "config",
	consts: "config",
	composables: "lib",
	composable: "lib",
};

// Singular FSD layer names that should be the canonical plural (und-naming-01 trick 7).
const LAYER_SINGULAR_TO_PLURAL: Record<string, string> = {
	feature: "features",
	entity: "entities",
	widget: "widgets",
	page: "views",
	pages: "views",
	view: "views",
};

// Canonical FSD segment names (mig-combined-02, gs-overview-05, und-naming-02).
// `@x` is the cross-entity public-API slot; routes/i18n are project-sanctioned.
const CANONICAL_SEGMENTS_SET = new Set<string>([
	"ui",
	"model",
	"lib",
	"api",
	"config",
	"routes",
	"i18n",
	"@x",
]);

// Segment-name synonyms with their canonical purpose target (und-naming-02,
// mig-combined-02, gs-overview-05). Keyed by lowercased, de-pluralized name.
const SEGMENT_SYNONYM_TO_TARGET: Record<string, string> = {
	...GENERIC_GROUPING_TO_TARGET,
	"ui-kit": "ui",
	uikit: "ui",
	widgets: "ui",
	libs: "lib",
};

// Reserved FSD vocabulary terms — a slice/file named exactly one of these forces
// readers to disambiguate "FSD term vs business concept" (und-naming-04). Advisory.
const RESERVED_FSD_TERMS_SET = new Set<string>([
	"app",
	"process",
	"page",
	"feature",
	"entity",
	"widget",
	"shared",
	"model",
	"view",
	"ui",
	"lib",
	"api",
	"config",
]);

// Sanctioned loose-file extensions allowed directly under src/ (ambient types
// like src/electron.d.ts). Pure declaration files are not a rogue layer.
const ROOT_AMBIENT_FILE_REGEX = /\.d\.ts$/;

/** Lowercase, strip wrapping `_`/`-`, drop a trailing plural `s`. */
function normalizeDirName(name: string): string {
	const lowered = name
		.toLowerCase()
		.replace(/^[._-]+/, "")
		.replace(/[._-]+$/, "");
	// strip a trailing version tag (api-v2 -> api) then a trailing plural s
	const noVersion = lowered.replace(/-v\d+$/, "");
	return noVersion.endsWith("s") && noVersion.length > 1 ? noVersion.slice(0, -1) : noVersion;
}

/**
 * Rule Rref-layers-02 / Rund-naming-01 / Rgs-overview-01 / Rmig-combined-01 /
 * Rskill-09 / Rskill-10 / Rref-layers-04 / Rund-naming-03.
 *
 * Enumerate immediate children of src/. Anything that is not a canonical lowercase
 * FSD layer dir (or a sanctioned root ambient `.d.ts` file) is a non-canonical /
 * ad-hoc / mis-cased layer. Sub-classifies: deprecated processes-synonym layers,
 * generic package-by-layer grouping folders, singular/plural drift, casing drift,
 * `pages` coexisting with `views`, and loose root source files.
 */
async function checkNonCanonicalLayers(): Promise<void> {
	if (!existsSync(srcPath)) {
		return;
	}
	let entries: Dirent[];
	try {
		entries = await readdir(srcPath, { withFileTypes: true, encoding: "utf8" });
	} catch {
		return;
	}

	for (const entry of entries) {
		const name = entry.name;

		if (entry.isFile()) {
			// Root source files are a single-file pseudo-layer unless they are
			// sanctioned ambient declarations (src/electron.d.ts) or dotfiles.
			if (name.startsWith(".") || ROOT_AMBIENT_FILE_REGEX.test(name)) {
				continue;
			}
			if (TS_FILE_REGEX.test(name) || /\.(cjs|mjs|mts|cts)$/.test(name)) {
				violations.nonCanonicalLayers.push({
					file: name,
					message: `Loose source file "src/${name}" sits directly under src/ with no FSD layer (single-file pseudo-layer).`,
					severity: "high",
					suggestion: `Move src/${name} into the correct layer: generic util -> src/shared/lib/<focus>/, UI primitive -> src/shared/ui/<component>/, domain -> src/entities/<noun>/, interaction -> src/features/<action>/, bootstrap -> src/app/. Only ambient *.d.ts may sit at src/ root.`,
				});
			}
			continue;
		}
		if (!entry.isDirectory()) {
			continue;
		}
		if (name.startsWith(".") || name === "node_modules") {
			continue;
		}

		// Exact canonical match -> valid layer, nothing to flag here.
		if (CANONICAL_LAYERS_SET.has(name)) {
			continue;
		}

		// Sanctioned non-layer top-level dirs (Vite multi-page renderer
		// bootstraps in src/entries/). See RENDERER_BOOTSTRAP_ALLOWED_DIRS_SET
		// for the rationale — these are not FSD layers but are required to
		// coexist with the layers at src/ root.
		if (RENDERER_BOOTSTRAP_ALLOWED_DIRS_SET.has(name)) {
			continue;
		}

		const lower = name.toLowerCase();
		const norm = normalizeDirName(name);

		// `src/pages/` alongside `src/views/` — WinSTT uses `views` as the ONLY
		// sanctioned `pages` alias; a real `src/pages/` smuggles the name back.
		if (lower === "pages" || lower === "page") {
			violations.nonCanonicalLayers.push({
				file: `${name}/`,
				message: `Top-level "src/${name}/" reintroduces the FSD pages layer. WinSTT renames pages -> views; "src/views/" is the ONLY sanctioned pages alias.`,
				severity: "high",
				suggestion: `Delete src/${name}/ and move route-level screens into src/views/<route>/ (each with ui/, api/, model/ and a public index.ts). Do not keep src/pages/ alongside src/views/.`,
			});
			continue;
		}

		// Deprecated processes layer + synonyms (flows/workflows/sagas/...).
		if (PROCESSES_SYNONYMS_SET.has(lower) || PROCESSES_SYNONYMS_SET.has(norm)) {
			violations.nonCanonicalLayers.push({
				file: `${name}/`,
				message: `Top-level "src/${name}/" is the deprecated FSD processes layer (or a synonym: flows/workflows/sagas/orchestration). It was removed in FSD v2.1.`,
				severity: "high",
				suggestion: `Delete src/${name}/. Move reusable multi-step user interactions to src/features/<process-name>/; move app-wide orchestration/providers/router wiring to src/app/. Do not rename it to flows/, workflows/, sagas/, or nest it under another layer.`,
			});
			continue;
		}

		// Singular/plural drift of a real layer (src/feature/, src/widget/, src/view/).
		const pluralTarget = LAYER_SINGULAR_TO_PLURAL[lower];
		if (pluralTarget) {
			violations.nonCanonicalLayers.push({
				file: `${name}/`,
				message: `Top-level "src/${name}/" is a singular/aliased FSD layer name; layers must use the canonical plural form.`,
				severity: "high",
				suggestion: `Rename src/${name}/ -> src/${pluralTarget}/ and update every "@/${name}/..." import to "@/${pluralTarget}/...".`,
			});
			continue;
		}

		// Casing drift of a real layer (src/Features/, src/Shared/).
		if (CANONICAL_LAYERS_SET.has(lower)) {
			violations.nonCanonicalLayers.push({
				file: `${name}/`,
				message: `Top-level "src/${name}/" is a case-variant of FSD layer "${lower}". FSD layer folders must be exactly lowercase.`,
				severity: "high",
				suggestion: `Rename src/${name}/ -> src/${lower}/ (exact lowercase) and fix every "@/${name}/..." import. Do not rely on a case-insensitive filesystem.`,
			});
			continue;
		}

		// Generic package-by-layer grouping folder promoted to layer rank
		// (src/components/, src/utils/, src/store/, src/services/, src/core/...).
		const genericTarget = GENERIC_GROUPING_TO_TARGET[lower] ?? GENERIC_GROUPING_TO_TARGET[norm];
		if (genericTarget) {
			violations.nonCanonicalLayers.push({
				file: `${name}/`,
				message: `Top-level "src/${name}/" is a generic technical-role / package-by-layer folder, not an FSD layer (the only layers are app, views, widgets, features, entities, shared).`,
				severity: "high",
				suggestion: `Delete src/${name}/ and group its files by business domain under FSD layers: domain objects -> src/entities/<noun>/, interactions -> src/features/<action>/, composite blocks -> src/widgets/<block>/, generic ${genericTarget} code -> src/shared/${genericTarget}/. A slice index.ts must re-export from its own segments, never from a root generic folder.`,
			});
			continue;
		}

		// Anything else: an unknown / ad-hoc top-level layer (src/modules/, src/domain/).
		violations.nonCanonicalLayers.push({
			file: `${name}/`,
			message: `Top-level "src/${name}/" is not a valid FSD layer. The only allowed top-level folders are app, views, widgets, features, entities, shared (all lowercase).`,
			severity: "high",
			suggestion: `Delete src/${name}/ and relocate its code: domain -> src/entities/<noun>/, user interaction -> src/features/<action>/, composite UI -> src/widgets/<block>/, generic helpers/UI/config -> src/shared/{lib,ui,config}/, app-wide wiring -> src/app/. Do not rename it to a synonym (core/modules/services/common).`,
		});
	}
}

/**
 * Rule Rref-layers-04 / Rund-naming-03 / Rmig-combined-01 — processes layer
 * nested INSIDE another layer (src/app/processes/, src/features/processes/auth/,
 * src/widgets/_process-onboarding/). The top-level case is handled by
 * checkProcessesLayer + checkNonCanonicalLayers; this catches the demotion dodge.
 */
async function checkNestedProcessesDirs(): Promise<void> {
	for (const layer of CANONICAL_LAYERS_SET) {
		const layerDir = join(srcPath, layer);
		if (!existsSync(layerDir)) {
			continue;
		}
		const stack: string[] = [layerDir];
		while (stack.length > 0) {
			const dir = stack.pop();
			if (!dir) {
				continue;
			}
			let entries: Dirent[];
			try {
				entries = await readdir(dir, { withFileTypes: true, encoding: "utf8" });
			} catch {
				continue;
			}
			for (const entry of entries) {
				if (!entry.isDirectory() || entry.name === "node_modules") {
					continue;
				}
				const norm = entry.name
					.toLowerCase()
					.replace(/^[._-]+/, "")
					.replace(/[._-]+$/, "");
				if (
					norm === "processes" ||
					norm === "process" ||
					norm === "flows" ||
					norm === "flow" ||
					norm === "workflows" ||
					norm === "workflow"
				) {
					const rel = relative(srcPath, join(dir, entry.name)).replace(/\\/g, "/");
					violations.processesLayer.push({
						file: `${rel}/`,
						message: `Deprecated FSD processes layer recreated nested at "src/${rel}/" (demotion dodge). The processes layer was removed in FSD v2.1.`,
						severity: "high",
						suggestion: `Delete src/${rel}/. Move cross-page orchestration to src/app/ (providers/router) and reusable user flows to src/features/<flow>/. Nesting it under "${layer}/" or a "_process-*" widget is the same violation.`,
					});
				}
				// Recurse a bounded depth (4 levels below the layer) — enough to
				// catch app/processes/, features/processes/auth/ without scanning
				// every leaf.
				const depth = relative(layerDir, join(dir, entry.name)).split(PATH_SEPARATOR_REGEX).length;
				if (depth <= 4 && !entry.name.startsWith(".")) {
					stack.push(join(dir, entry.name));
				}
			}
		}
	}
}

/**
 * Rule Rgs-overview-06 / Rref-layers-02 — a correctly-named SEGMENT (or loose
 * file) placed directly under a sliced layer with no slice in between
 * (src/features/ui/, src/entities/model/user.ts, src/widgets/Header.tsx,
 * src/features/shared/, src/features/index.ts). Sliced layers require
 * slice-then-segment.
 */
async function checkSegmentAsSlice(): Promise<void> {
	for (const layer of SLICED_LAYERS) {
		const layerDir = join(srcPath, layer);
		if (!existsSync(layerDir)) {
			continue;
		}
		let entries: Dirent[];
		try {
			entries = await readdir(layerDir, { withFileTypes: true, encoding: "utf8" });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const name = entry.name;
			if (name.startsWith(".") || name === "node_modules") {
				continue;
			}

			if (entry.isFile()) {
				// A loose file directly under a sliced layer (no slice). An
				// index.ts at layer root is also illegal (no slice to export).
				if (TS_FILE_REGEX.test(name) || /\.(cjs|mjs|mts|cts)$/.test(name)) {
					violations.segmentAsSlice.push({
						file: `${layer}/${name}`,
						message: `Loose file "src/${layer}/${name}" is directly under sliced layer "${layer}/" with no slice. ${layer}/ requires slice-then-segment.`,
						severity: "high",
						suggestion: `Create a slice first: move it to src/${layer}/<slice-name>/<segment>/${name} (e.g. src/${layer}/<slice>/ui/${name}) and add src/${layer}/<slice>/index.ts. If it is generic, move it to src/shared/ instead. No file (not even index.ts) may sit directly under src/${layer}/.`,
					});
				}
				continue;
			}
			if (!entry.isDirectory()) {
				continue;
			}

			const lower = name.toLowerCase();
			const norm = normalizeDirName(name);

			// A canonical SEGMENT name used where a SLICE must be.
			if (CANONICAL_SEGMENTS_SET.has(lower) || lower === "@x") {
				violations.segmentAsSlice.push({
					file: `${layer}/${name}/`,
					message: `Segment "src/${layer}/${name}/" is placed directly under sliced layer "${layer}/" with no slice. Segments must live INSIDE a slice.`,
					severity: "high",
					suggestion: `Create a domain slice first: move src/${layer}/${name}/ to src/${layer}/<slice-name>/${lower}/ and add src/${layer}/<slice-name>/index.ts. e.g. src/features/ui/Button.tsx -> src/features/<feature>/ui/Button.tsx (or src/shared/ui/button/Button.tsx if generic).`,
				});
				continue;
			}

			// A "slice" named exactly like a segment / catch-all (features/shared/,
			// features/lib/, features/misc/) — ambiguous misplaced segment.
			if (
				SEGMENT_SYNONYM_TO_TARGET[lower] !== undefined ||
				SEGMENT_SYNONYM_TO_TARGET[norm] !== undefined ||
				lower === "shared" ||
				lower === "misc" ||
				lower === "common"
			) {
				violations.segmentAsSlice.push({
					file: `${layer}/${name}/`,
					message: `"src/${layer}/${name}/" is a segment-like / catch-all name used as a slice under "${layer}/". A slice must be a business-domain name, not a technical bucket.`,
					severity: "high",
					suggestion: `Do not use src/${layer}/${name}/ as a dumping ground. Give each unit its own domain slice (src/${layer}/<domain>/) with ui/api/model segments, or move generic code to src/shared/. Delete the catch-all folder.`,
				});
			}
		}
	}
}

/**
 * Rule Rund-naming-02 / Rmig-combined-02 / Rgs-overview-05 / Riss-desegmented-01 /
 * Rskill-07 — non-canonical SEGMENT directory names and slice-internal generic
 * technical-role folders at ANY depth. Covers synonyms beyond the legacy 6-name
 * set (parts, store, state, core, common, typedefs, services, actions, reducers,
 * selectors, endpoints, blocks, composables, ...), casing/plural drift, the
 * `views`-as-segment dodge, forbidden names nested under an allowed segment, and
 * single-file segment smuggling (features/x/store.ts).
 *
 * Honors sanctioned patterns: shared/lib/hooks/, shared/ui/<component>/ tree-
 * shaking folders, app/shared organizational dirs, @x, __tests__.
 */
async function checkNonCanonicalSegments(filePath: string): Promise<void> {
	const relPath = relative(srcPath, filePath).replace(/\\/g, "/");
	const parts = relPath.split("/");
	const layer = parts[0];
	if (!(layer && CANONICAL_LAYERS_SET.has(layer))) {
		return;
	}
	if (isTestFile(filePath)) {
		return;
	}

	const isAppOrShared = layer === "app" || layer === "shared";
	// Segment dir is at parts[1] for app/shared, parts[2] for sliced layers.
	const segmentIdx = isAppOrShared ? 1 : 2;
	const sliceName = isAppOrShared ? null : parts[1];

	// For sliced layers, parts[1] must be a slice (handled by checkSegmentAsSlice);
	// only inspect the segment & below when a slice is actually present.
	if (!isAppOrShared && (parts.length < 3 || !sliceName)) {
		return;
	}

	// parts[segmentIdx] is only a SEGMENT DIRECTORY if there is a filename after
	// it. If it IS the last element it is a file at the slice/layer root (e.g.
	// the public-API index.ts) — not a segment; that case is owned by
	// checkSegmentAsSlice / checkMisplacedSegmentFiles, not this check.
	if (segmentIdx >= parts.length - 1) {
		return;
	}

	const segmentName = parts[segmentIdx];
	if (!segmentName) {
		return;
	}
	const segLower = segmentName.toLowerCase();
	const segNorm = normalizeDirName(segmentName);

	const sliceCtx = isAppOrShared ? `src/${layer}/` : `src/${layer}/${sliceName}/`;

	// 1) The segment-position directory itself.
	const isCanonicalSeg = CANONICAL_SEGMENTS_SET.has(segLower) || segLower === "@x";
	const isAppSharedOrgDir =
		(layer === "app" && APP_LAYER_ALLOWED_DIRS_SET.has(segmentName)) ||
		(layer === "shared" && SHARED_LAYER_ALLOWED_DIRS_SET.has(segmentName));
	if (!(isCanonicalSeg || isAppSharedOrgDir)) {
		const target = SEGMENT_SYNONYM_TO_TARGET[segLower] ?? SEGMENT_SYNONYM_TO_TARGET[segNorm];
		// `views` is the WinSTT pages LAYER but a forbidden UI-synonym SEGMENT.
		const isViewsSegment = segLower === "views" || segLower === "view";
		if (target || isViewsSegment) {
			const tgt = target ?? "ui";
			pushNonCanonicalSegment(
				relPath,
				`Segment directory "${sliceCtx}${segmentName}/" uses non-canonical name "${segmentName}". FSD segments must be exactly ui, model, lib, api, config.`,
				`Rename "${sliceCtx}${segmentName}/" -> "${sliceCtx}${tgt}/", update ${
					isAppOrShared ? `src/${layer}/` : `${sliceCtx}index.ts`
				} exports and every importing path. (display->ui, business logic/state/store->model, helpers->lib, requests->api, flags->config.)`
			);
		} else if (segNorm !== "@x" && !segLower.startsWith("_")) {
			pushNonCanonicalSegment(
				relPath,
				`Segment directory "${sliceCtx}${segmentName}/" is not a canonical FSD segment (ui, model, lib, api, config).`,
				`Rename "${sliceCtx}${segmentName}/" to one of ui/ api/ model/ lib/ config/ by purpose, or — if generic — move it to src/shared/. Custom non-segment folders are only allowed directly under src/app/ and src/shared/.`
			);
		}
	}

	// 2) Any generic technical-role folder nested ANYWHERE between the slice and
	//    the filename (iss-desegmented-01 tricks 1–8: ui/components/, model/store/,
	//    ui/group/sub/components/, api/endpoints/). Skip the segment slot itself
	//    (handled above) and the filename.
	//
	//    SCOPE GUARD (Riss-desegmented-01): "Applies inside views/, widgets/,
	//    features/, entities/ slices and their segments." It explicitly does NOT
	//    apply to the slice-free app/shared layers, whose nested folders are
	//    sanctioned infrastructure (e.g. shared/lib/store/, shared/lib/hooks/,
	//    shared/ui/<component>/, app/providers/<x>/). Running the generic-folder
	//    scan there false-positives the sanctioned shared store/lib trees. The
	//    segment-position check (section 1, with the app/shared org-dir allowlist)
	//    already covers the only structural rule that applies to app/shared.
	if (isAppOrShared) {
		return;
	}
	const scanFrom = segmentIdx + 1;
	for (let i = scanFrom; i < parts.length - 1; i++) {
		const part = parts[i];
		if (!part || part === "@x" || part === "__tests__" || part.startsWith(".")) {
			continue;
		}
		const pLower = part.toLowerCase();
		const pNorm = normalizeDirName(part);
		// Sanctioned: shared/lib/hooks/ (FSD-prescribed reusable-hook location).
		if (layer === "shared" && segLower === "lib" && pLower === "hooks" && i === segmentIdx + 1) {
			continue;
		}
		// Sanctioned: shared/ui/<component>/ tree-shaking folders are NOT segments
		// and are explicitly allowed by frontend/CLAUDE.md §4. Only flag if the
		// nested name is itself an explicit generic denylist entry.
		const genTarget = GENERIC_GROUPING_TO_TARGET[pLower] ?? GENERIC_GROUPING_TO_TARGET[pNorm];
		if (genTarget) {
			const owner = isAppOrShared ? `src/${layer}/${segmentName}/` : `${sliceCtx}${segmentName}/`;
			pushNonCanonicalSegment(
				relPath,
				`Generic technical-role folder "${part}/" nested inside "${owner}" groups code by what-it-is, not by domain.`,
				`Delete the "${part}/" grouping folder: move its files directly into "${owner}" (the ${genTarget} purpose) and split them by business domain (one file = one domain). Never use components/actions/store/types/utils/parts/blocks/endpoints/composables as a folder anywhere inside a slice.`
			);
			break;
		}
	}
}

function pushNonCanonicalSegment(file: string, message: string, suggestion: string): void {
	violations.nonCanonicalSegments.push({
		file,
		message,
		severity: "high",
		suggestion,
	});
}

/**
 * Rule Rund-naming-02 trick 10 / Rmig-combined-08 — a single file whose basename
 * (sans ext) is a state/store/segment synonym sitting directly in a slice ROOT
 * with no segment dir (src/features/x/store.ts, src/features/x/state.ts). A
 * dir-only scanner misses this.
 */
async function checkMisplacedSegmentFiles(filePath: string): Promise<void> {
	if (isTestFile(filePath)) {
		return;
	}
	const relPath = relative(srcPath, filePath).replace(/\\/g, "/");
	const parts = relPath.split("/");
	const layer = parts[0];
	if (!(layer && SLICED_LAYERS_SET.has(layer))) {
		return;
	}
	// Exactly layer/slice/file.ext  -> file is at slice root (no segment dir).
	if (parts.length !== 3) {
		return;
	}
	const sliceName = parts[1];
	const fileName = parts[2];
	if (!(sliceName && fileName) || fileName.startsWith(".")) {
		return;
	}
	const base = fileName.replace(/\.(tsx?|jsx?|cjs|mjs|mts|cts)$/, "").toLowerCase();
	if (base === "index") {
		return;
	}
	const baseNorm = base.endsWith("s") && base.length > 1 ? base.slice(0, -1) : base;
	const synonymTarget = SEGMENT_SYNONYM_TO_TARGET[base] ?? SEGMENT_SYNONYM_TO_TARGET[baseNorm];
	if (synonymTarget) {
		violations.nonCanonicalSegments.push({
			file: relPath,
			message: `File "src/${layer}/${sliceName}/${fileName}" sits at the slice root with a segment/state synonym basename ("${base}") and no segment directory.`,
			severity: "high",
			suggestion: `Move it into the correct segment: src/${layer}/${sliceName}/${synonymTarget}/<domain-name>.ts (e.g. a store/state/reducer -> model/, a request -> api/). Rename it after its business domain, not its technical role.`,
		});
	}
}

/**
 * Rule Riss-desegmented-03 — package-by-layer scatter proxy: the SAME file stem
 * appearing in >=3 distinct generic-named directories anywhere under src/ (e.g.
 * utils/delivery.js + constants/delivery.js + composables/delivery.js). A strong
 * structural signature of a domain scattered across technical folders.
 */
async function checkScatteredDomain(allFiles: readonly string[]): Promise<void> {
	const stemToGenericDirs = new Map<string, Set<string>>();
	for (const f of allFiles) {
		if (isTestFile(f)) {
			continue;
		}
		const rel = relative(srcPath, f).replace(/\\/g, "/");
		const parts = rel.split("/");
		if (parts.length < 2) {
			continue;
		}
		const parentDir = parts[parts.length - 2];
		const fileName = parts[parts.length - 1];
		if (!(parentDir && fileName)) {
			continue;
		}
		const dirNorm = normalizeDirName(parentDir);
		const isGeneric =
			GENERIC_GROUPING_TO_TARGET[parentDir.toLowerCase()] !== undefined ||
			GENERIC_GROUPING_TO_TARGET[dirNorm] !== undefined;
		if (!isGeneric) {
			continue;
		}
		const stem = fileName.replace(/\.(tsx?|jsx?|cjs|mjs|mts|cts|d\.ts)$/, "").toLowerCase();
		if (!stem || stem === "index") {
			continue;
		}
		let set = stemToGenericDirs.get(stem);
		if (!set) {
			set = new Set<string>();
			stemToGenericDirs.set(stem, set);
		}
		set.add(parentDir.toLowerCase());
	}
	for (const [stem, dirs] of stemToGenericDirs) {
		if (dirs.size >= 3) {
			violations.scatteredDomain.push({
				file: `(${[...dirs].sort().join(", ")})/${stem}.*`,
				message: `Domain "${stem}" is scattered across ${dirs.size} generic technical-role folders (${[...dirs].sort().join(", ")}) — package-by-layer / low-cohesion structure.`,
				severity: "medium",
				suggestion: `Collapse the technical grouping into ONE domain slice: move every "${stem}.*" file into src/features/${stem}/ (ui/api/model) or src/entities/${stem}/, then delete the generic folders. All code for one domain belongs in one slice.`,
			});
		}
	}
}

/**
 * Eyeball-derived heuristic (Rskill-05 semantic residual): a file under
 * src/shared/ whose name mirrors an EXISTING features/ or widgets/ slice is a
 * strong signal that feature-specific code was parked in shared/ — which FSD
 * forbids ("shared = no business/feature-specific code"). Deterministic and
 * near-zero-false-positive: generic shared infra (cn, format-bytes, errors) does
 * not collide with kebab slice names; only an exact slice-name match flags.
 * Advisory (low): the pure primitives in such a file may be legit shared infra —
 * the fix is to split the feature-bound export out, not necessarily move the file.
 */
async function checkSharedNameMirrorsSlice(allFiles: readonly string[]): Promise<void> {
	const SEGMENT_DIRS = new Set(["ui", "api", "model", "lib", "config", "@x", "hooks"]);
	const sliceNames = new Map<string, string>(); // sliceName -> "layer/slice"
	for (const f of allFiles) {
		const rel = relative(srcPath, f).replace(/\\/g, "/");
		const parts = rel.split("/");
		if ((parts[0] === "features" || parts[0] === "widgets") && parts[1]) {
			sliceNames.set(parts[1].toLowerCase(), `${parts[0]}/${parts[1]}`);
		}
	}
	const seen = new Set<string>();
	for (const f of allFiles) {
		if (isTestFile(f)) {
			continue;
		}
		const rel = relative(srcPath, f).replace(/\\/g, "/");
		const parts = rel.split("/");
		if (parts[0] !== "shared") {
			continue;
		}
		const fileName = parts[parts.length - 1] ?? "";
		const stem = fileName
			.replace(/\.(tsx?|jsx?|cjs|mjs|mts|cts)$/, "")
			.replace(/\.d$/, "")
			.replace(/^use-/, "")
			.toLowerCase();
		// Candidate names: the file stem and any non-segment folder under shared/.
		const candidates: string[] = [];
		if (stem && stem !== "index") {
			candidates.push(stem);
		}
		for (let i = 1; i < parts.length - 1; i++) {
			const dir = (parts[i] ?? "").toLowerCase();
			if (dir && !SEGMENT_DIRS.has(dir)) {
				candidates.push(dir);
			}
		}
		for (const cand of candidates) {
			const owner = sliceNames.get(cand);
			if (!owner || seen.has(rel)) {
				continue;
			}
			seen.add(rel);
			violations.sharedNameMirrorsSlice.push({
				file: rel,
				message: `shared/ module "${rel}" mirrors the existing slice "${owner}". A shared file named after a feature/widget slice almost always contains feature-specific code, which FSD forbids in shared/ (shared = generic infrastructure only).`,
				severity: "low",
				suggestion: `Audit "${rel}": move every feature-bound export (hooks/components/logic that only "${owner}" needs, especially anything wired by app/providers) into src/${owner}/ (model/ for stateful/domain hooks, lib/ for helpers, ui/ for components) and re-export it from src/${owner}/index.ts. Keep ONLY genuinely cross-slice primitives in src/shared/ — and verify ≥2 unrelated slices actually import them; if only "${owner}" does, move the whole file into the slice.`,
			});
		}
	}
}

/**
 * Rule Rund-naming-04 — slice/file names colliding with reserved FSD vocabulary
 * (page, model, entity, feature, widget, model.ts, ui.tsx, api.ts). Advisory
 * (low) per the ledger's partial-detectability note: the name is a proxy, intent
 * needs human judgement.
 */
async function checkReservedTermNaming(): Promise<void> {
	for (const layer of SLICED_LAYERS) {
		const layerDir = join(srcPath, layer);
		if (!existsSync(layerDir)) {
			continue;
		}
		let entries: Dirent[];
		try {
			entries = await readdir(layerDir, { withFileTypes: true, encoding: "utf8" });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (!entry.isDirectory() || entry.name.startsWith(".")) {
				continue;
			}
			const sliceNorm = normalizeDirName(entry.name);
			if (RESERVED_FSD_TERMS_SET.has(sliceNorm)) {
				violations.reservedTermNaming.push({
					file: `${layer}/${entry.name}/`,
					message: `Slice "src/${layer}/${entry.name}/" collides with the reserved FSD term "${sliceNorm}" (forces FSD-term-vs-business disambiguation).`,
					severity: "low",
					suggestion: `Rename to the concrete business noun, e.g. a car-model entity -> src/entities/car-model/ with model/car-model.ts; a log "page" feature -> src/features/log-page/. Never name a slice exactly app/process/page/feature/entity/widget/shared/model/view.`,
				});
				continue;
			}
			// A domain file whose basename equals its parent segment or a reserved
			// term (entities/song/model/model.ts, ui/ui.tsx).
			await scanReservedTermFiles(join(layerDir, entry.name), layer, entry.name);
		}
	}
}

async function scanReservedTermFiles(
	sliceDir: string,
	layer: string,
	slice: string
): Promise<void> {
	let segEntries: Dirent[];
	try {
		segEntries = await readdir(sliceDir, { withFileTypes: true, encoding: "utf8" });
	} catch {
		return;
	}
	for (const seg of segEntries) {
		if (!seg.isDirectory() || seg.name.startsWith(".") || seg.name === "@x") {
			continue;
		}
		const segLower = seg.name.toLowerCase();
		let files: Dirent[];
		try {
			files = await readdir(join(sliceDir, seg.name), {
				withFileTypes: true,
				encoding: "utf8",
			});
		} catch {
			continue;
		}
		for (const f of files) {
			if (!f.isFile() || isTestFile(f.name)) {
				continue;
			}
			const base = f.name.replace(/\.(tsx?|jsx?)$/, "").toLowerCase();
			if (base === "index") {
				continue;
			}
			if (base === segLower || RESERVED_FSD_TERMS_SET.has(base)) {
				violations.reservedTermNaming.push({
					file: `${layer}/${slice}/${seg.name}/${f.name}`,
					message: `File "src/${layer}/${slice}/${seg.name}/${f.name}" is named after its segment / a reserved FSD term ("${base}") instead of its business domain.`,
					severity: "low",
					suggestion: `Rename to the concrete domain noun: src/${layer}/${slice}/${seg.name}/<noun>.ts (e.g. model/model.ts -> model/${slice}.ts). One file = one domain.`,
				});
			}
		}
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
					suggestion: `Split src/${layer}/${entry.name}/ (${fileCount} files) into separate top-level slices on the ${layer}/ layer, ONE per business concern (e.g. src/${layer}/<concern-a>/ and src/${layer}/<concern-b>/), each with its own ui/ api/ model/ and index.ts; then delete the over-broad slice. Do NOT hide the split inside ${entry.name}/partA/ partB/ subfolders or dump overflow into src/shared/lib/ (shared holds no domain logic). Re-extract a single slice only for one cohesive goal.`,
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

	// ─── Heuristic 3: Domain-specific Zustand stores in shared/lib/store/ ───
	// Stores that manage domain-specific state (not generic UI state) should
	// live in entities/ or features/. Generic UI state stores are OK in shared/.
	// Generic UI state stores that are OK in shared/ (conservative allowlist).
	const ALLOWED_SHARED_STORES = new Set<string>([
		"theme-store.ts",
		"locale-store.ts",
		"sidebar-store.ts",
		"disclosure-store.ts",
	]);

	const storeDir = join(sharedLibDir, "store");
	if (existsSync(storeDir)) {
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

	// ─── Heuristic 4 (Batch C / Rskill-05): neutral-named-file smuggling ───
	// The reward-hacking dodge: drop a domain/auth STATE STORE into a blandly
	// named shared/lib file (state.ts, utils.ts, app-store.ts, helpers.ts) or
	// any non-store/ shared/lib file to dodge the store/-scoped scan above.
	// Precision: only flag a shared/lib file that BOTH (a) builds a state-store
	// factory (create()/createStore()/configureStore()/createContext()) or a
	// module-level mutable token, AND (b) carries auth/token symbols OR imports
	// an entity/feature slice. Generic UI primitives stay clean (no store +
	// no auth symbols). WinSTT has zero such files → no baseline regression.
	const scanned = await scanDirectory(sharedLibDir);
	for (const filePath of scanned) {
		if (isTestFile(filePath)) {
			continue;
		}
		const rel = relative(srcPath, filePath).replace(/\\/g, "/");
		// store/ files already handled by Heuristic 3 (allowlist-aware).
		if (rel.startsWith("shared/lib/store/")) {
			continue;
		}
		const base = require("node:path").basename(filePath);
		if (ALLOWED_SHARED_STORES.has(base) || base === "index.ts") {
			continue;
		}
		const raw = readFileSafe(filePath);
		if (!raw || isPureReexportFile(raw)) {
			continue;
		}
		const code = stripCommentsAndStrings(raw);
		const buildsStore =
			/\bcreate\s*(?:<[^>]*>)?\s*\(\s*(?:\(|function)/.test(code) ||
			/\bcreateStore\s*\(|\bconfigureStore\s*\(/.test(code) ||
			/\bexport\s+(?:let|var)\s+\w*(?:[Tt]oken|[Aa]uth|[Ss]ession)\w*\s*=/.test(code);
		const authy = AUTH_SYMBOL_REGEX.test(code);
		const importsDomain =
			/from\s+['"]@\/(?:entities|features)\//.test(raw) ||
			/import\s*\(\s*['"]@\/(?:entities|features)\//.test(raw);
		if (importsDomain) {
			violations.businessLogicInShared.push({
				file: rel,
				message: `Business logic in shared/: "${rel}" imports a domain slice (@/entities or @/features). shared/ must depend on nothing and hold no domain code.`,
				severity: "medium",
				suggestion: `Move this code into the owning slice — src/entities/<entity>/lib|model/ for a domain rule, or src/features/<feature>/model/ for a user interaction. Keep in shared/ only generic, domain-agnostic helpers. Renaming to helpers.ts/utils.ts/state.ts does not make it generic.`,
			});
			continue;
		}
		if (buildsStore && authy) {
			violations.businessLogicInShared.push({
				file: rel,
				message: `Smuggled auth/domain store in a neutral-named shared/lib file: "${rel}" builds a state store / mutable token carrying auth symbols, dodging the shared/lib/store/ scan.`,
				severity: "medium",
				suggestion: `Move the auth/token store to src/shared/auth/ (token store + refresh) or src/entities/user/model/auth-store.ts. shared/lib is infrastructure-only; a store with token/session state is not generic UI state. Renaming the file to state.ts/app-store.ts/utils.ts does not make it generic.`,
			});
		}
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
			message: `Circular slice dependency (cycle: ${pretty}) — these slices import each other and are locked together (FSD Riss-cross-imports-03).`,
			severity: "critical",
			suggestion: `Break the cycle ${pretty}: (1) extract the symbols both directions need into a lower layer — shared domain logic → src/entities/<domain>/model/, generic utilities → src/shared/lib/<focus>/; (2) make EVERY slice in the ring import that single lower-layer module instead of each other; (3) or compose the slices from a higher layer (src/views/<page>/ or src/app/) and delete the inter-slice imports. An @x re-export, a shared/ barrel, a dynamic import(), import type, or a *.test.ts still counts as an edge — it does NOT break the cycle.`,
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

		// Batch C / Riss-excessive-entities-01 + Rskill-11 hardening:
		// de-launder one barrel hop. A "bridge" file is one that re-exports the
		// target slice (shared/* or sibling-entity index/barrel); a consumer
		// importing such a bridge is really a consumer of the target slice.
		const buildBridgeImporters = (prefix: string): Set<string> => {
			const bridges = new Set<string>();
			const reexportRe = new RegExp(`(?:export|import)[^\\n]*from\\s+['"]@/${prefix}(?:[/'"])`);
			for (const fp of allFiles) {
				if (isTestFile(fp)) {
					continue;
				}
				const relp = relative(srcPath, fp).replace(/\\/g, "/");
				// only barrels/bridges in shared/** or another slice's index/@x
				const isBridgeHost =
					relp.startsWith("shared/") ||
					/^(?:entities|features|widgets|views)\/[^/]+\/(?:index\.ts|@x\/)/.test(relp);
				if (!isBridgeHost) {
					continue;
				}
				const c = readFileSafe(fp);
				if (c && reexportRe.test(c) && isPureReexportFile(c)) {
					// expose this bridge module path (alias form) so consumers of
					// it are attributed to the target slice.
					const aliasNoExt = relp.replace(/\.tsx?$/, "").replace(/\/index$/, "");
					bridges.add(aliasNoExt);
				}
			}
			return bridges;
		};

		for (const sliceName of sliceNames) {
			const sliceImportPrefix = `${targetLayer}/${sliceName}`;

			const sliceDir = join(layerDir, sliceName);
			let sliceFiles: string[];
			try {
				sliceFiles = await scanDirectory(sliceDir);
			} catch {
				continue;
			}
			const sourceFiles = sliceFiles.filter(
				(f) => !isTestFile(f) && !isPureReexportFile(readFileSafe(f))
			);
			const isSmall = sourceFiles.length <= INSIGNIFICANT_MAX_FILES;

			const bridges = buildBridgeImporters(sliceImportPrefix);
			// Direct alias + deep-relative + dynamic-import + de-laundered-bridge
			// matchers for this slice.
			const directRe = new RegExp(`from\\s+['"]@/${sliceImportPrefix}(?:[/'"])`);
			const dynRe = new RegExp(`import\\(\\s*['"]@/${sliceImportPrefix}(?:[/'"])`);
			const relRe = new RegExp(`from\\s+['"](?:\\.\\./)+${targetLayer}/${sliceName}(?:[/'"])`);
			const bridgeRes = Array.from(bridges).map(
				(b) => new RegExp(`from\\s+['"]@/${b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:['"]|/)`)
			);

			// Track which page slices import this slice (directly or via bridge)
			const importingPageSlices = new Set<string>();
			let usedByNonPageHigherLayer = false;

			for (const filePath of allFiles) {
				const fileLayer = getLayerFromPath(filePath);
				if (!fileLayer) {
					continue;
				}
				const fileLayerIndex = LAYERS.indexOf(fileLayer);
				const targetLayerIndex = LAYERS.indexOf(targetLayer);
				if (fileLayerIndex >= targetLayerIndex) {
					continue;
				}
				if (isTestFile(filePath)) {
					continue;
				}
				// Do not count a re-export-only bridge itself as a real consumer.
				const content = readFileSafe(filePath);
				if (!content) {
					continue;
				}
				const matches =
					directRe.test(content) ||
					dynRe.test(content) ||
					relRe.test(content) ||
					bridgeRes.some((r) => r.test(content));
				if (!matches) {
					continue;
				}
				if (isPureReexportFile(content)) {
					continue; // laundering bridge, not a real consumer
				}

				if (fileLayer === "views") {
					const pageSlice = getSliceFromPath(filePath, fileLayer);
					if (pageSlice) {
						importingPageSlices.add(pageSlice);
					}
				} else {
					usedByNonPageHigherLayer = true;
					break;
				}
			}

			// Flag if exactly 1 page uses this slice and no widget/feature/app
			// consumer exists. Severity stays low; the >5-file slice is reported
			// as advisory rather than fully exempted (Riss-01: size only excuses
			// the LOW downgrade, not the flag) — but only when the lone consumer
			// is a single view, to keep the clean repo at baseline (single
			// widget/feature consumers are an accepted residual, see _RESIDUALS).
			if (!usedByNonPageHigherLayer && importingPageSlices.size === 1) {
				const onlyPage = Array.from(importingPageSlices)[0];
				const sizeNote = isSmall
					? `has only ${sourceFiles.length} source file(s)`
					: `(${sourceFiles.length} source files — large, but still single-consumer)`;
				violations.insignificantSlices.push({
					file: sliceImportPrefix,
					message: `Insignificant / prematurely-extracted slice: "${sliceImportPrefix}" is only consumed by views/${onlyPage} (including any laundered barrel/dynamic/relative import) and ${sizeNote}. FSD v2.1 "Pages First": single-consumer slices belong inside their consumer.`,
					severity: "low",
					suggestion: `Inline ${sliceImportPrefix}/ back into its single consumer: move ui/ → views/${onlyPage}/ui/, model/ → views/${onlyPage}/model/, api/ → views/${onlyPage}/api/, then delete the slice and its index.ts. Only re-extract once a SECOND independent view/widget genuinely needs it. Adding a decoy importer, a test-only import, or a re-export bridge to fake a second consumer does not justify the slice.`,
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
				message: `Excessive slicing: src/${layer}/ contains ${sliceCount} slices (threshold: ${threshold}) — over-decomposition / "a slice for everything" (FSD ${layer === "entities" ? "Riss-excessive-entities-06" : "Rref-slices cohesion"}).`,
				severity: "medium",
				suggestion: `Reduce src/${layer}/ slice count by: (1) inlining single-consumer slices into their one consumer's model/ (delete the slice + index.ts); (2) merging tightly-coupled sibling slices into one cohesive slice${layer === "entities" ? " (e.g. src/entities/<context>-info/)" : ""}; (3) deleting slices that only hold CRUD or backend DTOs — move those to src/shared/api/ (endpoints + models.ts). Do NOT mask the count by nesting slices under a group folder, _-prefixing live slices, merging everything into one god-slice, or relocating slices outside src/${layer}/.`,
			});
		}
	}
}

// ===========================================================================
// Batch C — Entities/Feature semantics & Shared-layer purity
// Implements: iss-excessive-entities (01–06), und-needs-driven (01–03),
// ex-types (01,02,04,05,06), ex-api-requests (01–06), ex-auth (01–06),
// ex-page-layout (sanctioned-pattern guards), gs-faq (advisory),
// skill (Rskill-05 shared-business, Rskill-11 premature, Rskill-12 god-slice).
//
// PRECISION NOTE: the real WinSTT src/ is FSD-clean (baseline Total=1). WinSTT
// is an IPC/WebSocket app — it has NO HTTP client and entity model files
// legitimately carry snake_case server-payload types that are mapped in-place
// (sanctioned mapper pattern) AND import from @/shared/api or @spec. Every
// heuristic below is tuned to NOT regress that baseline: snake_case alone is
// not flagged, generated code under src/shared/api is sanctioned, and ambient
// .d.ts under shared/** is sanctioned (project's real ambient-type home).
// ===========================================================================

// Helpers shared across Batch C detectors --------------------------------------

/** Strip line/block comments and string literals so token scans don't false-hit. */
function stripCommentsAndStrings(src: string): string {
	return src
		.replace(/\/\*[\s\S]*?\*\//g, " ")
		.replace(/\/\/[^\n]*/g, " ")
		.replace(/`(?:\\.|[^`\\])*`/g, '""')
		.replace(/'(?:\\.|[^'\\])*'/g, '""')
		.replace(/"(?:\\.|[^"\\])*"/g, '""');
}

/** Read a file synchronously; returns "" on failure. */
function readFileSafe(filePath: string): string {
	try {
		return require("node:fs").readFileSync(filePath, "utf-8") as string;
	} catch {
		return "";
	}
}

/** "<layer>/<slice>" path-relative parts for a file, or null if outside a slice. */
function sliceParts(
	filePath: string
): { layer: Layer; slice: string; segment: string | null } | null {
	const rel = relative(srcPath, filePath).split(PATH_SEPARATOR_REGEX);
	const layer = rel[0] as Layer;
	if (!LAYERS_SET.has(layer) || layer === "app" || layer === "shared") {
		return null;
	}
	const slice = rel[1];
	if (!slice) {
		return null;
	}
	const segment = rel[2] && ALLOWED_SEGMENTS_SET.has(rel[2]) ? rel[2] : null;
	return { layer, slice, segment };
}

/** True when a file is purely a re-export barrel (only `export … from` / blank). */
function isPureReexportFile(content: string): boolean {
	const code = stripCommentsAndStrings(content);
	const meaningful = code
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l.length > 0);
	if (meaningful.length === 0) {
		return true;
	}
	return meaningful.every(
		(l) =>
			l.startsWith("export") &&
			(l.includes(" from ") || l === "export {};" || /^export\s+type\s/.test(l))
	);
}

// HTTP / request primitive regexes (token-level, comment/string-stripped) -------
const HTTP_CLIENT_FACTORY_REGEX =
	/\baxios\s*\.\s*create\s*\(|\bnew\s+ApiClient\s*\(|\bcreateClient\s*</;
const HTTP_VERB_CALL_REGEX =
	/\b(?:fetch|axios)\s*\(|\baxios\s*\.\s*(?:get|post|put|delete|patch)\s*\(|\b(?:GET|POST|PUT|DELETE|PATCH)\s*\(\s*""|\.\s*(?:get|post|put|delete|patch)\s*\(\s*""/;
const QUERY_FN_REGEX = /\b(?:queryFn|mutationFn)\s*:/;
const AUTH_SYMBOL_REGEX =
	/\b(?:accessToken|refreshToken|authToken|sessionToken|access_token|refresh_token)\b|\buse(?:Auth|Session|CurrentUser)\s*\(|\bsetToken\s*\(|\bclearTokens?\s*\(/;
const AUTH_ENTITY_NAME_REGEX =
	/^(?:user|users|auth|authentication|session|sessions|current-?user|account|accounts|credential|credentials|token|tokens|login|signin|sign-in)$/i;
// Strong, unambiguous auth-only slice names (excludes user/account which are
// legitimately domain nouns — those are symbol-flagged, not name-flagged).
const STRONG_AUTH_ENTITY_NAME_REGEX =
	/^(?:auth|authentication|session|sessions|credential|credentials|token|tokens|login|signin|sign-in|current-?user)$/i;
void AUTH_ENTITY_NAME_REGEX;
const STORE_FACTORY_REGEX =
	/\bcreate\s*(?:<[^>]*>)?\s*\(|\bcreateStore\s*\(|\bconfigureStore\s*\(|\bcreateContext\s*\(/;
const DTO_FILE_BASENAME_REGEX = /^(?:dto|dtos|mapper|mappers|adapter|adapters)$/i;
const DTO_EXPORT_REGEX =
	/\b(?:interface|type)\s+\w*(?:DTO|Dto)\b|\bfunction\s+adapt\w*(?:DTO|Dto)\b|\bconst\s+adapt\w*(?:DTO|Dto)\b/;
// STRONG generator-banner signal only. A loose "auto-generated" substring
// false-positives on hand-written files that merely *reference* generated
// tables in a doc comment, so we require an explicit codegen tool banner.
const GENERATED_BANNER_REGEX =
	/Generated by orval\b|\bopenapi-typescript\b|@generated\b|This file (?:was|is) auto-?generated by\b|Do not make direct changes to the file/i;

// Generic / technical feature-slice name blocklist (Rund-needs-driven-02).
const GENERIC_SLICE_TOKENS = new Set<string>([
	"header",
	"footer",
	"sidebar",
	"panel",
	"modal",
	"dialog",
	"layout",
	"wrapper",
	"container",
	"manager",
	"handler",
	"handlers",
	"service",
	"controller",
	"util",
	"utils",
	"helper",
	"helpers",
	"common",
	"core",
	"misc",
	"shared",
	"general",
	"main",
	"base",
	"default",
	"data",
	"app",
	"page",
	"screen",
	"area",
	"section",
	"feature",
	"new",
	"temp",
	"tmp",
	"stuff",
	"thing",
]);
const GENERIC_SLICE_NAME_REGEX =
	/^(?:feature|new|temp|tmp|main)[-_]?\w*$|-(?:feature|screen|area|page)$/;

/**
 * Rule Riss-excessive-entities-02 + Rex-api-requests-05(b):
 * CRUD / raw HTTP calls inside entities/** (any segment incl. @x, lib).
 * A file is flagged when it contains an HTTP request primitive AND is NOT
 * also a meaningful transformation (we treat presence of an adjacent/own
 * mapper as the false-positive guard per the ledger). WinSTT has no HTTP
 * client, so this will not regress the clean repo.
 */
async function checkCrudInEntities(allFiles: readonly string[]): Promise<void> {
	const entitiesRoot = join(srcPath, "entities");
	if (!existsSync(entitiesRoot)) {
		return;
	}
	for (const filePath of allFiles) {
		const rel = relative(srcPath, filePath).replace(/\\/g, "/");
		if (!rel.startsWith("entities/") || isTestFile(filePath)) {
			continue;
		}
		const raw = readFileSafe(filePath);
		if (!raw || isPureReexportFile(raw)) {
			continue;
		}
		const code = stripCommentsAndStrings(raw);
		const hasHttp =
			HTTP_VERB_CALL_REGEX.test(code) ||
			HTTP_CLIENT_FACTORY_REGEX.test(code) ||
			(QUERY_FN_REGEX.test(code) && /\b(?:fetch|axios|client)\b/.test(code));
		if (!hasHttp) {
			continue;
		}
		// False-positive guard: an entity that owns api/ WITH a sibling mapper is
		// sanctioned per CLAUDE.md. Only downgrade — still surface as advisory.
		const parts = sliceParts(filePath);
		const dir = filePath.slice(0, filePath.lastIndexOf(require("node:path").sep));
		let dirFiles: string[] = [];
		try {
			dirFiles = require("node:fs").readdirSync(dir) as string[];
		} catch {
			dirFiles = [];
		}
		const hasSiblingMapper = dirFiles.some(
			(f) =>
				/(?:mapper|adapt)/i.test(f) &&
				TS_FILE_REGEX.test(f) &&
				f !== require("node:path").basename(filePath)
		);
		const inApiSegment = parts?.segment === "api";
		// FALSE-POSITIVE GUARD (CLAUDE.md + Riss-02 ledger): an entity that owns
		// its API with a request in api/ AND a sibling mapper is the explicitly
		// sanctioned "entity owns api/" pattern — do NOT emit anything.
		if (inApiSegment && hasSiblingMapper) {
			continue;
		}
		violations.crudInEntities.push({
			file: rel,
			message: `CRUD/data-access code in entities/: "${rel}" contains an HTTP request (fetch/axios/openapi-client/ApiClient) without an adjacent mapper. FSD forbids CRUD boilerplate in entities/.`,
			severity: "medium",
			suggestion: `Move the request to src/shared/api/endpoints/<resource>.ts (export via src/shared/api/index.ts); keep DTO/response types in src/shared/api/models.ts. In ${parts ? `entities/${parts.slice}/model/` : "the entity model/"} import the moved function from "@/shared/api" and apply only domain transformations. If the entity legitimately owns its API per CLAUDE.md, keep the request in entities/<slice>/api/ WITH a sibling mapper.ts that returns the frontend-shaped model. Do NOT keep the implementation under entities/ while re-exporting from shared/api, and do NOT relocate it into entities/<slice>/lib/ or @x/ to dodge an api-only scan.`,
		});
	}
}

/**
 * Rule Riss-excessive-entities-03 / Rex-auth-05: authentication artifacts
 * (tokens / session / auth hooks) inside an entity slice.
 */
async function checkAuthInEntities(allFiles: readonly string[]): Promise<void> {
	const entitiesRoot = join(srcPath, "entities");
	if (!existsSync(entitiesRoot)) {
		return;
	}
	const flaggedSlices = new Set<string>();
	for (const filePath of allFiles) {
		const rel = relative(srcPath, filePath).replace(/\\/g, "/");
		if (!rel.startsWith("entities/") || isTestFile(filePath)) {
			continue;
		}
		const parts = sliceParts(filePath);
		if (!parts) {
			continue;
		}
		const raw = readFileSafe(filePath);
		if (!raw) {
			continue;
		}
		const code = stripCommentsAndStrings(raw);
		const hasAuthSymbols = AUTH_SYMBOL_REGEX.test(code);
		const localStorageToken =
			/localStorage\s*\.\s*(?:get|set|remove)Item\s*\(\s*""/.test(code) &&
			/token|auth|session|jwt/i.test(raw);
		if (hasAuthSymbols || localStorageToken) {
			violations.authInEntities.push({
				file: rel,
				message: `Authentication data in entities/: "${rel}" contains auth/token/session symbols. FSD stores auth data in shared/ (shared/auth or shared/api), never a user/auth entity.`,
				severity: "medium",
				suggestion: `Move auth state and the auth hook to src/shared/auth/ (create src/shared/auth/use-auth.ts + src/shared/auth/index.ts); put the auth-response/token DTO in src/shared/api/models.ts. Delete the auth concerns from entities/${parts.slice}/. Do NOT split auth across multiple small entities, park the token in an @x/ file, or re-export shared/auth through an entity index.ts.`,
			});
			flaggedSlices.add(parts.slice);
		}
	}
	// Auth-named entity slices: only STRONG auth-only names trigger the
	// name-based advisory. `user`/`account` are legitimately-ambiguous domain
	// nouns (the Riss-03 ledger says intent for a generic `user` entity cannot
	// be determined → those must NOT be name-flagged, only symbol-flagged).
	try {
		const entries = require("node:fs").readdirSync(entitiesRoot, {
			withFileTypes: true,
		}) as Dirent[];
		for (const entry of entries) {
			if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name.startsWith("_")) {
				continue;
			}
			if (STRONG_AUTH_ENTITY_NAME_REGEX.test(entry.name) && !flaggedSlices.has(entry.name)) {
				violations.authInEntities.push({
					file: `entities/${entry.name}`,
					message: `Advisory: entity slice "entities/${entry.name}" has a strongly auth-specific name. FSD stores authentication data in shared/ (shared/auth or shared/api), not an auth entity.`,
					severity: "low",
					suggestion: `If this slice holds tokens/session/current-user, move that to src/shared/auth/ or src/shared/api/. A real non-auth domain object should not be named auth/session/token/credentials/login.`,
				});
			}
		}
	} catch {
		// ignore
	}
}

/**
 * Rule Riss-excessive-entities-05 / Rex-api-requests-05(a): an entity that
 * defines its own backend DTO/data shape locally with NO @/shared/api (or
 * @spec) import. WinSTT entity stores legitimately import @/shared/api or
 * @spec, so the clean repo is not regressed.
 */
async function checkLocalDtoInEntities(allFiles: readonly string[]): Promise<void> {
	if (!existsSync(join(srcPath, "entities"))) {
		return;
	}
	for (const filePath of allFiles) {
		const rel = relative(srcPath, filePath).replace(/\\/g, "/");
		if (!rel.startsWith("entities/") || isTestFile(filePath)) {
			continue;
		}
		const raw = readFileSafe(filePath);
		if (!raw || isPureReexportFile(raw)) {
			continue;
		}
		// Does this file (or its slice) source backend types from shared/api/@spec?
		const importsSharedApi =
			/from\s+['"]@\/shared\/api(?:['"/]|['"])/.test(raw) ||
			/from\s+['"]@spec\//.test(raw) ||
			/import\s*\(\s*['"]@\/shared\/api/.test(raw);
		if (importsSharedApi) {
			continue; // sanctioned: type sourced from shared/api / generated spec
		}
		// FALSE-POSITIVE GUARD: a DTO declared in the entity's api/ segment with
		// a sibling mapper is the CLAUDE.md-sanctioned entity-owns-api pattern
		// (Rex-types-04 places dto.ts + mapper.ts together in api/). Riss-05
		// targets a raw backend shape leaking as the entity MODEL, not a
		// properly-colocated api/dto.ts.
		const dParts = sliceParts(filePath);
		if (dParts?.segment === "api") {
			const apiDir = filePath.slice(0, filePath.lastIndexOf(require("node:path").sep));
			let sib: string[] = [];
			try {
				sib = require("node:fs").readdirSync(apiDir) as string[];
			} catch {
				sib = [];
			}
			if (
				sib.some(
					(f) =>
						/(?:mapper|adapt)/i.test(f) &&
						TS_FILE_REGEX.test(f) &&
						f !== require("node:path").basename(filePath)
				)
			) {
				continue;
			}
		}
		const code = stripCommentsAndStrings(raw);
		// Heuristic: a DTO-shaped declaration (interface/type/z.object) with >=2 of
		// snake_case keys / id-ish field / timestamp / DTO-Response-Schema suffix.
		const decl = /\b(?:interface|type)\s+\w+/.test(code) || /z\s*\.\s*object\s*\(/.test(code);
		if (!decl) {
			continue;
		}
		const snake =
			/\n\s*[a-z][a-z0-9]*_[a-z0-9_]+\s*[?:]/.test(code) ||
			/\b[a-z][a-z0-9]*_[a-z0-9_]+\s*:/.test(code);
		const idField = /\b(?:_?id|uuid)\s*[?:]/.test(code);
		const ts = /\b(?:created_at|updated_at|createdAt|updatedAt)\b/.test(code);
		const suffix = /\b(?:interface|type)\s+\w+(?:DTO|Dto|Response|Schema|Entity)\b/.test(code);
		const score = [snake, idField, ts, suffix].filter(Boolean).length;
		if (score < 2) {
			continue;
		}
		const parts = sliceParts(filePath);
		violations.localDtoInEntities.push({
			file: rel,
			message: `Entity defines a backend data/DTO shape locally without sourcing it from shared/api: "${rel}" declares a DTO-shaped type (snake_case/id/timestamp/DTO-suffix) and the file does not import from @/shared/api or @spec.`,
			severity: "medium",
			suggestion: `Move the shape to src/shared/api/models.ts as \`export type <Name> = components["schemas"]["<Name>"]\` (or a hand-written DTO under src/shared/api/). In entities/${parts?.slice ?? "<slice>"}/model/ do \`import type { <Name> } from "@/shared/api"\` and keep ONLY derived/domain logic. Do NOT duplicate the OpenAPI body, re-declare it as a z.object schema in the entity, or hide it in an @x/ file.`,
		});
	}
}

/**
 * Rule Rex-types-04: DTO / mapper files placed OUTSIDE an api/ segment.
 */
async function checkMisplacedDtoMapper(allFiles: readonly string[]): Promise<void> {
	for (const filePath of allFiles) {
		if (isTestFile(filePath)) {
			continue;
		}
		const parts = sliceParts(filePath);
		if (!parts) {
			continue;
		}
		const rel = relative(srcPath, filePath).replace(/\\/g, "/");
		const base = require("node:path")
			.basename(filePath)
			.replace(/\.(tsx?|jsx?|d\.ts)$/, "");
		const raw = readFileSafe(filePath);
		const code = stripCommentsAndStrings(raw);
		const nameIsDto = DTO_FILE_BASENAME_REGEX.test(base);
		const exportsDto = DTO_EXPORT_REGEX.test(code);
		if (!(nameIsDto || exportsDto)) {
			continue;
		}
		if (parts.segment === "api") {
			continue; // correct home
		}
		violations.misplacedDtoMapper.push({
			file: rel,
			message: `DTO/mapper outside api/ segment: "${rel}" defines a DTO or adapt*DTO mapper but sits in "${parts.segment ?? "(slice root)"}", not the slice's api/ segment.`,
			severity: "medium",
			suggestion: `Move the DTO interface and its adapt<X>DTO mapper into the api/ segment beside the request: src/${parts.layer}/${parts.slice}/api/dto.ts (DTO) and src/${parts.layer}/${parts.slice}/api/mapper.ts (mapper), or src/shared/api/<x>.ts if requests live in shared. Keep DTO and mapper together; do not place them in model/, lib/, ui/, or any types/ folder.`,
		});
	}
}

/**
 * Rule Rex-types-01/02/05/06: types-synonym segments, technical-role file
 * names, prop-interface files outside ui/, and `declare module` in slices.
 * NOTE the project's real ambient-type home is shared/** (electron-api.d.ts,
 * i18n/global.d.ts) — those are sanctioned and NOT flagged.
 */
const TYPES_SEGMENT_SYNONYMS = new Set<string>([
	"types",
	"typedefs",
	"type-defs",
	"typings",
	"type",
	"interfaces",
	"dto-types",
	"tipos",
]);
const TYPE_ROLE_FILE_BASENAMES = new Set<string>([
	"types",
	"interfaces",
	"typedefs",
	"typings",
	"defs",
	"t",
]);

async function checkMisplacedTypes(allFiles: readonly string[]): Promise<void> {
	for (const filePath of allFiles) {
		if (isTestFile(filePath)) {
			continue;
		}
		const rel = relative(srcPath, filePath).replace(/\\/g, "/");
		const segs = rel.split("/");
		const layer = segs[0] as Layer;
		const underSliceOrShared = SLICED_LAYERS_SET.has(layer) || layer === "shared";
		if (!underSliceOrShared) {
			continue;
		}

		// (a) types-synonym directory at ANY depth under a slice/shared.
		for (let i = 1; i < segs.length - 1; i++) {
			const seg = segs[i]?.toLowerCase();
			if (seg && TYPES_SEGMENT_SYNONYMS.has(seg)) {
				violations.misplacedTypes.push({
					file: rel,
					message: `Forbidden "types"-style segment: "${segs.slice(0, i + 1).join("/")}/" — the "types" category describes WHAT the contents are, not what they are FOR.`,
					severity: "high",
					suggestion: `Delete the ${seg}/ folder. Move domain types → src/<layer>/<slice>/model/; request/response/DTO types → src/<layer>/<slice>/api/; component prop types → the same .tsx file in ui/; generic utility types → src/shared/lib/utility-types/. Never create src/shared/types/. Name the file after the domain (e.g. model/song.ts), not types.ts.`,
				});
				break;
			}
		}

		const base = require("node:path")
			.basename(filePath)
			.replace(/\.d\.ts$/, "")
			.replace(/\.(tsx?|jsx?)$/, "")
			.replace(/\.(types|d)$/, "");
		const baseLower = base.toLowerCase();

		// (b) technical-role file basename inside a slice segment.
		if (TYPE_ROLE_FILE_BASENAMES.has(baseLower) && SLICED_LAYERS_SET.has(layer)) {
			violations.misplacedTypes.push({
				file: rel,
				message: `Technical-role file name "${require("node:path").basename(filePath)}": files must describe the business domain, not their technical role (types/interfaces/typedefs).`,
				severity: "medium",
				suggestion: `Rename after the business domain it serves. In src/${layer}/${segs[1]}/model/ split into domain-named files (e.g. song.ts, playlist.ts). If they describe a backend response, move to api/ next to the request (api/dto.ts, api/get-song.ts). Do not keep one catch-all types.ts of unrelated interfaces.`,
			});
		}

		const raw = readFileSafe(filePath);
		const code = stripCommentsAndStrings(raw);

		// (c) `declare module "<pkg>"` inside a SLICE (not shared/** — that is the
		//     project's sanctioned ambient home). Relative-path module
		//     augmentation is allowed; only bare-package decls in slices flagged.
		if (SLICED_LAYERS_SET.has(layer)) {
			const declMod = raw.match(/(^|\n)\s*declare\s+module\s+["']([^"'.][^"']*)["']/);
			const declModName = declMod?.[2];
			if (declModName) {
				violations.misplacedTypes.push({
					file: rel,
					message: `Ambient \`declare module "${declModName}"\` inside a slice ("${rel}"): untyped-package declarations belong in src/shared/lib/untyped-packages/.`,
					severity: "medium",
					suggestion: `Move the declaration to src/shared/lib/untyped-packages/${declModName.replace(/[^a-z0-9-]/gi, "-")}.d.ts containing just \`declare module "${declModName}";\`. Generated OpenAPI/schema types live in spec/generated/ts (regenerate with \`bun generate\`), imported via @spec/*; never hand-place generated types in a slice.`,
				});
			}
		}

		// (d) BARE prop/context-only file in a NON-ui segment of a slice.
		//     Only a generically-named `props.ts`/`context.ts`/`prop-types.ts`
		//     is flagged — a domain-prefixed `<slice>.types.ts` is explicitly
		//     tolerated by Rex-types-02 (domain-prefix theater is partial-only)
		//     and is part of the clean WinSTT baseline; flagging it would be a
		//     false positive on a sanctioned pattern.
		if (SLICED_LAYERS_SET.has(layer)) {
			const parts = sliceParts(filePath);
			const isTsx = filePath.endsWith(".tsx") || filePath.endsWith(".jsx");
			const bareNamed = /^(?:props|context|prop-types|context-value)$/i.test(baseLower);
			if (parts && parts.segment && parts.segment !== "ui" && !isTsx && bareNamed) {
				const onlyPropsType =
					/\bexport\s+(?:interface|type)\s+\w*(?:Props|ContextValue)\b/.test(code) &&
					!/\bexport\s+(?:const|function|class|default)\b/.test(code);
				if (onlyPropsType) {
					violations.misplacedTypes.push({
						file: rel,
						message: `Component prop/context interface not colocated: "${rel}" is a bare ${baseLower}.ts of *Props/*ContextValue types in "${parts.segment}/" (non-ui).`,
						severity: "low",
						suggestion: `Move the prop/context interface into the SAME .tsx file as the component in src/${parts.layer}/${parts.slice}/ui/ (only split to a sibling ui/ file for Vue/Svelte SFCs). Never collect prop types into model/ or a types/ bucket.`,
					});
				}
			}
		}

		// (e) generated code scattered OUTSIDE the sanctioned generated home.
		//     WinSTT sanctioned homes: spec/generated/** and src/shared/api/**.
		//     Require BOTH a strong codegen banner AND an API-schema signal so a
		//     hand-written file that merely mentions a generated table in a doc
		//     comment is not false-flagged.
		if (GENERATED_BANNER_REGEX.test(raw.slice(0, 800))) {
			const hasSchemaSignal =
				/components\s*\[\s*["']schemas["']\s*\]/.test(raw) ||
				/\boperations\s*\[\s*["']/.test(raw) ||
				/\bpaths\s*:\s*\{/.test(raw) ||
				/openapi-typescript|Generated by orval/i.test(raw.slice(0, 800));
			const inSanctionedGen =
				rel.startsWith("shared/api/") ||
				rel.includes("/openapi/") ||
				rel.startsWith("shared/api/openapi");
			if (hasSchemaSignal && !inSanctionedGen) {
				violations.misplacedTypes.push({
					file: rel,
					message: `Generated API code outside the dedicated generated dir: "${rel}" carries a codegen banner and OpenAPI schema signature but is scattered into a slice/segment.`,
					severity: "medium",
					suggestion: `Generated OpenAPI code must live in one dedicated directory. In WinSTT that is spec/generated/ts/ (regenerate with \`bun generate\`) or src/shared/api/ (the project's generated schema home). Delete the scattered copy and import the shared generated types via the @spec/* alias.`,
				});
			}
		}
	}
}

/**
 * Rule Rex-api-requests-01: HTTP client construction outside shared/api.
 * WinSTT has no HTTP client (IPC app) so this never regresses the baseline.
 */
async function checkHttpClientOutsideShared(allFiles: readonly string[]): Promise<void> {
	for (const filePath of allFiles) {
		if (isTestFile(filePath)) {
			continue;
		}
		const rel = relative(srcPath, filePath).replace(/\\/g, "/");
		const raw = readFileSafe(filePath);
		if (!raw) {
			continue;
		}
		const code = stripCommentsAndStrings(raw);
		const hasFactory =
			HTTP_CLIENT_FACTORY_REGEX.test(code) ||
			(/\bclass\s+\w*Api\w*\b/.test(code) && /baseURL|baseUrl|this\.base\b/.test(code)) ||
			(/import\s*\(\s*""\s*\)/.test(code) && /\.\s*create\s*\(/.test(code));
		if (!hasFactory) {
			continue;
		}
		const isCanonical =
			rel === "shared/api/client.ts" ||
			/^shared\/api\/[^/]*client\.ts$/.test(rel) ||
			/^shared\/api\/.*\/client\.ts$/.test(rel);
		if (isCanonical) {
			continue;
		}
		violations.httpClientOutsideShared.push({
			file: rel,
			message: `HTTP client constructed outside shared/api: "${rel}" builds an axios/fetch/ApiClient instance with a base URL. There must be exactly ONE centralized client at src/shared/api/client.ts.`,
			severity: "high",
			suggestion: `Move the client construction to src/shared/api/client.ts, export it via src/shared/api/index.ts (\`export { client } from "./client"\`), and import it here with \`import { client } from "@/shared/api"\`. Do not create per-slice clients, do not put the client in shared/lib/, and do not inline fetch with a hardcoded base URL in model/.`,
		});
	}
}

/**
 * Rule Rex-api-requests-03 + Rex-auth-04/06: request functions in ui/ or
 * model/ instead of api/; slice-local request leaked into the public API;
 * request infra misplaced in shared/lib (must be shared/api).
 */
async function checkMisplacedApiRequest(allFiles: readonly string[]): Promise<void> {
	for (const filePath of allFiles) {
		if (isTestFile(filePath)) {
			continue;
		}
		const rel = relative(srcPath, filePath).replace(/\\/g, "/");
		const raw = readFileSafe(filePath);
		if (!raw || isPureReexportFile(raw)) {
			continue;
		}
		const code = stripCommentsAndStrings(raw);
		const isRequest =
			/\bclient\s*\.\s*(?:get|post|put|delete|patch)\s*\(/.test(code) ||
			/\b(?:GET|POST|PUT|DELETE|PATCH)\s*\(\s*""/.test(code) ||
			/\bfetch\s*\(\s*""\s*\/?/.test(code) ||
			/\baxios\s*\.\s*(?:get|post|put|delete|patch)\s*\(/.test(code);
		if (!isRequest) {
			continue;
		}
		const parts = sliceParts(filePath);
		// (a) request in ui/ or model/ of a slice → belongs in api/.
		if (parts && (parts.segment === "ui" || parts.segment === "model")) {
			violations.misplacedApiRequest.push({
				file: rel,
				message: `API request outside api/ segment: "${rel}" performs an HTTP request from the "${parts.segment}/" segment. Requests belong in the slice's api/ segment or src/shared/api.`,
				severity: "medium",
				suggestion: `Move the request to src/${parts.layer}/${parts.slice}/api/<name>.ts, importing \`{ client } from "@/shared/api"\`, and import it into the component via the relative ../api/ path. If reused by another slice, promote it to src/shared/api/endpoints/ — do not deep-import @/.../api/....`,
			});
		}
		// (b) request infra dropped in shared/lib instead of shared/api.
		if (rel.startsWith("shared/lib/")) {
			violations.misplacedApiRequest.push({
				file: rel,
				message: `Request infrastructure in shared/lib/: "${rel}" performs HTTP requests but lives in shared/lib (must be shared/api).`,
				severity: "medium",
				suggestion: `Move this to src/shared/api/ (endpoint functions → src/shared/api/endpoints/<group>.ts importing { client } from "../client"), and export from src/shared/api/index.ts. shared/lib is for domain-agnostic helpers, not request transport.`,
			});
		}
	}

	// (c) slice-local request leaked into the slice public API (index.ts).
	//     Scoped to views/ and features/ only: Rex-api-requests-03 forbids a
	//     SINGLE-USE page/feature request being re-exported. An entity that
	//     OWNS its API legitimately exposes its data accessor via its public
	//     API (CLAUDE.md entities example: api/get-article.ts + index.ts), so
	//     entities/ and widgets/ are intentionally NOT scanned here.
	for (const layer of ["views", "features"] as const) {
		const layerDir = join(srcPath, layer);
		if (!existsSync(layerDir)) {
			continue;
		}
		let entries: Dirent[];
		try {
			entries = (await readdir(layerDir, { withFileTypes: true, encoding: "utf8" })) as Dirent[];
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name.startsWith("_")) {
				continue;
			}
			const idx = join(layerDir, entry.name, "index.ts");
			if (!existsSync(idx)) {
				continue;
			}
			const idxRaw = readFileSafe(idx);
			const idxCode = stripCommentsAndStrings(idxRaw);
			const reexportsApi =
				/export\s+\{[^}]*\}\s+from\s+""[\s\S]*?/.test(idxCode) &&
				/from\s+['"]\.\/api\//.test(idxRaw);
			const wildcardApi = /export\s+\*\s+from\s+['"]\.\/api\//.test(idxRaw);
			if (!reexportsApi && !wildcardApi) {
				continue;
			}
			// Only flag when the re-exported api file actually contains a request.
			const apiDir = join(layerDir, entry.name, "api");
			let apiHasRequest = false;
			if (existsSync(apiDir)) {
				try {
					for (const f of require("node:fs").readdirSync(apiDir) as string[]) {
						if (!TS_FILE_REGEX.test(f) || isTestFile(f)) {
							continue;
						}
						const c = stripCommentsAndStrings(readFileSafe(join(apiDir, f)));
						if (
							/\bclient\s*\.\s*(?:get|post|put|delete|patch)\s*\(/.test(c) ||
							/\b(?:GET|POST|PUT|DELETE|PATCH)\s*\(\s*""/.test(c) ||
							/\bfetch\s*\(\s*""/.test(c)
						) {
							apiHasRequest = true;
							break;
						}
					}
				} catch {
					// ignore
				}
			}
			if (apiHasRequest) {
				violations.misplacedApiRequest.push({
					file: `${layer}/${entry.name}/index.ts`,
					message: `Slice-local request leaked into public API: "${layer}/${entry.name}/index.ts" re-exports an api/ request function. Single-slice requests must NOT be in the public API.`,
					severity: "low",
					suggestion: `Remove the request re-export from src/${layer}/${entry.name}/index.ts and keep the request private in src/${layer}/${entry.name}/api/. If another slice needs it, promote it to src/shared/api/endpoints/ instead of exposing/deep-importing it.`,
				});
			}
		}
	}
}

/**
 * Rule Rex-api-requests-06: query keys / server-state types shared by 2+
 * slices but owned by a slice or duplicated. Single-slice keys are sanctioned
 * (CLAUDE.md §9) and NOT flagged.
 */
async function checkSharedQueryKeys(allFiles: readonly string[]): Promise<void> {
	const keyToSlices = new Map<string, Set<string>>();
	for (const filePath of allFiles) {
		if (isTestFile(filePath)) {
			continue;
		}
		const parts = sliceParts(filePath);
		const sliceId = parts ? `${parts.layer}/${parts.slice}` : null;
		if (!sliceId) {
			continue;
		}
		const raw = readFileSafe(filePath);
		if (!raw) {
			continue;
		}
		const code = stripCommentsAndStrings(raw);
		const keyMatches = code.matchAll(/queryKey\s*:\s*\[\s*([^\]]{0,120})\]/g);
		for (const m of keyMatches) {
			const norm = (m[1] ?? "").replace(/\s+/g, "").replace(/""/g, "S").slice(0, 60);
			if (!norm || norm.length < 2) {
				continue;
			}
			if (!keyToSlices.has(norm)) {
				keyToSlices.set(norm, new Set());
			}
			keyToSlices.get(norm)?.add(sliceId);
		}
	}
	for (const [norm, slices] of keyToSlices.entries()) {
		if (slices.size >= 2) {
			violations.sharedQueryKeys.push({
				file: `${Array.from(slices).join(", ")}`,
				message: `Duplicated query key across ${slices.size} slices: the queryKey literal [${norm}…] appears in ${Array.from(slices).join(", ")}. Cross-slice-shared cache keys must live in the shared layer.`,
				severity: "low",
				suggestion: `Create src/shared/api/query-keys.ts, define the key factory + shared API data types there, export from src/shared/api/index.ts, and import via @/shared/api. Replace the duplicated queryKey/queryOptions literals with the shared factory. A key used by only ONE slice stays in that slice's api/*.queries.ts (sanctioned, CLAUDE.md §9).`,
			});
		}
	}
}

/**
 * Rule Rund-needs-driven-02: generic/technical feature-slice names that do
 * not answer "what is the business value for the user?".
 */
async function checkGenericFeatureNames(): Promise<void> {
	const featuresDir = join(srcPath, "features");
	if (!existsSync(featuresDir)) {
		return;
	}
	let entries: Dirent[];
	try {
		entries = (await readdir(featuresDir, { withFileTypes: true, encoding: "utf8" })) as Dirent[];
	} catch {
		return;
	}
	for (const entry of entries) {
		if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name.startsWith("_")) {
			continue;
		}
		const name = entry.name;
		const tokens = name
			.split(/[-_]/)
			.flatMap((t) => t.split(/(?=[A-Z])/))
			.map((t) => t.toLowerCase())
			.filter(Boolean);
		const meaningful = tokens.filter((t) => t.length > 1);
		const allGeneric =
			meaningful.length > 0 && meaningful.every((t) => GENERIC_SLICE_TOKENS.has(t));
		const namePattern = GENERIC_SLICE_NAME_REGEX.test(name);
		if (allGeneric || namePattern) {
			violations.genericFeatureName.push({
				file: `features/${name}`,
				message: `Generic/technical feature slice name "features/${name}" does not answer "What is the business value for the user?".`,
				severity: "high",
				suggestion: `Rename the directory after the concrete user goal using a verb-noun form (e.g. features/book-meeting/, features/reset-password/). Update its index.ts exports and every importer (@/features/${name} → @/features/<new>). If it is a UI region/screen with no user action, it belongs in src/widgets/ or src/views/<page>/ui/; if it is a domain noun with no interaction, move it to src/entities/<noun>/. Never park code under features/common, features/core, features/misc, or features/main.`,
			});
		}
	}
}

/**
 * Rule Rund-needs-driven-03: infrastructure / env / design-system primitive /
 * another feature's code smuggled inside a feature slice.
 */
async function checkFeatureInfraSmuggling(allFiles: readonly string[]): Promise<void> {
	const PRIMITIVE_NAME_REGEX = /^(?:Button|Input|Card|Modal|Spinner|Icon|Badge|Tooltip|Avatar)$/;
	for (const filePath of allFiles) {
		if (isTestFile(filePath)) {
			continue;
		}
		const rel = relative(srcPath, filePath).replace(/\\/g, "/");
		if (!rel.startsWith("features/")) {
			continue;
		}
		const parts = sliceParts(filePath);
		if (!parts) {
			continue;
		}
		const raw = readFileSafe(filePath);
		if (!raw) {
			continue;
		}
		const code = stripCommentsAndStrings(raw);
		const base = require("node:path")
			.basename(filePath)
			.replace(/\.(tsx?|jsx?)$/, "");

		// (a) env / app config read inside a feature config/ segment.
		if (
			parts.segment === "config" &&
			/\bprocess\s*\.\s*env\b|import\s*\.\s*meta\s*\.\s*env\b/.test(code)
		) {
			violations.featureInfraSmuggling.push({
				file: rel,
				message: `App/env config inside a feature: "${rel}" reads process.env/import.meta.env from a feature config/ segment. Env/config belongs in src/shared/config/.`,
				severity: "medium",
				suggestion: `Move env vars / app config to src/shared/config/. A feature must hold only the code implementing its own task.`,
			});
		}
		// (b) generic HTTP client built inside a feature lib/api with no domain token.
		if (
			(parts.segment === "lib" || parts.segment === "api") &&
			HTTP_CLIENT_FACTORY_REGEX.test(code) &&
			!new RegExp(parts.slice.split(/[-_]/)[0] ?? "zzzz", "i").test(base)
		) {
			violations.featureInfraSmuggling.push({
				file: rel,
				message: `Generic HTTP client inside a feature: "${rel}" constructs a reusable client in a feature ${parts.segment}/ segment.`,
				severity: "medium",
				suggestion: `Move the generic API/HTTP client to src/shared/api/. Features must not author reusable infrastructure.`,
			});
		}
		// (c) design-system primitive component under features/*/ui/.
		if (
			parts.segment === "ui" &&
			PRIMITIVE_NAME_REGEX.test(base) &&
			!new RegExp(parts.slice.split(/[-_]/)[0] ?? "zzzz", "i").test(code) &&
			/export\s+(?:default\s+)?function\s+/.test(code) &&
			!/use[A-Z]\w+\s*\(/.test(code)
		) {
			violations.featureInfraSmuggling.push({
				file: rel,
				message: `Design-system primitive inside a feature: "${rel}" is a generic "${base}" component under a feature ui/ segment.`,
				severity: "low",
				suggestion: `Move reusable UI primitives to src/shared/ui/${base.toLowerCase()}/. Keep only feature-specific UI in features/${parts.slice}/ui/.`,
			});
		}
	}
}

/**
 * Rule Rund-needs-driven-01 + Rskill-12: a feature slice implementing more
 * than one user-facing functionality (multi-purpose god slice) — cohesion
 * proxy via index.ts entry surfaces, ui/*Form|*Page|*Dialog stems, sibling
 * sub-folders each with their own ui/, and umbrella names.
 */
const UMBRELLA_SLICE_NAMES = new Set<string>([
	"management",
	"account",
	"core",
	"common",
	"misc",
	"general",
	"system",
	"manager",
	"dashboard",
	"main",
	"office",
]);

async function checkMultiPurposeFeature(): Promise<void> {
	const featuresDir = join(srcPath, "features");
	if (!existsSync(featuresDir)) {
		return;
	}
	let entries: Dirent[];
	try {
		entries = (await readdir(featuresDir, { withFileTypes: true, encoding: "utf8" })) as Dirent[];
	} catch {
		return;
	}
	for (const entry of entries) {
		if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name.startsWith("_")) {
			continue;
		}
		const sliceDir = join(featuresDir, entry.name);
		const all = await scanDirectory(sliceDir);
		const src = all.filter((f) => !isTestFile(f));

		// (a) sibling sub-folders inside the slice that each own a ui/ (split camo).
		let uiSubfolderCount = 0;
		try {
			for (const sub of require("node:fs").readdirSync(sliceDir, {
				withFileTypes: true,
			}) as Dirent[]) {
				if (
					sub.isDirectory() &&
					!ALLOWED_SEGMENTS_SET.has(sub.name) &&
					!sub.name.startsWith(".") &&
					!sub.name.startsWith("_") &&
					existsSync(join(sliceDir, sub.name, "ui"))
				) {
					uiSubfolderCount++;
				}
			}
		} catch {
			// ignore
		}

		// (b) distinct *Form/*Page/*Dialog stems under ui/.
		const stems = new Set<string>();
		for (const f of src) {
			const b = require("node:path").basename(f);
			const m = b.match(/^([A-Z][A-Za-z0-9]*?)(Form|Page|Dialog|Modal|Panel)\.(tsx|jsx)$/);
			if (m?.[1] && f.replace(/\\/g, "/").includes("/ui/")) {
				stems.add(m[1].toLowerCase());
			}
		}

		// (c) distinct entry surfaces in index.ts (capitalized export idents).
		const idx = join(sliceDir, "index.ts");
		const exportStems = new Set<string>();
		if (existsSync(idx)) {
			const idxCode = stripCommentsAndStrings(readFileSafe(idx));
			for (const m of idxCode.matchAll(/export\s+\{([^}]*)\}/g)) {
				for (const nameRaw of (m[1] ?? "").split(",")) {
					const id = nameRaw
						.trim()
						.split(/\s+as\s+/)[0]
						?.trim();
					if (id && /^[A-Z]/.test(id)) {
						// stem = leading word before next Capital
						const stem = id.split(/(?=[A-Z])/)[0]?.toLowerCase() ?? id.toLowerCase();
						exportStems.add(stem);
					}
				}
			}
		}

		const umbrella = UMBRELLA_SLICE_NAMES.has(entry.name.toLowerCase());
		const reasons: string[] = [];
		if (uiSubfolderCount >= 2) {
			reasons.push(`${uiSubfolderCount} sibling sub-folders each with their own ui/`);
		}
		if (stems.size >= 2) {
			reasons.push(
				`${stems.size} disjoint Form/Page/Dialog UI entry points (${Array.from(stems).join(", ")})`
			);
		}
		if (exportStems.size >= 3) {
			reasons.push(`${exportStems.size} unrelated public entry surfaces`);
		}
		if (umbrella) {
			reasons.push(`umbrella/generic slice name "${entry.name}"`);
		}
		if (
			reasons.length > 0 &&
			(umbrella || stems.size >= 2 || uiSubfolderCount >= 2 || exportStems.size >= 3)
		) {
			violations.multiPurposeFeature.push({
				file: `features/${entry.name}`,
				message: `Multi-purpose / god feature slice "features/${entry.name}": ${reasons.join("; ")}. FSD requires one feature = one useful functionality for the user.`,
				severity: "medium",
				suggestion: `Split into focused single-responsibility slices (one verb-noun feature per distinct user action, e.g. src/features/sign-in/, src/features/reset-password/), each with its own ui/ model/ api/ index.ts, then compose them at src/views/<view>/. Renaming to an umbrella (account/, core/) or hiding concerns in nested ui/<concern>/ folders or model/everything.ts does not fix it.`,
			});
		}
	}
}

/**
 * Rule Rex-auth-05/06: auth/token store inside a views/* or widgets/* model
 * segment; localStorage token write inside ui/.
 */
async function checkAuthInPageWidget(allFiles: readonly string[]): Promise<void> {
	for (const filePath of allFiles) {
		if (isTestFile(filePath)) {
			continue;
		}
		const rel = relative(srcPath, filePath).replace(/\\/g, "/");
		const parts = sliceParts(filePath);
		if (!parts || (parts.layer !== "views" && parts.layer !== "widgets")) {
			continue;
		}
		const raw = readFileSafe(filePath);
		if (!raw) {
			continue;
		}
		const code = stripCommentsAndStrings(raw);
		const base = require("node:path").basename(filePath);
		const nameAuthy = /auth|token|session|credential/i.test(base);
		const contentAuthy = AUTH_SYMBOL_REGEX.test(code);
		const isStore = STORE_FACTORY_REGEX.test(code);

		if (parts.segment === "model" && (nameAuthy || contentAuthy) && isStore) {
			violations.authInPageWidget.push({
				file: rel,
				message: `Auth/token store in a ${parts.layer}/ model segment: "${rel}". App-wide auth state must NOT live in pages/widgets.`,
				severity: "medium",
				suggestion: `Move the auth/token store to a sanctioned home: src/shared/auth/ (token store + refresh) or src/shared/api/ (next to the API client), OR src/entities/user/model/auth-store.ts exported via src/entities/user/index.ts. Delete src/${rel}. Higher layers must reach the token only via the slice public API or a provided context, never a deep @/entities/user/model/... import. (shared/auth/ is a legitimate FSD segment — do not "fix" it by deleting it.)`,
			});
		}
		// localStorage token write inside ui/.
		if (
			parts.segment === "ui" &&
			(filePath.endsWith(".tsx") || filePath.endsWith(".jsx")) &&
			/localStorage\s*\.\s*setItem\s*\(\s*""/.test(code) &&
			/token|access_?token|jwt/i.test(raw)
		) {
			violations.authInPageWidget.push({
				file: rel,
				message: `Token persisted from ui/: "${rel}" writes a token to localStorage inside a ${parts.layer} ui/ component.`,
				severity: "medium",
				suggestion: `Remove the localStorage token write from ui/. Persist tokens once in the token store's owning layer (src/shared/auth/ or src/entities/user/model/auth-store.ts) and call that single function from the auth flow.`,
			});
		}
	}
}

/**
 * Rule Rex-auth-01/02: login/register slice over-decomposition (sibling
 * views/login + views/register), duplicate LoginDialog across slices, and
 * auth UI smuggled into shared/ui.
 */
async function checkAuthPagePairing(allFiles: readonly string[]): Promise<void> {
	const viewsDir = join(srcPath, "views");
	if (existsSync(viewsDir)) {
		let names: string[] = [];
		try {
			names = (await readdir(viewsDir, { withFileTypes: true, encoding: "utf8" }))
				.filter((e) => e.isDirectory() && !e.name.startsWith(".") && !e.name.startsWith("_"))
				.map((e) => e.name);
		} catch {
			names = [];
		}
		const loginRe = /^(?:log[-_ ]?in|sign[-_ ]?in)$/i;
		const registerRe = /^(?:register|sign[-_ ]?up)$/i;
		const hasLogin = names.find((n) => loginRe.test(n));
		const hasRegister = names.find((n) => registerRe.test(n));
		if (hasLogin && hasRegister) {
			violations.authPagePairing.push({
				file: `views/${hasLogin}, views/${hasRegister}`,
				message: `Login/registration over-decomposition: separate "views/${hasLogin}" and "views/${hasRegister}" slices. The FSD auth guide groups them into ONE Pages-layer slice.`,
				severity: "low",
				suggestion: `Merge into ONE slice: move both components to src/views/login/ui/LoginPage.tsx and src/views/login/ui/RegisterPage.tsx, delete src/views/${hasRegister}/, and export BOTH from src/views/login/index.ts. Do not create a views/auth/ slice-group; a reusable login dialog should be a widget at src/widgets/login-dialog/.`,
			});
		}
	}

	// Duplicate LoginDialog/Modal across slices + auth UI in shared/ui.
	const loginUiFiles: { rel: string; hash: string }[] = [];
	for (const filePath of allFiles) {
		if (isTestFile(filePath)) {
			continue;
		}
		const rel = relative(srcPath, filePath).replace(/\\/g, "/");
		const base = require("node:path").basename(filePath);
		if (!/Login(?:Dialog|Modal|Popup|Form)\.(?:tsx|jsx)$/.test(base)) {
			continue;
		}
		const raw = readFileSafe(filePath);
		const code = stripCommentsAndStrings(raw);
		if (rel.startsWith("shared/ui/")) {
			const hasNet = /\bfetch\s*\(|\baxios\b|\b(?:POST|GET)\s*\(|\buseMutation\s*\(/.test(code);
			if (hasNet) {
				violations.authPagePairing.push({
					file: rel,
					message: `Auth UI with network logic in shared/ui: "${rel}" is a login dialog/form containing a network call — auth business logic must not live in shared/ui.`,
					severity: "medium",
					suggestion: `Extract the reusable login dialog into a Widgets-layer slice: src/widgets/login-dialog/ui/LoginDialog.tsx + src/widgets/login-dialog/index.ts. Delete it from src/shared/ui/ and import via @/widgets/login-dialog.`,
				});
			}
		}
		const norm = code.replace(/\s+/g, " ").trim();
		let h = 0;
		for (let i = 0; i < norm.length; i++) {
			h = (h * 31 + norm.charCodeAt(i)) | 0;
		}
		loginUiFiles.push({ rel, hash: `${norm.length}:${h}` });
	}
	const byHash = new Map<string, string[]>();
	for (const f of loginUiFiles) {
		if (!byHash.has(f.hash)) {
			byHash.set(f.hash, []);
		}
		byHash.get(f.hash)?.push(f.rel);
	}
	for (const [, files] of byHash.entries()) {
		const distinctSlices = new Set(files.map((f) => f.split("/").slice(0, 2).join("/")));
		if (files.length >= 2 && distinctSlices.size >= 2) {
			violations.authPagePairing.push({
				file: files.join(", "),
				message: `Duplicated login dialog across slices: byte-identical login UI in ${files.join(", ")}. Reusable auth UI must be a single Widgets-layer slice.`,
				severity: "medium",
				suggestion: `Create src/widgets/login-dialog/ui/LoginDialog.tsx + src/widgets/login-dialog/index.ts, delete every duplicate, and have each page import it via @/widgets/login-dialog. Never import one views/* slice from another.`,
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

			// Skip node_modules, .next, dist, dist-renderer (the Vite output),
			// etc. Dot-prefixed dirs catch `.next/`, `.cache/`, `.vite/`, etc.
			if (
				entry.name.startsWith(".") ||
				entry.name === "node_modules" ||
				entry.name === "dist" ||
				entry.name === "dist-renderer"
			) {
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

		// Batch A — structural per-file checks (path-based, content-independent)
		await checkNonCanonicalSegments(filePath);
		await checkMisplacedSegmentFiles(filePath);

		// Check for forbidden segment names in path
		if (hasForbiddenSegment(filePath)) {
			const segment = getSegmentFromPath(filePath);
			if (segment && FORBIDDEN_SEGMENTS_SET.has(segment)) {
				// Compute the slice prefix (e.g. "features/auth") so the mitigation
				// names the actual offending path and a concrete WinSTT target.
				const fsParts = relativePath.split(PATH_SEPARATOR_REGEX);
				const fsSegIdx = fsParts.indexOf(segment);
				const fsSlicePrefix =
					fsSegIdx >= 1
						? fsParts.slice(0, fsSegIdx).join("/")
						: `${fsParts[0] ?? "<layer>"}/<slice>`;
				const fixByName: Record<string, string> = {
					hooks: `Move each file under src/${relativePath} out of the forbidden hooks/ segment: a domain/data hook → src/${fsSlicePrefix}/model/, an API query/mutation hook → src/${fsSlicePrefix}/api/, UI-only behavior → its component file in src/${fsSlicePrefix}/ui/, a project-wide reusable hook → src/shared/lib/hooks/. Then delete the empty hooks/ folder.`,
					types: `Move the type aliases in src/${relativePath} out of the forbidden types/ segment: domain types → src/${fsSlicePrefix}/model/<domain>.ts, request/response/DTO types → src/${fsSlicePrefix}/api/, component prop types → the same .tsx file in src/${fsSlicePrefix}/ui/, generic utility types → src/shared/lib/utility-types/. Delete the types/ folder; never create a types/ bucket.`,
					utils: `Move src/${relativePath} out of the forbidden utils/ segment: slice-specific helpers → src/${fsSlicePrefix}/lib/, domain-agnostic helpers → src/shared/lib/<focus>/. Rename the file after its purpose, not "utils". Delete the utils/ folder.`,
					components: `Move src/${relativePath} into src/${fsSlicePrefix}/ui/ (components are UI by definition) and delete the forbidden components/ folder.`,
					helpers: `Move src/${relativePath} into src/${fsSlicePrefix}/lib/ (slice-specific) or src/shared/lib/<focus>/ (generic) and delete the forbidden helpers/ folder.`,
					constants: `Move src/${relativePath} into src/${fsSlicePrefix}/config/ (slice constants) or src/shared/config/ (app-wide) and delete the forbidden constants/ folder.`,
				};
				const suggestion =
					fixByName[segment] ??
					`Move src/${relativePath} into a purpose-named segment of src/${fsSlicePrefix}/ (ui/ api/ model/ lib/ config/). Do not evade with synonyms (parts/, typedefs/, util/, fns/, common/, core/) or by nesting the essence folder inside a valid segment.`;

				violations.forbiddenSegments.push({
					file: relativePath,
					message: `Forbidden segment name: "${segment}" in src/${relativePath} — segments must describe purpose, not technical essence (FSD Rslices-segments-05).`,
					severity: "high",
					suggestion,
				});
			}
		}

		// Check for nested segments
		if (hasNestedSegment(filePath)) {
			const nsParts = relativePath.split(PATH_SEPARATOR_REGEX);
			const nsSlicePrefix =
				nsParts.length >= 3 ? nsParts.slice(0, 2).join("/") : `${nsParts[0] ?? "<layer>"}/<slice>`;
			violations.nestedSegments.push({
				file: relativePath,
				message: `Nested segment structure in src/${relativePath} (a segment folder nested inside another segment, e.g. ui/components/ or model/types/) — segments must be exactly one level under the slice.`,
				severity: "medium",
				suggestion: `Flatten src/${relativePath}: move the file up to a single top-level segment of src/${nsSlicePrefix}/ (ui/ api/ model/ lib/ config/) — e.g. ui/components/X.tsx → ui/X.tsx, model/types/Y.ts → model/Y.ts. Delete the inner nested folder; never re-introduce an essence folder (components/, hooks/, types/) inside a valid segment.`,
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
				message: `Wildcard export (\`export * from\`) in src/${relativePath} — re-exports a slice's internal file structure and blocks tree-shaking (FSD Rpublic-api).`,
				severity: "low",
				suggestion: `In src/${relativePath} replace every \`export * from "./<x>"\` with explicit named re-exports of only the slice's public surface, e.g. \`export { Foo } from "./ui/Foo";\` / \`export type { Bar } from "./model/bar";\`. Never use \`export *\`, an empty \`export {}\`, or a differently-named barrel.`,
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
									message: `Hardcoded URL "${match[1]}" in src/${relativePath}:${index + 1} — only the views/ (pages) layer may own URLs; lower layers must stay URL-agnostic (FSD Riss-routes / §14).`,
									severity: "high",
									suggestion: `Replace the literal "${match[1]}" in src/${relativePath}: add a route builder to src/shared/routes/ (e.g. \`export const routes = { login: () => "/login" }\`) and import it via "@/shared/routes", OR accept the URL as a prop passed down from the owning src/views/<page>/ slice. Never hardcode a path string below the views/ layer.`,
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
								message: `Self-import via own index.ts in src/${relativePath}:${index + 1} — "@/${importPath}" pulls the slice's own barrel back into itself (circular-dependency risk).`,
								severity: "high",
								suggestion: `In src/${relativePath} change \`from "@/${importPath}"\` to a direct relative import of the concrete file inside src/${layer}/${currentSlice}/ (e.g. \`from "../model/<file>"\` or \`from "./<file>"\`). A slice file must never import its own index.ts.`,
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
								message: `Absolute self-import in src/${relativePath}:${index + 1} — "@/${importPath}" deep-paths back into its own slice src/${layer}/${currentSlice}/ via the @/ alias.`,
								severity: "medium",
								suggestion: `In src/${relativePath} change \`from "@/${importPath}"\` to the equivalent relative path within src/${layer}/${currentSlice}/ (e.g. \`from "../<segment>/<file>"\`). Reserve @/ aliases for imports that cross slice boundaries.`,
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
						// Allow index.client.ts imports (Next-style pattern; harmless)
						const isClientIndex = importParts[2] === "index.client";
						if (!isAtXImport && !isClientIndex && !isTestFile(filePath)) {
							violations.deepAliasImports.push({
								file: relativePath,
								line: index + 1,
								message: `Deep import bypassing public API in src/${relativePath}:${index + 1} — "@/${importPath}" reaches into ${importLayer}/${importSlice}'s internals instead of its index.ts (FSD Riss-cross-imports-04).`,
								severity: "high",
								suggestion: `In src/${relativePath} change \`from "@/${importPath}"\` to \`from "@/${importLayer}/${importSlice}"\` and add an explicit NAMED re-export of the needed symbol to src/${importLayer}/${importSlice}/index.ts (a hook/UI component — never a raw store/selector). Do NOT add \`export * from "./..."\` to that index (public-API theater) or launder via a shared/ barrel, import type, or dynamic import(). For entities use @/entities/${importSlice}/@x/<consumer> instead.`,
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
								message: `Cross-layer import in src/${relativePath}:${index + 1} — shared/ imports from ${importInfo.layer}/${importInfo.slice ?? ""} (shared is the bottom layer and may import nothing; FSD Rref-layers-01).`,
								severity: "critical",
								suggestion: `Remove the upward import in src/${relativePath}. shared/ is the bottom layer and must not import ${importInfo.layer}/. Move the code you need DOWN into src/shared/lib/<focus>/ (generic) or src/shared/ui/<component>/ (primitive), OR move this file out of shared/ into the layer that actually owns it (src/${importInfo.layer}/${importInfo.slice ?? "<slice>"}/ or src/app/). Do not route it through a barrel, re-export, dynamic import(), import type, or a test file.`,
								targetLayer: importInfo.layer ?? null,
								targetSlice: importInfo.slice ?? null,
								importPath: line,
							});
							continue;
						}
						if (importInfo.isCrossLayer) {
							// Determine appropriate, path-aware suggestion based on layers involved
							const tgt = `${importInfo.layer ?? "<layer>"}/${importInfo.slice ?? "<slice>"}`;
							let suggestion = "";
							if (layer === "shared" && importInfo.layer) {
								suggestion = `Remove the upward import in src/${relativePath}. shared/ is the bottom layer and may import nothing; move the needed code DOWN into src/shared/lib/<focus>/ or src/shared/ui/<component>/, OR relocate this file into src/${tgt}/ / src/app/ if it is not actually generic.`;
							} else if (layer === "features" && importInfo.layer === "widgets") {
								suggestion = `Remove the import of @/${tgt} from src/${relativePath}. A feature may not import a widget (widgets sit above features). Import the underlying feature/entity directly, or lift the composition UP into src/views/<page>/ which may import both the widget and this feature.`;
							} else if (layer === "features" && importInfo.layer === "features") {
								suggestion = `Remove the sibling-feature import of @/${tgt} from src/${relativePath}. Features must stay independent. EITHER push the shared logic DOWN — domain → src/entities/<x>/, generic → src/shared/lib/<focus>/ — and import that from both features, OR compose both features from a parent src/views/<page>/ / src/widgets/<w>/ via props.`;
							} else {
								suggestion = `Remove the upward/sideways import of @/${tgt} from src/${relativePath} (layer order: app → views → widgets → features → entities → shared). Move the shared code DOWN: domain → src/entities/<x>/ (expose via its index.ts), generic → src/shared/lib/<focus>/; or lift composition UP into src/views/<page>/ or src/app/. Do not launder it through a barrel, re-export, dynamic import(), import type, or test file.`;
							}

							violations.crossLayerImports.push({
								file: relativePath,
								line: index + 1,
								message: `Cross-layer import in src/${relativePath}:${index + 1} — ${layer}/ imports from ${tgt} (violates layer hierarchy app → views → widgets → features → entities → shared; FSD Rref-layers-01).`,
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
								message: `Cross-entity import missing @x in src/${relativePath}:${index + 1} — entities/${currentSlice ?? "<entityA>"} imports entities/${importInfo.slice} directly instead of through the @x bridge (FSD Riss-cross-imports-02).`,
								severity: "critical",
								suggestion: `Create src/entities/${importInfo.slice ?? "<entityB>"}/@x/${currentSlice ?? "<entityA>"}.ts exporting ONLY the minimal named symbols entities/${currentSlice ?? "<entityA>"} needs (e.g. \`export type { X } from "../model/x";\`), then change the import in src/${relativePath} to \`from "@/entities/${importInfo.slice ?? "<entityB>"}/@x/${currentSlice ?? "<entityA>"}"\`. Before adding @x, prefer merging the two entities if they always change together. Never deep-import past another entity's index.ts/@x or launder via shared/ or import type.`,
								targetLayer: layer,
								targetSlice: importInfo.slice ?? null,
								importPath: line,
							});
						} else if (importInfo.isCrossSlice && COMPOSITION_LAYERS_SET.has(layer)) {
							const cs = getSliceFromPath(filePath, layer);
							violations.crossLayerImports.push({
								file: relativePath,
								line: index + 1,
								message: `Cross-slice import in src/${relativePath}:${index + 1} — ${layer}/${cs ?? "<sliceA>"} imports sibling ${layer}/${importInfo.slice} on the same layer (sibling slices must be independent; FSD Riss-cross-imports-01).`,
								severity: "critical",
								suggestion: `Remove the sibling import of @/${layer}/${importInfo.slice} from src/${relativePath}. Fix by ONE of: (a) merge the two slices if they always change together; (b) push shared domain logic DOWN to src/entities/<domain>/model/ and import it from both; (c) compose from above — render both slices from src/views/<page>/ui/ or pass one in via props. Do not launder through a shared/ barrel, re-export, dynamic import(), import type, or a test file.`,
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
							message: `Cross-layer ${callType} in src/${relativePath}:${index + 1} — ${layer}/ reaches up to ${importLayer}/${importSlice ?? ""} via ${callType} (a deferred import is the same layer violation; FSD Rref-layers-01).`,
							severity: "critical",
							suggestion: `Replace the ${callType} of "@/${importPath}" in src/${relativePath} with a proper downward dependency: move the shared code into src/entities/<x>/ (domain) or src/shared/lib/<focus>/ (generic) and import that, OR lift composition UP into src/views/<page>/ / src/app/. A dynamic import()/require() does not exempt the layer rule.`,
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
							message: `Cross-layer ${callType} in src/${relativePath}:${index + 1} — shared/ reaches up to ${importLayer}/${importSlice ?? ""} via ${callType} (shared is the bottom layer and may import nothing; FSD Rref-layers-01).`,
							severity: "critical",
							suggestion: `Remove the ${callType} of "@/${importPath}" from src/${relativePath}. shared/ must not import ${importLayer}/. Move the needed code DOWN into src/shared/lib/<focus>/ or src/shared/ui/<component>/, OR relocate this file out of shared/ into src/app/ or src/${importLayer}/${importSlice ?? "<slice>"}/ if it is not actually generic.`,
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

// ═════════════════════════════════════════════════════════════════════════════
// Batch B — Public API & Cross-Import Hardening
//
// Implements / hardens: Rref-public-api-01..07, Rslices-segments-02 & -04,
// Riss-cross-imports-01..05, Rgs-tutorial-03/04/07/08, Rskill-02/03/04 (the
// public-API / @x / deep-import / wildcard / same-layer-cross-slice facets).
//
// All detectors share one specifier extractor + resolver so every evasion form
// (alias, bare, relative, `import type`, `require()`, `await import()`,
// string-concat/template static prefix, `?query`, `.ts`/`/index` suffix,
// `.cjs`/`.mjs`/`.mts`/`.d.ts`) collapses to one canonical
// `(layer, slice, depthPastSliceRoot, isAtX, atxTarget)`.
// ═════════════════════════════════════════════════════════════════════════════

// Canonical segment names that may appear directly under a slice root. Used to
// distinguish a real slice from a slice-GROUP folder and to detect segment
// barrels.
const BATCH_B_SEGMENT_NAMES = new Set<string>([
	"ui",
	"api",
	"model",
	"lib",
	"config",
	"@x",
	"routes",
	"i18n",
]);

// Source extensions Batch B scans (extension-dodge resistance: .cjs/.mts/.d.ts).
const BATCH_B_SOURCE_RE = /\.(?:tsx?|jsx?|mts|cts|mjs|cjs|d\.ts)$/;

// tsconfig path aliases that map into src/. `@/` is the canonical one; we keep
// the resolver alias-agnostic so a remapped alias (e.g. `@auth/*`) can't dodge.
const BATCH_B_SRC_ALIASES = ["@/"] as const;

/**
 * Strip a module specifier down to a slice-comparable path:
 *  - remove `?query` / `#hash`
 *  - remove a trailing JS/TS extension
 *  - remove a trailing `/index`
 *  - collapse a trailing slash
 */
function batchBNormalizeSpecifier(spec: string): string {
	let s = spec.split("?")[0] ?? spec;
	s = s.split("#")[0] ?? s;
	s = s.replace(/\\/g, "/");
	s = s.replace(/\.(?:tsx?|jsx?|mts|cts|mjs|cjs)$/, "");
	s = s.replace(/\.d\.ts$/, "");
	s = s.replace(/\/index$/, "");
	s = s.replace(/\/+$/, "");
	return s;
}

interface BatchBTarget {
	/** For `<slice>/@x/<target>` the `<target>` basename, else null. */
	atxConsumer: string | null;
	/** Number of path parts after `<layer>/<slice>` (0 = slice root/index). */
	depth: number;
	/** First path part after the slice root, if any (e.g. "model", "@x"). */
	firstSegment: string | null;
	/** True when the path enters an `@x` directory of the target slice. */
	isAtX: boolean;
	layer: Layer;
	/** Whole resolved `<layer>/<slice>/...` path (normalized, no ext). */
	rel: string;
	slice: string;
}

/**
 * Resolve a (normalized) module specifier, given the importing file, into a
 * canonical FSD target. Handles `@/` alias, bare `layer/slice/...`, and
 * relative `../` forms (resolved against the importer dir). Returns null when
 * the specifier does not land inside a sliced FSD layer.
 */
function batchBResolveTarget(rawSpec: string, currentFile: string): BatchBTarget | null {
	const spec = batchBNormalizeSpecifier(rawSpec);
	if (!spec) {
		return null;
	}

	let relPath: string | null = null;

	// 1. Alias forms (@/...). Keep alias-agnostic: any `<alias>foo` where the
	//    alias maps to src/ becomes `foo`.
	for (const alias of BATCH_B_SRC_ALIASES) {
		if (spec.startsWith(alias)) {
			relPath = spec.slice(alias.length);
			break;
		}
	}

	// 2. Bare layer-prefixed (e.g. "features/cart/model/x" or "features/cart").
	if (relPath === null) {
		const head = spec.split("/")[0];
		if (head && LAYERS_SET.has(head)) {
			relPath = spec;
		}
	}

	// 3. Relative form — resolve against the importer's directory, then make it
	//    relative to srcPath.
	if (relPath === null && (spec.startsWith("./") || spec.startsWith("../"))) {
		const importerDir = join(currentFile, "..");
		const resolved = resolve(importerDir, spec);
		const fromSrc = relative(srcPath, resolved).replace(/\\/g, "/");
		if (fromSrc && !fromSrc.startsWith("..")) {
			relPath = fromSrc;
		}
	}

	if (!relPath) {
		return null;
	}

	relPath = relPath.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
	const parts = relPath.split("/").filter(Boolean);
	const layer = parts[0] as Layer;
	if (!LAYERS_SET.has(layer) || layer === "app" || layer === "shared") {
		return null;
	}
	const slice = parts[1];
	if (!slice) {
		return null;
	}
	const after = parts.slice(2);
	const isAtX = after[0] === "@x";
	return {
		layer,
		slice,
		depth: after.length,
		firstSegment: after[0] ?? null,
		isAtX,
		atxConsumer: isAtX ? (after[1] ?? null) : null,
		rel: `${layer}/${slice}${after.length ? `/${after.join("/")}` : ""}`,
	};
}

const BATCH_B_STATIC_SPEC_RE = /(?:^|\s)(?:import|export)\b[^'"`]*?\bfrom\s*['"]([^'"]+)['"]/;
const BATCH_B_SIDE_EFFECT_IMPORT_RE = /^\s*import\s*['"]([^'"]+)['"]/;
const BATCH_B_DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/;
const BATCH_B_REQUIRE_RE = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/;
// Dynamic specifier with a static leading literal then concat/template:
//   import("@/features/" + x)   import(`@/features/${x}`)
const BATCH_B_DYNAMIC_PREFIX_RE =
	/\b(?:import\s*\(|require\s*\()\s*[`'"]((?:@\/|\.\.?\/)?[A-Za-z0-9_@./-]+)(?:[`'"]\s*\+|\$\{)/;
const BATCH_B_TYPE_ONLY_RE = /\bimport\s+type\b|\bexport\s+type\b/;

interface BatchBEdge {
	isDynamic: boolean;
	isTypeOnly: boolean;
	line: number;
	rawLine: string;
	spec: string;
}

/**
 * Extract every module specifier from a file's text, covering every evasion
 * form. Comment lines are skipped (best-effort line-based — AST is overkill
 * for the specifier surface and the existing script is line-based too).
 */
function batchBExtractEdges(content: string): BatchBEdge[] {
	const edges: BatchBEdge[] = [];
	const lines = content.split("\n");
	let inBlockComment = false;
	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i];
		if (!raw) {
			continue;
		}
		const trimmed = raw.trim();
		if (inBlockComment) {
			if (trimmed.includes("*/")) {
				inBlockComment = false;
			}
			continue;
		}
		if (trimmed.startsWith("/*")) {
			if (!trimmed.includes("*/")) {
				inBlockComment = true;
			}
			continue;
		}
		if (trimmed.startsWith("//") || trimmed.startsWith("*")) {
			continue;
		}
		const isTypeOnly = BATCH_B_TYPE_ONLY_RE.test(raw);
		const staticM = raw.match(BATCH_B_STATIC_SPEC_RE) || raw.match(BATCH_B_SIDE_EFFECT_IMPORT_RE);
		if (staticM?.[1]) {
			edges.push({
				spec: staticM[1],
				line: i + 1,
				isTypeOnly,
				isDynamic: false,
				rawLine: trimmed,
			});
		}
		const dynM = raw.match(BATCH_B_DYNAMIC_IMPORT_RE) || raw.match(BATCH_B_REQUIRE_RE);
		if (dynM?.[1]) {
			edges.push({
				spec: dynM[1],
				line: i + 1,
				isTypeOnly: false,
				isDynamic: true,
				rawLine: trimmed,
			});
		} else {
			const prefM = raw.match(BATCH_B_DYNAMIC_PREFIX_RE);
			if (prefM?.[1]) {
				edges.push({
					spec: prefM[1],
					line: i + 1,
					isTypeOnly: false,
					isDynamic: true,
					rawLine: trimmed,
				});
			}
		}
	}
	return edges;
}

/** Read a file synchronously, returning "" on failure. */
function batchBReadFile(filePath: string): string {
	try {
		return require("node:fs").readFileSync(filePath, "utf-8");
	} catch {
		return "";
	}
}

/**
 * Build a one-hop re-export laundering index. Maps a barrel file (any file that
 * only re-exports) → the set of canonical slice paths it ultimately re-exports
 * from. Used to attribute laundered cross-slice edges back to the real
 * importer (covers `shared/`/widget-shim/neutral-slice laundering tricks).
 */
function batchBBuildLaunderMap(allFiles: readonly string[]): Map<string, BatchBTarget[]> {
	const map = new Map<string, BatchBTarget[]>();
	for (const filePath of allFiles) {
		const content = batchBReadFile(filePath);
		if (!content) {
			continue;
		}
		const edges = batchBExtractEdges(content);
		const targets: BatchBTarget[] = [];
		for (const e of edges) {
			// Only `export ... from` / `export *` lines launder a slice surface.
			if (!/^\s*export\b/.test(e.rawLine)) {
				continue;
			}
			const t = batchBResolveTarget(e.spec, filePath);
			if (t) {
				targets.push(t);
			}
		}
		if (targets.length > 0) {
			map.set(filePath.replace(/\\/g, "/"), targets);
		}
	}
	return map;
}

/**
 * Rule Rref-public-api-05 / Riss-cross-imports-02 / Rskill-02..04:
 * Kill the `@x` universal escape hatch.
 *  - `@x` directory only legal under `entities/<slice>/@x/`
 *  - `@x` file must be minimal (no `export *` / no deep-internal re-export)
 *  - `@x` consumed cross-slice must be entities-only AND consumed by the
 *    entity the `@x/<target>.ts` is named for
 *  - `@x` filename should be the consumer slice (catch-all index/misc warned)
 */
async function checkAtxMisuse(allFiles: readonly string[]): Promise<void> {
	const atxFiles = allFiles.filter((f) => isInAtXDirectory(f));

	for (const filePath of atxFiles) {
		const rel = relative(srcPath, filePath).replace(/\\/g, "/");
		const parts = rel.split("/");
		const layer = parts[0];
		const slice = parts[1];
		// Locate the @x segment position.
		const atxIdx = parts.indexOf("@x");
		if (atxIdx < 0) {
			continue;
		}

		// (a) @x must live exactly at <layer>/<slice>/@x/<file> on entities.
		if (layer !== "entities") {
			violations.atxMisuse.push({
				file: rel,
				message: `Forbidden @x directory outside entities: "src/${layer}/${slice}/@x/" — @x is the entities-only cross-import slot`,
				severity: "critical",
				suggestion: `The @x cross-import notation is only permitted on the entities layer. Remove "src/${layer}/${slice}/@x/". To share code between two ${layer} slices, move the shared logic down to src/entities/<x>/ or src/shared/lib/ and import it from there, OR compose both slices from a higher layer (a widget/view). Do not use @x to wire together non-entity slices.`,
			});
			continue;
		}

		// (b) @x must be directly at entities/<slice>/@x/ (not nested deeper).
		if (atxIdx !== 2) {
			violations.atxMisuse.push({
				file: rel,
				message: `Misplaced @x directory: "${rel}" — @x must sit directly at src/entities/${slice}/@x/, not nested`,
				severity: "high",
				suggestion: `Move this file to src/entities/${slice}/@x/<consumerEntity>.ts. The @x public-API slot is exactly one level under the slice root.`,
			});
		}

		const baseName = basename(filePath).replace(BATCH_B_SOURCE_RE, "");

		// (c) @x filename should be the consumer slice; catch-all names defeat
		//     the targeted-surface intent (warning).
		if (
			atxIdx === 2 &&
			(baseName === "index" || baseName === "misc" || baseName === "utils" || baseName === "common")
		) {
			violations.atxMisuse.push({
				file: rel,
				message: `Non-targeted @x filename: "${baseName}" — @x files must be named after the consuming entity (entities/${slice}/@x/<consumer>.ts), not a catch-all`,
				severity: "medium",
				suggestion: `Rename to src/entities/${slice}/@x/<consumerEntity>.ts and expose ONLY the minimal symbols that one specific entity needs. A catch-all @x/${baseName}.ts re-exposes the slice to every entity and defeats the minimal-surface intent.`,
			});
		}

		// (d) @x content must be a minimal named surface — no `export *`,
		//     no namespace re-export, no re-export of internals/whole segments.
		const content = batchBReadFile(filePath);
		if (content) {
			const lines = content.split("\n");
			for (let i = 0; i < lines.length; i++) {
				const lineRaw = lines[i];
				if (!lineRaw) {
					continue;
				}
				const t = lineRaw.trim();
				if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) {
					continue;
				}
				if (/\bexport\s+\*/.test(lineRaw)) {
					violations.atxMisuse.push({
						file: rel,
						line: i + 1,
						message: `@x file uses wildcard re-export ("export *") — @x must expose a MINIMAL named surface, not the whole slice`,
						severity: "high",
						suggestion: `In ${rel} replace the wildcard with explicit named re-exports of only what the peer entity needs, e.g. export type { Song } from "../model/song"; — never export * from "../model".`,
					});
					continue;
				}
				// @x re-exporting deep internals (../model/internal/*, deeper
				// than the slice's own model/api public boundary).
				const fromM = lineRaw.match(/\bfrom\s+['"]([^'"]+)['"]/);
				if (fromM?.[1] && /^\s*export\b/.test(t)) {
					const src = fromM[1].replace(/\\/g, "/");
					if (/\/internal\//.test(src) || /(^|\/)\.\.\/.+\/.+\/.+/.test(src)) {
						violations.atxMisuse.push({
							file: rel,
							line: i + 1,
							message: `@x file re-exports a deep internal path ("${fromM[1]}") — @x must only re-export the slice's own minimal public symbols`,
							severity: "high",
							suggestion: `In ${rel} re-export only top-level named symbols from this entity's own model/api (e.g. export type { Song } from "../model/song";). Do not launder another slice's internals or a "*/internal/*" path through @x.`,
						});
					}
				}
			}
		}
	}

	// (e) Import scan: any specifier whose normalized path contains `/@x/`
	//     where the importing slice's layer is NOT entities → forbidden;
	//     and for entities, the consumer must be the entity the @x is for.
	for (const filePath of allFiles) {
		const srcLayer = getLayerFromPath(filePath);
		if (!srcLayer) {
			continue;
		}
		const srcSlice = getSliceFromPath(filePath, srcLayer);
		const content = batchBReadFile(filePath);
		if (!content) {
			continue;
		}
		const rel = relative(srcPath, filePath).replace(/\\/g, "/");
		for (const edge of batchBExtractEdges(content)) {
			const t = batchBResolveTarget(edge.spec, filePath);
			if (!t || !t.isAtX) {
				continue;
			}
			if (t.layer !== "entities") {
				violations.atxMisuse.push({
					file: rel,
					line: edge.line,
					message: `Imports an @x path on a non-entities layer: "${edge.spec}" (${t.layer}/${t.slice}/@x) — @x cross-imports are entities-only`,
					severity: "critical",
					suggestion: `Remove this @x import. @x is only valid between two src/entities/ slices. To reuse ${t.layer}/${t.slice} logic, expose it via that slice's public index.ts and compose from a higher layer, or push the shared logic into src/entities/ or src/shared/lib/.`,
				});
				continue;
			}
			// entities → entities @x: the consumer must be the entity named by
			// the @x file (entities/<target>/@x/<thisSlice>.ts).
			if (srcLayer === "entities" && srcSlice && t.atxConsumer && t.atxConsumer !== srcSlice) {
				violations.atxMisuse.push({
					file: rel,
					line: edge.line,
					message: `@x surface mismatch: "entities/${srcSlice}" imports "entities/${t.slice}/@x/${t.atxConsumer}" but that @x file is the surface for entity "${t.atxConsumer}", not "${srcSlice}"`,
					severity: "high",
					suggestion: `Create src/entities/${t.slice}/@x/${srcSlice}.ts exposing only what entities/${srcSlice} needs, and import from "@/entities/${t.slice}/@x/${srcSlice}". Do not consume another entity's @x surface.`,
				});
			}
		}
	}
}

/**
 * Rule Rref-public-api-01/03/06, Rgs-tutorial-03, Rskill-03/04 (index facets):
 * Public-API index theater.
 *  - empty `index.ts` (no real re-export / only `export {}`)
 *  - non-conforming public-API extension (index.js/.mjs/.cjs as the only API)
 *  - slice root index re-exporting another slice's DEEP internal
 *  - redundant per-segment barrel (`<slice>/<segment>/index.*`, `barrel.ts`,
 *    `_<segment>.ts`)
 */
async function checkIndexTheater(allFiles: readonly string[]): Promise<void> {
	const slicedLayers: Layer[] = ["views", "widgets", "features", "entities"];

	for (const layer of slicedLayers) {
		const layerDir = join(srcPath, layer);
		if (!existsSync(layerDir)) {
			continue;
		}
		let entries: Dirent[];
		try {
			entries = await readdir(layerDir, { withFileTypes: true, encoding: "utf8" });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (!entry.isDirectory() || entry.name === "__tests__") {
				continue;
			}
			const sliceDir = join(layerDir, entry.name);
			const sliceName = entry.name;

			// Is this a real slice (has segments / a root index) or a slice
			// GROUP folder (children are slices)? Group folders are handled by
			// checkSliceGroupCode — skip index-presence logic for them.
			let sliceEntries: Dirent[];
			try {
				sliceEntries = await readdir(sliceDir, { withFileTypes: true, encoding: "utf8" });
			} catch {
				continue;
			}
			const hasSegmentDir = sliceEntries.some(
				(e) => e.isDirectory() && BATCH_B_SEGMENT_NAMES.has(e.name)
			);
			const rootTs = join(sliceDir, "index.ts");
			const rootTsx = join(sliceDir, "index.tsx");
			const hasRootIndex = existsSync(rootTs) || existsSync(rootTsx);

			// (a) Non-conforming public-API extension: only index.js/.mjs/.cjs.
			if (!hasRootIndex && hasSegmentDir) {
				for (const ext of ["js", "jsx", "mjs", "cjs", "d.ts"]) {
					if (existsSync(join(sliceDir, `index.${ext}`))) {
						violations.indexTheater.push({
							file: `${layer}/${sliceName}/index.${ext}`,
							message: `Slice public API is "index.${ext}", not index.ts/index.tsx — the existence check and tooling expect a TS public API`,
							severity: "high",
							suggestion: `Rename src/${layer}/${sliceName}/index.${ext} to src/${layer}/${sliceName}/index.ts with explicit named re-exports of the slice's public surface, e.g. export { ${sliceName} } from "./ui/${sliceName}";`,
						});
						break;
					}
				}
			}

			// (b) Empty / placeholder root index (file exists but exposes nothing).
			for (const idx of [rootTs, rootTsx]) {
				if (!existsSync(idx)) {
					continue;
				}
				const content = batchBReadFile(idx);
				const hasReal =
					/\bexport\s+(?:\{[^}]*\w[^}]*\}|\*|default|(?:async\s+)?function|const|class|type|interface|enum|let|var|abstract)/.test(
						content
					) && !/^\s*export\s*\{\s*\}\s*;?\s*$/m.test(content.trim());
				const onlyEmptyExport =
					/^\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*|\s)*export\s*\{\s*\}\s*;?\s*$/.test(content);
				if (!hasReal || onlyEmptyExport) {
					violations.indexTheater.push({
						file: relative(srcPath, idx).replace(/\\/g, "/"),
						message: `Empty/placeholder public API: "${layer}/${sliceName}/${basename(idx)}" has no real re-export (public-API theater)`,
						severity: "high",
						suggestion: `Add explicit named re-exports of the slice's public surface to src/${layer}/${sliceName}/${basename(idx)}, e.g. export { ${sliceName} } from "./ui/${sliceName}"; — an empty index lets consumers deep-import internals while the presence check passes.`,
					});
				}

				// (c) Root index re-exporting ANOTHER slice's deep internal.
				for (const edge of batchBExtractEdges(content)) {
					if (!/^\s*export\b/.test(edge.rawLine)) {
						continue;
					}
					const t = batchBResolveTarget(edge.spec, idx);
					if (t && !(t.layer === layer && t.slice === sliceName) && t.depth >= 2 && !t.isAtX) {
						violations.indexTheater.push({
							file: relative(srcPath, idx).replace(/\\/g, "/"),
							line: edge.line,
							message: `Public API re-exports another slice's deep internal: "${edge.spec}" (${t.rel}) — index must only expose its OWN slice`,
							severity: "high",
							suggestion: `In src/${layer}/${sliceName}/${basename(idx)} do not re-export ${t.layer}/${t.slice} internals. Import ${t.slice} via "@/${t.layer}/${t.slice}" where it is actually used; this index must re-export only this slice's own files (./ui, ./model, …).`,
						});
					}
				}
			}
		}
	}

	// (d) Redundant per-segment barrels on sliced layers (NOT under shared/).
	for (const filePath of allFiles) {
		const layer = getLayerFromPath(filePath);
		if (!layer || !SLICED_LAYERS_SET.has(layer)) {
			continue;
		}
		if (isTestFile(filePath) || isInAtXDirectory(filePath)) {
			continue;
		}
		const rel = relative(srcPath, filePath).replace(/\\/g, "/");
		const parts = rel.split("/");
		// parts: layer / slice / <seg> / ... / file
		// We need depth >= 3 (a file directly under a slice, e.g.
		// layer/slice/_ui.ts) to evaluate the segment-as-file evasion, and
		// depth >= 4 for an in-segment index/barrel. Anything shallower (a
		// slice-root index.ts) is the legitimate public API — skip it.
		if (parts.length < 3) {
			continue;
		}
		const sliceName = parts[1];
		const base = basename(filePath);
		const baseNoExt = base.replace(BATCH_B_SOURCE_RE, "");
		// A real segment barrel: any index.* at depth >= 2 inside the slice
		// (i.e. inside a segment dir or deeper), OR a `barrel.ts`, OR a
		// segment-as-file `_<segment>.ts` directly under the slice.
		const isIndexLike = /^index$/.test(baseNoExt) || baseNoExt === "barrel";
		const segNameForFile = baseNoExt.replace(/^_/, "");
		const segmentAsFile =
			parts.length === 3 && /^_/.test(baseNoExt) && BATCH_B_SEGMENT_NAMES.has(segNameForFile);
		if ((isIndexLike && parts.length >= 4) || segmentAsFile) {
			const seg = segmentAsFile ? segNameForFile : (parts[2] ?? "ui");
			violations.indexTheater.push({
				file: rel,
				message: `Redundant segment barrel: "${rel}" — a slice on a sliced layer has exactly ONE public API (its root index.ts), not per-segment barrels`,
				severity: "medium",
				suggestion: `Delete src/${rel}. Re-export needed symbols directly from the concrete file in src/${layer}/${sliceName}/index.ts (e.g. export { X } from "./${seg}/X";) and have internal slice files import each other by full relative path (./${seg}/X), not through a segment barrel. (This rule does NOT apply under src/shared/.)`,
			});
		}
	}
}

/**
 * Rule Rref-public-api-07, Rgs-tutorial-07: shared/ui & shared/lib must have a
 * separate index per component/library — no mega-barrel, and consumers must
 * import the specific subpath, not the aggregate root.
 */
async function checkSharedAggregateImports(allFiles: readonly string[]): Promise<void> {
	const AGG_THRESHOLD = 3;
	const aggregateFiles = new Set<string>(); // canonical rel path of aggregate barrels

	for (const segment of ["ui", "lib"]) {
		const idxTs = join(srcPath, "shared", segment, "index.ts");
		const idxTsx = join(srcPath, "shared", segment, "index.tsx");
		for (const idx of [idxTs, idxTsx]) {
			if (!existsSync(idx)) {
				continue;
			}
			const content = batchBReadFile(idx);
			const subFolders = new Set<string>();
			let wildcard = false;
			for (const edge of batchBExtractEdges(content)) {
				if (!/^\s*export\b/.test(edge.rawLine)) {
					continue;
				}
				if (/\bexport\s+\*/.test(edge.rawLine)) {
					wildcard = true;
				}
				const m = edge.spec.replace(/\\/g, "/").match(/^\.\/([^/]+)/);
				if (m?.[1]) {
					subFolders.add(m[1]);
				}
			}
			if (wildcard || subFolders.size >= AGG_THRESHOLD) {
				aggregateFiles.add(`shared/${segment}`);
				violations.sharedAggregateImports.push({
					file: `shared/${segment}/${basename(idx)}`,
					message: `shared/${segment} mega-barrel re-exports ${subFolders.size} sibling ${segment === "ui" ? "component" : "library"} folders${wildcard ? " (incl. export *)" : ""} — a single shared/${segment} index blocks tree-shaking`,
					severity: "medium",
					suggestion: `Do not maintain a single src/shared/${segment}/index.ts that aggregates many ${segment === "ui" ? "components" : "libraries"}. Give each its own entry (src/shared/${segment}/<name>/index.ts → export { X } from "./X";) and have consumers import the specific path "@/shared/${segment}/<name>". If an aggregate must exist, no production code may import from it.`,
				});
			}
		}
	}

	// Consumers importing the aggregate root (no subpath), or importing a
	// component folder that lacks its own index (forced deep import).
	for (const filePath of allFiles) {
		if (isTestFile(filePath)) {
			continue;
		}
		const content = batchBReadFile(filePath);
		if (!content) {
			continue;
		}
		const rel = relative(srcPath, filePath).replace(/\\/g, "/");
		for (const edge of batchBExtractEdges(content)) {
			const spec = batchBNormalizeSpecifier(edge.spec).replace(/\\/g, "/");
			let aliasRel: string | null = null;
			for (const alias of BATCH_B_SRC_ALIASES) {
				if (spec.startsWith(alias)) {
					aliasRel = spec.slice(alias.length);
					break;
				}
			}
			if (!aliasRel) {
				continue;
			}
			const p = aliasRel.split("/").filter(Boolean);
			// Aggregate-root import: exactly `shared/ui` or `shared/lib`.
			if (p.length === 2 && p[0] === "shared" && (p[1] === "ui" || p[1] === "lib")) {
				violations.sharedAggregateImports.push({
					file: rel,
					line: edge.line,
					message: `Imports the shared/${p[1]} aggregate barrel "@/shared/${p[1]}" (no subpath) — blocks tree-shaking`,
					severity: "medium",
					suggestion: `Change "@/shared/${p[1]}" to the specific per-${p[1] === "ui" ? "component" : "library"} public API, e.g. ${p[1] === "ui" ? 'import { Button } from "@/shared/ui/button";' : 'import { formatDate } from "@/shared/lib/date";'}. Never import the shared/${p[1]} aggregate root.`,
				});
				continue;
			}
			// Deep import past a missing component index:
			// `@/shared/ui/<comp>/<File>` where `<comp>` has no index.*.
			if (p.length >= 4 && p[0] === "shared" && (p[1] === "ui" || p[1] === "lib")) {
				const compDir = join(srcPath, "shared", p[1], p[2] ?? "");
				const compHasIndex =
					existsSync(join(compDir, "index.ts")) || existsSync(join(compDir, "index.tsx"));
				if (!compHasIndex && p[2]) {
					violations.sharedAggregateImports.push({
						file: rel,
						line: edge.line,
						message: `Deep import into shared/${p[1]}/${p[2]} with no component index: "@/${aliasRel}"`,
						severity: "medium",
						suggestion: `Create src/shared/${p[1]}/${p[2]}/index.ts (export { ${p[2]} } from "./${p[3]}";) and import "@/shared/${p[1]}/${p[2]}" instead of deep-pathing to "@/${aliasRel}".`,
					});
				}
			}
		}
	}
}

/**
 * Rule Rslices-segments-04 / Rgs-tutorial-08: a slice-GROUP folder (its
 * children are slices) must contain ZERO shared code — no file at the group
 * root, no group-level segment folders, no group-level index/utils/config.
 */
async function checkSliceGroupCode(): Promise<void> {
	const slicedLayers: Layer[] = ["views", "widgets", "features", "entities"];
	for (const layer of slicedLayers) {
		const layerDir = join(srcPath, layer);
		if (!existsSync(layerDir)) {
			continue;
		}
		let entries: Dirent[];
		try {
			entries = await readdir(layerDir, { withFileTypes: true, encoding: "utf8" });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (!entry.isDirectory() || entry.name === "__tests__" || entry.name.startsWith(".")) {
				continue;
			}
			const groupDir = join(layerDir, entry.name);
			let children: Dirent[];
			try {
				children = await readdir(groupDir, { withFileTypes: true, encoding: "utf8" });
			} catch {
				continue;
			}
			// Identify child SLICE directories: a child dir that itself has a
			// segment dir (ui/api/model/lib/config) or its own index.ts(x).
			const childSlices = children.filter((c) => {
				if (!c.isDirectory() || BATCH_B_SEGMENT_NAMES.has(c.name) || c.name === "__tests__") {
					return false;
				}
				const cd = join(groupDir, c.name);
				let gc: Dirent[];
				try {
					gc = require("node:fs").readdirSync(cd, { withFileTypes: true });
				} catch {
					return false;
				}
				return (
					gc.some((g: Dirent) => g.isDirectory() && BATCH_B_SEGMENT_NAMES.has(g.name)) ||
					existsSync(join(cd, "index.ts")) ||
					existsSync(join(cd, "index.tsx"))
				);
			});
			// It is a SLICE GROUP iff >=1 child is itself a slice. (A folder
			// whose children are NOT slices is just a normal slice with its
			// own segments — handled by other checks.)
			if (childSlices.length === 0) {
				continue;
			}
			const childSliceNames = new Set(childSlices.map((c) => c.name));
			// A slice-group folder must contain ONLY its sub-slice folders.
			// Flag ANY group-root file (incl. index.ts/utils.ts/config.ts/.cjs)
			// and ANY group-root directory that is NOT one of the sub-slices
			// (a group-level segment like model/, a `_shared/`, etc.).
			for (const c of children) {
				const cPath = join(groupDir, c.name);
				const rel = relative(srcPath, cPath).replace(/\\/g, "/");
				if (c.isFile()) {
					violations.sliceGroupCode.push({
						file: rel,
						message: `Slice-group folder "${layer}/${entry.name}/" contains a file "${c.name}" — group folders must hold ONLY sub-slice folders (no group-level index/utils/config)`,
						severity: "high",
						suggestion: `Delete/move src/${rel}. The real slices are src/${layer}/${entry.name}/<${[...childSliceNames].join("|")}>/. If "${c.name}" is genuinely shared, move it down a layer (src/entities/<x>/ or src/shared/lib/) and import it from there; if it belongs to one sub-slice, move it inside that slice's segment. Remove any group-level index.ts re-exporting the children — import each real slice directly: import { X } from "@/${layer}/${entry.name}/${[...childSliceNames][0] ?? "<slice>"}".`,
					});
				} else if (c.isDirectory() && !childSliceNames.has(c.name) && c.name !== "__tests__") {
					violations.sliceGroupCode.push({
						file: rel,
						message: `Slice-group folder "${layer}/${entry.name}/" contains a non-slice folder "${c.name}/" (group-level shared code/segment)`,
						severity: "high",
						suggestion: `A group folder must contain only its sub-slice folders (${[...childSliceNames].join(", ")}). Move src/${rel} into src/entities/<x>/ or src/shared/lib/ (if shared) or into the owning sub-slice. Do not keep a group-level ${c.name}/ segment/helper.`,
					});
				}
			}
		}
	}
}

/**
 * Rule Rslices-segments-02 / Riss-cross-imports-01/03/04 / Rgs-tutorial-01 /
 * Rskill-02/03: same-layer cross-slice imports via every laundering form the
 * existing line-based crossLayerImports check misses — dynamic import()/
 * require(), `import type`, relative `../`, string-concat/template static
 * prefix, and re-export laundering through a shared/barrel/neutral slice.
 * Also surfaces DEEP cross-slice internal access (Riss-cross-imports-04).
 */
async function checkLaunderedCrossImports(allFiles: readonly string[]): Promise<void> {
	const launderMap = batchBBuildLaunderMap(allFiles);

	for (const filePath of allFiles) {
		const srcLayer = getLayerFromPath(filePath);
		if (!srcLayer || srcLayer === "app" || srcLayer === "shared") {
			continue;
		}
		const srcSlice = getSliceFromPath(filePath, srcLayer);
		if (!srcSlice) {
			continue;
		}
		// Test files are relaxed for direct flagging UNLESS imported by prod —
		// we still scan them so a prod re-export of a test file is caught via
		// the launder map; but a same-layer edge inside a *.test.ts that no
		// prod file pulls is noise. Keep parity with the existing script:
		// skip direct test-file flagging.
		if (isTestFile(filePath)) {
			continue;
		}
		const content = batchBReadFile(filePath);
		if (!content) {
			continue;
		}
		const rel = relative(srcPath, filePath).replace(/\\/g, "/");
		// Dedupe: one finding per (line, target slice) — direct + laundered
		// resolutions of the same physical edge describe the SAME illegal
		// coupling; reporting it once keeps the report actionable.
		const seenEdge = new Set<string>();

		for (const edge of batchBExtractEdges(content)) {
			const direct = batchBResolveTarget(edge.spec, filePath);

			// Un-analyzable dynamic specifier whose static prefix reaches this
			// file's own layer but no resolvable slice (e.g. `import("@/" +
			// "features/" + sliceVar)`): the ledger marks this partial — flag
			// it as a cross-slice candidate so the evasion isn't free.
			if (edge.isDynamic && !direct) {
				const sp = batchBNormalizeSpecifier(edge.spec).replace(/\\/g, "/");
				let arel: string | null = null;
				for (const alias of BATCH_B_SRC_ALIASES) {
					if (sp.startsWith(alias)) {
						arel = sp.slice(alias.length);
						break;
					}
				}
				const head = arel?.split("/").filter(Boolean)[0];
				// srcLayer is already guaranteed non-app/non-shared by the
				// early continue at the top of this loop.
				if (head === srcLayer) {
					const key = `dyn:${edge.line}`;
					if (!seenEdge.has(key)) {
						seenEdge.add(key);
						violations.launderedCrossImports.push({
							file: rel,
							line: edge.line,
							message: `Un-analyzable dynamic same-layer specifier: "${edge.spec}" in ${srcLayer}/${srcSlice} builds a "${srcLayer}/…" path at runtime — likely a cross-slice import hidden from static analysis`,
							severity: "high",
							suggestion: `Replace this computed import with an explicit static import from the target slice's public API. If the target is a sibling slice on the same layer, that is itself forbidden — compose from a higher layer (src/views/ or src/widgets/) or push shared logic to src/entities/ or src/shared/lib/. Do not build "@/${srcLayer}/…" specifiers by string concatenation/template to dodge the cross-slice rule.`,
						});
					}
				}
			}

			// Resolve laundering: if the specifier resolves to a barrel file
			// that itself re-exports a slice surface, attribute that surface.
			const launderedTargets: BatchBTarget[] = [];
			if (direct) {
				// direct edge itself
				launderedTargets.push(direct);
			}
			// Map the specifier to an absolute file and see if it is a known
			// laundering barrel.
			const spec = batchBNormalizeSpecifier(edge.spec);
			let candidateFile: string | null = null;
			for (const alias of BATCH_B_SRC_ALIASES) {
				if (spec.startsWith(alias)) {
					candidateFile = resolveAliasImport(spec.slice(alias.length));
					break;
				}
			}
			if (!candidateFile && (spec.startsWith("./") || spec.startsWith("../"))) {
				const abs = resolve(join(filePath, ".."), spec);
				candidateFile =
					[`${abs}.ts`, `${abs}.tsx`, join(abs, "index.ts"), join(abs, "index.tsx")].find((c) =>
						existsSync(c)
					) ?? null;
			}
			// Do NOT follow laundering through a legitimate entities `@x`
			// file: `entities/A/@x/B.ts` is the FSD-sanctioned cross-entity
			// bridge — its internal `export ... from "../model/X"` is the
			// whole point. Its correctness (minimal surface, consumer match)
			// is owned by checkAtxMisuse; treating its re-export as a
			// laundered deep edge would false-positive the canonical pattern.
			const candidateIsEntityAtX =
				candidateFile != null && direct != null && direct.isAtX && direct.layer === "entities";
			if (candidateFile && !candidateIsEntityAtX) {
				const launderEntry = launderMap.get(candidateFile.replace(/\\/g, "/"));
				if (launderEntry) {
					for (const lt of launderEntry) {
						launderedTargets.push(lt);
					}
				}
			}

			for (const t of launderedTargets) {
				// Same-layer, different-slice is the violation surface here.
				if (!(t.layer === srcLayer && t.slice !== srcSlice)) {
					continue;
				}
				// entities↔entities via a proper @x file is sanctioned
				// (consumer-match is enforced by checkAtxMisuse, cycles by
				// checkCircularImports — do not double-flag the legal form).
				if (srcLayer === "entities" && t.isAtX) {
					continue;
				}
				const dedupeKey = `${edge.line}:${t.layer}/${t.slice}`;
				if (seenEdge.has(dedupeKey)) {
					continue;
				}
				seenEdge.add(dedupeKey);
				const launderedVia = t === direct ? null : candidateFile;
				const kind = edge.isDynamic
					? "dynamic import()/require()"
					: edge.isTypeOnly
						? "type-only import"
						: launderedVia
							? "re-export laundering"
							: "import";
				const deep = t.depth >= 1 && !(t.depth === 0);
				const deepNote =
					deep && !t.isAtX ? ` reaching internal "${t.rel}" (deeper than the public index)` : "";
				violations.launderedCrossImports.push({
					file: rel,
					line: edge.line,
					message: `Same-layer cross-slice ${kind}: ${srcLayer}/${srcSlice} → ${t.layer}/${t.slice} (specifier "${edge.spec}")${deepNote}${launderedVia ? ` laundered via ${relative(srcPath, launderedVia).replace(/\\/g, "/")}` : ""}`,
					severity: "critical",
					suggestion: `Sibling slices on the same layer must stay independent. Remove this edge: (a) compose both slices from a higher layer (src/views/<page>/ or src/widgets/<w>/) passing data via props/render-props; or (b) push the shared logic down to src/entities/<x>/ (domain) or src/shared/lib/ (generic) and import that from both. ${deep && !t.isAtX ? "Even an allowed cross-import may use ONLY the slice's public index — never reach into model/api/lib/internal. " : ""}Do not launder via a shared/barrel/widget shim, import type, dynamic import(), require(), or @x (entities-only).`,
				});
			}
		}
	}
}

/**
 * Hardened circular-import graph (Riss-cross-imports-03 / Rref-public-api-03):
 * a slice-level graph that — unlike the legacy alias-only, @x-skipping
 * buildSliceImportGraph — includes @x edges, relative edges, dynamic
 * import()/require() edges, type-only edges, and one hop of re-export
 * laundering. Cycles found here that the legacy detector missed are reported
 * under circularImports (preserving that category for other batches).
 */
function checkHardenedCircularImports(allFiles: readonly string[]): void {
	const launderMap = batchBBuildLaunderMap(allFiles);
	const graph: SliceGraph = new Map();

	const addEdge = (from: string, to: string): void => {
		if (from === to) {
			return;
		}
		let set = graph.get(from);
		if (!set) {
			set = new Set();
			graph.set(from, set);
		}
		set.add(to);
	};

	for (const filePath of allFiles) {
		const fromId = getSliceId(filePath);
		if (!fromId) {
			continue;
		}
		const content = batchBReadFile(filePath);
		if (!content) {
			continue;
		}
		for (const edge of batchBExtractEdges(content)) {
			const t = batchBResolveTarget(edge.spec, filePath);
			if (t) {
				addEdge(fromId, `${t.layer}/${t.slice}`);
			}
			// laundering hop
			const spec = batchBNormalizeSpecifier(edge.spec);
			let candidate: string | null = null;
			for (const alias of BATCH_B_SRC_ALIASES) {
				if (spec.startsWith(alias)) {
					candidate = resolveAliasImport(spec.slice(alias.length));
					break;
				}
			}
			if (!candidate && (spec.startsWith("./") || spec.startsWith("../"))) {
				const abs = resolve(join(filePath, ".."), spec);
				candidate =
					[`${abs}.ts`, `${abs}.tsx`, join(abs, "index.ts"), join(abs, "index.tsx")].find((c) =>
						existsSync(c)
					) ?? null;
			}
			if (candidate) {
				const le = launderMap.get(candidate.replace(/\\/g, "/"));
				if (le) {
					for (const lt of le) {
						addEdge(fromId, `${lt.layer}/${lt.slice}`);
					}
				}
			}
		}
	}

	const cycles = detectSliceCycles(graph);
	if (cycles.length === 0) {
		return;
	}
	// Avoid double-reporting cycles the legacy checkCircularImports already
	// emitted (same normalized ring key).
	const existingKeys = new Set<string>();
	for (const v of violations.circularImports) {
		existingKeys.add(v.message);
	}
	for (const cycle of cycles) {
		const pretty = `${cycle.join(" -> ")} -> ${cycle[0]}`;
		const msg = `Circular import detected between slices: ${pretty}`;
		if (existingKeys.has(msg)) {
			continue;
		}
		violations.circularImports.push({
			file: cycle[0] ?? "unknown",
			message: `${msg} (includes @x / relative / dynamic / laundered edges)`,
			severity: "critical",
			suggestion:
				"Break the cycle: extract the symbols both directions need into a lower layer (src/entities/<domain>/model/ for domain, src/shared/lib/ for generic) and have BOTH slices import that single lower-layer module, or compose both from a higher layer. An @x re-export, a relative path, a dynamic import(), require(), import type, or a shared/-barrel re-export still counts as an edge — none of them break the cycle.",
		});
	}
}

// ===========================================================================
// Batch D — Framework boundaries (re-derived)
//   Ledgers: tech-electron.md, tech-router.md, tech-react-query.md,
//            iss-routes.md, skill.md (Rskill-08 hardening only)
//   Detectors: checkElectronBoundary, checkRouterPlacement,
//              checkReactQueryPlacement, checkRedirectOwnership (+ hardcodedUrls
//              hardening). Strictly additive; reuses the Batch B edge helpers.
// ===========================================================================

/** frontend/ root (sibling of src/, electron/). srcPath may be a fixture. */
const BATCH_D_FRONTEND_ROOT = join(srcPath, "..");
const BATCH_D_ELECTRON_DIR = join(BATCH_D_FRONTEND_ROOT, "electron");
// frontend/ now hosts per-window HTML files at its root (index.html,
// settings.html, overlay.html, tray-menu.html, model-picker.html,
// device-picker.html, onboarding.html) which Vite consumes as
// rollupOptions.input entries. Each pairs with a src/entries/<name>.tsx
// bootstrap (createRoot + render of an app-layer-composed views/<view>/
// page). There is no router framework on disk after the Vite migration —
// no Next.js app/, no Next.js pages/, no react-router routes.tsx — so the
// old project-root `app/` and `pages/` Next-era guards have been removed.
// The remaining router-shaped-file detector below (BATCH_D_ROUTER_BASENAMES)
// still defends against page.tsx / layout.tsx / route.ts / (group)/ / [param]/
// drifting INTO src/, which would re-introduce routing intent inside FSD
// business layers regardless of which bundler we use.

const BATCH_D_SCANNED_EXTS = [
	".ts",
	".tsx",
	".js",
	".jsx",
	".mts",
	".cts",
	".mjs",
	".cjs",
] as const;

/** Recursively collect files (any extension in `exts`, default Batch D set). */
async function batchDCollect(
	dir: string,
	exts: readonly string[] = BATCH_D_SCANNED_EXTS,
	out: string[] = []
): Promise<string[]> {
	let entries: Dirent[];
	try {
		entries = await readdir(dir, { withFileTypes: true, encoding: "utf8" });
	} catch {
		return out;
	}
	for (const e of entries) {
		const full = join(dir, e.name);
		if (e.isDirectory()) {
			// Skip build/dependency artifacts. `dist-renderer/` is the current
			// Vite output (per frontend/vite.config.ts -> build.outDir);
			// `.next/` and `dist/` are kept as defensive skips in case any
			// legacy / nested package re-introduces a Next.js or generic
			// bundler output directory under the scan root.
			if (
				e.name === "node_modules" ||
				e.name === ".next" ||
				e.name === "dist" ||
				e.name === "dist-renderer"
			) {
				continue;
			}
			await batchDCollect(full, exts, out);
		} else if (e.isFile() && exts.some((x) => e.name.endsWith(x))) {
			out.push(full);
		}
	}
	return out;
}

function batchDPosix(p: string): string {
	return p.replace(/\\/g, "/");
}

/**
 * Resolve a module specifier from `fromFile` to an absolute path on disk,
 * honoring the project aliases (`@/` → src/, `@electron/` → electron/,
 * `@spec/` → ../spec/generated/ts/) and relative climbs. Returns the resolved
 * absolute path WITHOUT requiring the file to exist (callers test prefixes).
 */
function batchDResolveSpecAbs(spec: string, fromFile: string): string | null {
	const s = batchDPosix(batchBNormalizeSpecifier(spec));
	if (!s) {
		return null;
	}
	if (s.startsWith("@/")) {
		return batchDPosix(join(srcPath, s.slice(2)));
	}
	if (s.startsWith("@electron/")) {
		return batchDPosix(join(BATCH_D_ELECTRON_DIR, s.slice("@electron/".length)));
	}
	if (s.startsWith("@spec/")) {
		return batchDPosix(join(BATCH_D_FRONTEND_ROOT, "..", "spec", "generated", "ts", s.slice(6)));
	}
	if (s.startsWith("./") || s.startsWith("../")) {
		return batchDPosix(resolve(join(fromFile, ".."), s));
	}
	return null;
}

// Continuation specifier: a bare `} from "..."` / `from "..."` line that is
// the tail of a multi-line `import {\n ... \n} from "..."`. batchBExtractEdges
// is single-line and misses these (a real evasion the ledgers require closing
// — "parse ALL import specifiers"). This Batch D extractor adds them without
// mutating the shared Batch B helper other batches depend on.
const BATCH_D_CONTINUATION_FROM_RE = /^\s*\}?\s*from\s+['"]([^'"]+)['"]/;

/**
 * Batch-D edge extractor: every `batchBExtractEdges` edge PLUS continuation
 * `} from "..."` lines from multi-line imports/exports. Dedupes by (line,spec).
 */
function batchDExtractEdges(content: string): BatchBEdge[] {
	const edges = [...batchBExtractEdges(content)];
	const seen = new Set<string>(edges.map((e) => `${e.line}:${e.spec}`));
	const lines = content.split("\n");
	let inBlock = false;
	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i] ?? "";
		const trimmed = raw.trim();
		if (inBlock) {
			if (trimmed.includes("*/")) {
				inBlock = false;
			}
			continue;
		}
		if (trimmed.startsWith("/*")) {
			if (!trimmed.includes("*/")) {
				inBlock = true;
			}
			continue;
		}
		if (trimmed.startsWith("//") || trimmed.startsWith("*")) {
			continue;
		}
		const cm = raw.match(BATCH_D_CONTINUATION_FROM_RE);
		if (cm?.[1]) {
			const key = `${i + 1}:${cm[1]}`;
			if (!seen.has(key)) {
				seen.add(key);
				// Look back a few lines to classify type-only multi-line imports.
				const window = lines.slice(Math.max(0, i - 8), i + 1).join("\n");
				edges.push({
					spec: cm[1],
					line: i + 1,
					isTypeOnly: /\bimport\s+type\b|\bexport\s+type\b/.test(window),
					isDynamic: false,
					rawLine: trimmed,
				});
			}
		}
	}
	return edges;
}

/** Main-process-only Node builtins that must never appear in renderer src/. */
const BATCH_D_MAIN_ONLY_BUILTINS = new Set<string>([
	"electron",
	"node:child_process",
	"child_process",
	"node:fs",
	"fs",
	"node:fs/promises",
	"fs/promises",
	"node:os",
	"os",
]);

/**
 * Rule Relectron-01..05 — Electron process-boundary isolation.
 *
 * WinSTT keeps main/preload code in a sibling `electron/` dir and `src/` is
 * renderer-only FSD. The sanctioned cross-process contract is the narrow set
 * `src/shared/api/*`, `src/shared/config/*`, `src/shared/lib/*`, `src/electron.d.ts`
 * and `@spec/*`. Hard leaks: any `src/**` importing `electron`/`@electron/*`/the
 * `electron/` tree or a main-only Node builtin; any `electron/**` importing a
 * renderer FSD slice (`src/{views,widgets,features,entities}`) or renderer-only
 * `src/shared/{ui,i18n}`; `views`/`widgets`/`pages`/`screens` dirs or React in
 * `electron/`; and entry-point intersection (`main.ts`↔`preload.ts`↔`src/app`).
 *
 * No-ops cleanly when no `electron/` dir exists (so fixture trees without one
 * — and the renderer-only `--src` runs — never error).
 */
async function checkElectronBoundary(allSrcFiles: readonly string[]): Promise<void> {
	const hasElectron = existsSync(BATCH_D_ELECTRON_DIR);

	// --- (A) renderer src/ → main/preload (Relectron-01) -------------------
	for (const filePath of allSrcFiles) {
		if (isTestFile(filePath)) {
			continue;
		}
		const layer = getLayerFromPath(filePath);
		if (!layer) {
			continue;
		}
		const content = batchBReadFile(filePath);
		if (!content) {
			continue;
		}
		const rel = batchDPosix(relative(srcPath, filePath));
		for (const edge of batchDExtractEdges(content)) {
			const bare = batchDPosix(batchBNormalizeSpecifier(edge.spec));
			const isMainBuiltin = BATCH_D_MAIN_ONLY_BUILTINS.has(bare) || bare === "electron";
			const abs = batchDResolveSpecAbs(edge.spec, filePath);
			const intoElectron =
				bare.startsWith("@electron/") ||
				bare === "@electron" ||
				(abs != null && abs.startsWith(`${batchDPosix(BATCH_D_ELECTRON_DIR)}/`));
			if (!(isMainBuiltin || intoElectron)) {
				continue;
			}
			const kind = edge.isDynamic
				? "dynamic import()/require()"
				: edge.isTypeOnly
					? "type-only import"
					: "import";
			violations.electronBoundary.push({
				file: `src/${rel}`,
				importPath: edge.spec,
				line: edge.line,
				message: `Renderer code src/${rel} ${kind}s Electron main/preload "${edge.spec}" (${isMainBuiltin ? "main-only module/builtin" : "electron/ tree"}). Renderer must never reach the main process directly (Relectron-01).`,
				severity: "critical",
				suggestion:
					"Remove this import from the src/ file. To call the main process, use the exposed bridge only: window.electron.<channel>(...) (typed via src/electron.d.ts). For shared contract types, import the cross-process surface (@/shared/api/ipc-channels, @/shared/config/settings-schema, @/shared/lib/errors, or @spec/*) — never electron/ipc/*, electron/main*, electron/preload*, or a main-only Node builtin. Delete any @electron/* re-export from src/shared/.",
			});
		}
	}

	if (!hasElectron) {
		return;
	}

	const electronFiles = await batchDCollect(BATCH_D_ELECTRON_DIR);
	const electronRoot = batchDPosix(BATCH_D_ELECTRON_DIR);
	const srcRoot = batchDPosix(srcPath);

	// Sanctioned cross-process contract: only these src/ sub-trees may be
	// imported by electron/. Everything else under src/ is a renderer leak.
	const isSanctionedSrcContract = (absPosix: string): boolean => {
		if (!absPosix.startsWith(`${srcRoot}/`)) {
			return false;
		}
		const relFromSrc = absPosix.slice(srcRoot.length + 1);
		if (relFromSrc === "electron.d.ts" || relFromSrc.startsWith("electron.d")) {
			return true;
		}
		// shared/api, shared/config, shared/lib are process-neutral contract;
		// shared/ui and shared/i18n are renderer-only (hard leak).
		if (
			relFromSrc.startsWith("shared/api/") ||
			relFromSrc.startsWith("shared/config/") ||
			relFromSrc.startsWith("shared/lib/")
		) {
			return true;
		}
		return false;
	};

	// --- (B) electron/ → renderer FSD slices / renderer-only shared (R-02/04)
	for (const filePath of electronFiles) {
		if (isTestFile(filePath)) {
			continue;
		}
		const content = batchBReadFile(filePath);
		if (!content) {
			continue;
		}
		const rel = batchDPosix(relative(BATCH_D_FRONTEND_ROOT, filePath));
		for (const edge of batchDExtractEdges(content)) {
			const bare = batchDPosix(batchBNormalizeSpecifier(edge.spec));
			// Renderer-only third-party dragged into main (trick 6).
			if (bare === "react" || bare === "react-dom" || bare.startsWith("react-dom/")) {
				violations.electronBoundary.push({
					file: rel,
					importPath: edge.spec,
					line: edge.line,
					message: `Main/preload file ${rel} imports renderer-only "${edge.spec}". The main process must not pull React into its build graph (Relectron-02/04).`,
					severity: "critical",
					suggestion:
						"Remove this import. Tray/window UI driven from main belongs in renderer slices triggered via IPC, not React rendered in electron/. Use electron/lib/ helpers or send an IPC event through the preload bridge instead.",
				});
				continue;
			}
			const abs = batchDResolveSpecAbs(edge.spec, filePath);
			if (abs == null || !abs.startsWith(`${srcRoot}/`)) {
				continue;
			}
			if (isSanctionedSrcContract(abs)) {
				continue;
			}
			const relFromSrc = abs.slice(srcRoot.length + 1);
			const head = relFromSrc.split("/")[0] ?? "";
			let why: string;
			if (head === "shared") {
				why =
					"renderer-only shared segment (only shared/api, shared/config, shared/lib are the sanctioned cross-process contract)";
			} else if (["views", "widgets", "features", "entities"].includes(head)) {
				why = `renderer FSD slice (src/${head}/…)`;
			} else {
				why = "a non-contract renderer module";
			}
			const kind = edge.isDynamic
				? "dynamic import()/require()"
				: edge.isTypeOnly
					? "type-only import"
					: "import";
			violations.electronBoundary.push({
				file: rel,
				importPath: edge.spec,
				line: edge.line,
				message: `Main/preload file ${rel} ${kind}s ${why}: "${edge.spec}" → src/${relFromSrc}. Only the cross-process contract is public to both processes (Relectron-02/04).`,
				severity: "critical",
				suggestion: `Remove this import. The main process communicates with the renderer only via IPC events through the preload bridge, never by importing renderer modules. Move the logic into electron/lib/ (main-process helper) OR relocate the shared contract type into src/shared/{api,config,lib}/ or spec/openapi.yaml (run \`bun generate\` → @spec/*). A src/${head}/ slice import from electron/ is a hard cross-process leak — extract the pure logic you need into a process-neutral src/shared/lib/ module and import that instead.`,
			});
		}
	}

	// --- (C) views/widgets/pages/screens dirs inside electron/ (R-04a) -----
	const forbiddenMainLayerDirs = new Set(["views", "widgets", "pages", "screens"]);
	const seenDirViolations = new Set<string>();
	for (const filePath of electronFiles) {
		const relParts = batchDPosix(relative(BATCH_D_ELECTRON_DIR, filePath)).split("/");
		for (let i = 0; i < relParts.length - 1; i++) {
			const part = (relParts[i] ?? "").toLowerCase();
			if (forbiddenMainLayerDirs.has(part)) {
				const dirRel = `electron/${relParts.slice(0, i + 1).join("/")}`;
				if (!seenDirViolations.has(dirRel)) {
					seenDirViolations.add(dirRel);
					violations.electronBoundary.push({
						file: dirRel,
						message: `Main process directory ${dirRel}/ is a renderer UI layer ("${part}"). electron/ must not contain views/widgets/pages/screens layers (Relectron-04).`,
						severity: "critical",
						suggestion:
							"Delete/rename this folder. Renderer screen/tray/window UI lives in src/views|widgets/ slices and is driven from main only via IPC. The main process may host features/, entities/, shared-style helpers (electron/lib/) — never a UI layer.",
					});
				}
				break;
			}
		}
	}

	// --- (D) entry-point intersection (Relectron-05) -----------------------
	// Resolve real entry filenames from package.json `main`/electron config when
	// possible; fall back to the conventional names. Renderer entry = src/app/**.
	const entryCandidates = new Set<string>([
		batchDPosix(join(BATCH_D_ELECTRON_DIR, "main.ts")),
		batchDPosix(join(BATCH_D_ELECTRON_DIR, "preload.ts")),
		batchDPosix(join(BATCH_D_ELECTRON_DIR, "entry.ts")),
		batchDPosix(join(BATCH_D_ELECTRON_DIR, "bootstrap.ts")),
	]);
	const entryNoExt = new Set([...entryCandidates].map((c) => c.replace(/\.ts$/, "")));
	for (const filePath of electronFiles) {
		if (isTestFile(filePath)) {
			continue;
		}
		const p = batchDPosix(filePath);
		const isEntry = entryCandidates.has(p);
		const content = batchBReadFile(filePath);
		if (!content) {
			continue;
		}
		const rel = batchDPosix(relative(BATCH_D_FRONTEND_ROOT, filePath));
		// Distinct entry points this file imports (for trick 7: a non-entry
		// orchestrator like electron/ipc/relay.ts pulling BOTH main & preload).
		const importedEntries = new Set<string>();
		for (const edge of batchDExtractEdges(content)) {
			const abs = batchDResolveSpecAbs(edge.spec, filePath);
			if (abs == null) {
				continue;
			}
			const a = batchDPosix(abs);
			const aNoExt = a.replace(/\.ts$/, "");
			const targetsAnyEntry =
				([...entryCandidates].some((c) => c === a) || entryNoExt.has(aNoExt)) &&
				aNoExt !== p.replace(/\.ts$/, "");
			const targetsRendererAppEntry = a.startsWith(`${srcRoot}/app/`);
			if (targetsAnyEntry) {
				importedEntries.add(aNoExt);
			}
			// An ENTRY file importing another entry / the renderer bootstrap is
			// a direct Relectron-05 intersection (static, type-only, dynamic).
			if (isEntry && (targetsAnyEntry || targetsRendererAppEntry)) {
				violations.electronBoundary.push({
					file: rel,
					importPath: edge.spec,
					line: edge.line,
					message: `Process entry point ${rel} imports another entry point ("${edge.spec}"${targetsRendererAppEntry ? " — renderer src/app bootstrap" : ""}). main.ts, preload.ts and the renderer bootstrap must stay decoupled (Relectron-05).`,
					severity: "critical",
					suggestion:
						"Remove the import. Entry points communicate only through the immutable IPC contract (channel constants / @spec/* generated types) — never by importing each other (static, import type, or dynamic) and never via a shared mutable singleton module. Put cross-entry orchestration in electron/ipc/<feature>.ts registering handlers; each entry imports only the shared contract.",
				});
			}
			// A renderer src/app bootstrap importing an electron entry is caught
			// by section (A) (renderer→main); nothing extra needed here.
		}
		// Trick 7: a NON-entry file (e.g. electron/ipc/relay.ts) importing ≥2
		// distinct entry points is a cross-entry intersection point.
		if (!isEntry && importedEntries.size >= 2) {
			violations.electronBoundary.push({
				file: rel,
				message: `${rel} imports ≥2 distinct process entry points (${[...importedEntries].map((e) => batchDPosix(relative(BATCH_D_FRONTEND_ROOT, e))).join(", ")}). Cross-entry glue must not couple main↔preload directly (Relectron-05).`,
				severity: "critical",
				suggestion:
					"Do not import multiple entry points from one orchestrator. Each entry (electron/main.ts, electron/preload.ts) must talk only through the immutable IPC contract. Move cross-entry coordination into electron/ipc/<feature>.ts that registers handlers; have each entry import ONLY the shared channel constants / @spec/* types.",
			});
		}
	}
}

const BATCH_D_ROUTER_BASENAMES = new Set<string>([
	"page",
	"layout",
	"template",
	"default",
	"loading",
	"error",
	"global-error",
	"not-found",
	"route",
]);
const BATCH_D_ROUTE_GROUP_RE = /^\(.*\)$/;
const BATCH_D_DYNAMIC_SEG_RE = /^\[.*\]$/;

function batchDBasenameNoExt(name: string): string {
	return name.replace(/\.[^.]+$/, "");
}

/**
 * Rule Rtech-router-01/02 — routing concerns don't belong in FSD
 * business-domain layers. WinSTT no longer ships a router framework: the
 * Vite multi-page setup loads each Electron BrowserWindow's HTML directly
 * (file:// in prod, http://localhost:3000/<page>.html in dev), and each
 * HTML's <script> tag points at a single bootstrap in src/entries/. There
 * is no react-router, no Next App-Router, no Pages-Router. The FSD
 * invariant still stands, though: a file or directory named with router
 * conventions (page.tsx / layout.tsx / route.ts / route-group `(grp)/` /
 * dynamic `[param]/`) inside src/ signals that someone is about to leak
 * routing intent into entities/features/widgets/views, so we flag those
 * shapes defensively.
 *
 * Rule Rtech-router-02 also locks the layer name: WinSTT keeps FSD's
 * pages layer renamed to src/views/ (originally a Next.js Pages-Router
 * collision workaround; the rename stuck post the Vite migration because
 * flipping it back would churn every @/views/* import for zero
 * architectural gain). A `src/pages/` directory appearing alongside
 * `src/views/` would split the codebase between two equivalent layer
 * names; flag it so we keep one canonical home.
 *
 * The old `middleware.ts`/`instrumentation.ts` root-only check (Rtech-
 * router-04) and the Pages-Router `_app`/`_document` activation guard
 * were both Next-specific. They've been removed — no current bundler
 * picks those file names up specially.
 */
async function checkRouterPlacement(): Promise<void> {
	// (1) router-shaped files / route-group / dynamic-seg dirs under src/
	const srcAll = await batchDCollect(srcPath, [
		".ts",
		".tsx",
		".js",
		".jsx",
		".mjs",
		".cjs",
		".mts",
		".cts",
	]);
	const seenDir = new Set<string>();
	for (const filePath of srcAll) {
		const relPosix = batchDPosix(relative(srcPath, filePath));
		const parts = relPosix.split("/");
		const baseNoExt = batchDBasenameNoExt(parts[parts.length - 1] ?? "");

		// route-group `(grp)` / dynamic `[param]` dirs anywhere under src/
		for (let i = 0; i < parts.length - 1; i++) {
			const d = parts[i] ?? "";
			if (BATCH_D_ROUTE_GROUP_RE.test(d) || BATCH_D_DYNAMIC_SEG_RE.test(d)) {
				const dirRel = `src/${parts.slice(0, i + 1).join("/")}`;
				if (!seenDir.has(dirRel)) {
					seenDir.add(dirRel);
					violations.routerPlacement.push({
						file: dirRel,
						message: `Router-convention directory "${d}/" found under src/ (${dirRel}). Route-group / dynamic-segment naming belongs in a project-root router folder, never inside FSD business layers (Rtech-router-01).`,
						severity: "high",
						suggestion:
							"Rename the directory to a plain FSD slice name (no parens, no brackets). If you genuinely need router-driven routing, set it up at the project root (sibling of src/) and re-export the FSD view from there — never put routing concerns inside src/.",
					});
				}
			}
		}

		// reserved router basename inside src/, but NOT inside an FSD ui/ segment
		if (BATCH_D_ROUTER_BASENAMES.has(baseNoExt)) {
			const inUiSegment = parts.includes("ui");
			if (inUiSegment) {
				continue;
			}
			violations.routerPlacement.push({
				file: `src/${relPosix}`,
				message: `Router-shaped file "${parts[parts.length - 1]}" found under src/ (src/${relPosix}). Names like page.tsx / layout.tsx / route.ts encode routing intent and belong in a project-root router folder, not inside FSD layers (Rtech-router-01).`,
				severity: "high",
				suggestion:
					'Rename the file to something domain-named (e.g. SettingsView.tsx, settings-layout.tsx). If routing is genuinely required, build the router at the project root and have its files re-export FSD views via `export { <Slice>View as default } from "@/views/<slice>";`.',
			});
		}
	}

	// (2) src/pages/ — WinSTT uses src/views/ as the FSD pages layer. Having
	// both at once means imports get split between two equivalent homes.
	const srcPagesDir = join(srcPath, "pages");
	if (existsSync(srcPagesDir)) {
		violations.routerPlacement.push({
			file: "src/pages",
			message:
				"src/pages/ exists. WinSTT's FSD pages layer is renamed src/views/ (originally a Next.js Pages-Router workaround; the rename stuck post the Vite migration because flipping it back would churn every @/views/* import for zero architectural gain). Having both src/pages/ and src/views/ splits the codebase between two equivalent layer names (Rtech-router-02).",
			severity: "high",
			suggestion:
				"Pick one canonical home: either move the contents of src/pages/ into src/views/ and delete src/pages/, or commit to renaming the whole layer back to src/pages/ (touches every @/views/* import). Mixing both is the worst option. (Note: Vite-multi-page Electron does NOT need src/pages/ — each window's bootstrap lives in src/entries/<window>.tsx and composes a src/views/<view>/ page.)",
		});
	}
}

/**
 * Rule Rtech-react-query-01..08 — React Query placement.
 *
 * Query factories live in entities/<e>/api/ (or shared/api/queries/);
 * QueryClientProvider in src/app/providers/; new QueryClient() in
 * src/shared/api/; per-entity request fns as separate api/ files; mutations
 * not mixed into query factories; generated codegen under src/shared/api/.
 *
 * WinSTT currently uses no React Query, so this cleanly no-ops on the real
 * repo. All detection is path/structure based and only fires when the
 * corresponding React Query token actually appears.
 */
async function checkReactQueryPlacement(allSrcFiles: readonly string[]): Promise<void> {
	for (const filePath of allSrcFiles) {
		if (isTestFile(filePath)) {
			continue;
		}
		const content = batchBReadFile(filePath);
		if (!content) {
			continue;
		}
		const relPosix = batchDPosix(relative(srcPath, filePath));
		const parts = relPosix.split("/");
		const layer = parts[0] ?? "";
		const slice = parts[1] ?? "";
		const inEntities = layer === "entities";
		const apiIdx = parts.indexOf("api");
		const inApiSegment = apiIdx >= 0 && apiIdx >= 2;
		const inSharedApi = relPosix.startsWith("shared/api/");
		const inSharedApiQueries = relPosix.startsWith("shared/api/queries/");

		// R-04: QueryClientProvider element outside src/app/providers/
		if (/<QueryClientProvider[\s/>]/.test(content)) {
			const okProvider = relPosix.startsWith("app/providers/");
			if (!okProvider) {
				violations.reactQueryPlacement.push({
					file: `src/${relPosix}`,
					message: `<QueryClientProvider> rendered outside src/app/providers/ (src/${relPosix}). The React Query provider must live at src/app/providers/query-provider.tsx (Rtech-react-query-04).`,
					severity: "high",
					suggestion:
						"Move the provider into the app layer: src/app/providers/query-provider.tsx exporting `export const QueryProvider = ({ client, children }) => (<QueryClientProvider client={client}>{children}</QueryClientProvider>);`. Consume it only from the app bootstrap. Do not render <QueryClientProvider> in shared/, a widget/feature/entity, or a page/view — and do not re-export it from app/providers/ while the implementation stays lower.",
				});
			}
		}

		// R-05: new QueryClient( outside src/shared/api/
		if (/\bnew\s+QueryClient\s*\(/.test(content)) {
			if (!inSharedApi) {
				violations.reactQueryPlacement.push({
					file: `src/${relPosix}`,
					message: `new QueryClient() instantiated outside src/shared/api/ (src/${relPosix}). The singleton QueryClient must be created in src/shared/api/query-client.ts (Rtech-react-query-05).`,
					severity: "high",
					suggestion:
						"Move it to src/shared/api/query-client.ts: `export const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 5 * 60 * 1000, gcTime: 5 * 60 * 1000 } } });` and import it into src/app/providers/query-provider.tsx. Do not call new QueryClient( in the provider, app entry, a page/view, a feature/entity, or hide it behind a factory defined outside shared/api/.",
				});
			}
		}
		// R-05 evasion 4: createQueryClient/makeQueryClient factory outside shared/api
		if (
			/\b(createQueryClient|makeQueryClient)\b/.test(content) &&
			/\bnew\s+QueryClient\s*\(/.test(content) &&
			!inSharedApi
		) {
			// already covered by the new QueryClient check above; skip dup push
		}

		// R-01/02/03: query factory + mutation placement
		const hasQueryOptions = /\bqueryOptions\s*\(/.test(content);
		const exportsQueriesSym = /export\s+const\s+\w*[Qq]ueries\b/.test(content);
		const hasQueryFactory = hasQueryOptions || exportsQueriesSym;
		if (hasQueryFactory) {
			const okPlacement =
				(inEntities && inApiSegment) || inSharedApiQueries || relPosix.startsWith("shared/api/");
			const okStrict = (inEntities && inApiSegment) || inSharedApiQueries;
			if (!okPlacement) {
				violations.reactQueryPlacement.push({
					file: `src/${relPosix}`,
					message: `React Query query factory found outside an entity api/ segment or shared/api/queries/ (src/${relPosix}, layer=${layer}). Query factories belong in src/entities/<e>/api/<e>.queries.ts or src/shared/api/queries/ (Rtech-react-query-01).`,
					severity: "high",
					suggestion:
						'Move the query factory into the api/ segment of its owning entity: src/entities/<entity>/api/<entity>.queries.ts exporting `export const <entity>Queries = { all: () => ["<entity>"], list: (...) => queryOptions({ queryKey, queryFn }) }`, re-export it from the slice index.ts (named, no export *). If it does not belong to one entity, put it at src/shared/api/queries/<name>.ts and re-export from src/shared/api/index.ts. Never keep query factories in model/, lib/, ui/, a page/view, or a features/widgets slice.',
				});
			} else if (relPosix.startsWith("shared/api/") && !inSharedApiQueries && !okStrict) {
				violations.reactQueryPlacement.push({
					file: `src/${relPosix}`,
					message: `Query factory under shared/api/ but not in the queries/ subfolder (src/${relPosix}). It must be src/shared/api/queries/<name>.ts (Rtech-react-query-01).`,
					severity: "high",
					suggestion:
						'Move it to src/shared/api/queries/<name>.ts and add `export { <name>Queries } from "./queries/<name>";` to src/shared/api/index.ts. Do not define the factory inline in shared/api/index.ts.',
				});
			}
			// R-02: mutation mixed into the query factory
			if (/\buseMutation\s*\(/.test(content) || /\bmutationFn\s*:/.test(content)) {
				violations.reactQueryPlacement.push({
					file: `src/${relPosix}`,
					message: `Mutation (useMutation/mutationFn) mixed into a file that also defines a React Query query factory (src/${relPosix}). Mutations must not be mixed with queries (Rtech-react-query-02).`,
					severity: "high",
					suggestion:
						"Remove the mutation from the query factory. Put it in a dedicated hook in the api/ segment of the feature that uses it: src/features/<feature>/api/use-<action>.ts exporting `export const use<Action> = () => { const qc = useQueryClient(); return useMutation({ mutationFn, onSuccess }); };`. Alternatively put a plain async mutation fn in src/entities/<entity>/api/<action>.ts and call useMutation in the component. Never place a mutation hook in model/, lib/, or an entity ui/.",
				});
			}
		}

		// R-02: useMutation defined outside an api/ segment, or in entity ui/
		if (/\buseMutation\s*\(/.test(content) && !hasQueryFactory) {
			const inEntityUi = inEntities && parts.includes("ui");
			if (inEntityUi) {
				violations.reactQueryPlacement.push({
					file: `src/${relPosix}`,
					message: `useMutation called inside an entity ui/ component (src/${relPosix}). Entity UI must be render-only; mutations belong in a feature api/ hook (Rtech-react-query-02).`,
					severity: "high",
					suggestion:
						"Move the mutation into src/features/<feature>/api/use-<action>.ts. Entity ui/ components must be dumb/render-only — pass the mutation result/handlers down as props from the feature/view that owns the interaction.",
				});
			} else if (
				!inApiSegment &&
				(layer === "features" || layer === "widgets" || layer === "views" || inEntities) &&
				slice &&
				/\bexport\s+(?:async\s+)?(?:function|const)\s+use[A-Z]/.test(content)
			) {
				violations.reactQueryPlacement.push({
					file: `src/${relPosix}`,
					message: `A use* hook calling useMutation is defined outside an api/ segment (src/${relPosix}, layer=${layer}). Mutation hooks belong in the api/ segment near the place of use (Rtech-react-query-02).`,
					severity: "high",
					suggestion:
						"Move the mutation hook into the slice's api/ segment: src/features/<feature>/api/use-<action>.ts. Do not define mutation hooks in model/ or lib/.",
				});
			}
		}

		// R-03: per-entity request file outside the entity api/ segment, or
		// a CRUD god request-file (≥3 verbs in one entity api/ file).
		const fileBase = batchDBasenameNoExt(basename(filePath));
		if (inEntities && slice && /^(get|create|update|delete|fetch|list)-[\w-]+$/.test(fileBase)) {
			if (!inApiSegment) {
				violations.reactQueryPlacement.push({
					file: `src/${relPosix}`,
					message: `Entity request-function file "${basename(filePath)}" is not in the entity api/ segment (src/${relPosix}). get/create/update/delete-<entity> files belong in src/entities/<entity>/api/ (Rtech-react-query-03).`,
					severity: "high",
					suggestion:
						"Move it to src/entities/<entity>/api/<name>.ts (one async request function per file), referenced by the query factory's queryFn. Keep DTOs/mappers next to it. Do not put request functions in model/, lib/, a page/view, or a CRUD god-file.",
				});
			}
		}
		if (inEntities && slice && inApiSegment) {
			const verbHits = ["get", "create", "update", "delete"].filter((v) =>
				new RegExp(`export\\s+(?:async\\s+)?(?:function|const)\\s+${v}[A-Z]`).test(content)
			);
			if (verbHits.length >= 3) {
				violations.reactQueryPlacement.push({
					file: `src/${relPosix}`,
					message: `Entity api/ file exports ≥3 CRUD verbs (${verbHits.join(", ")}) — a CRUD god request-file (src/${relPosix}) (Rtech-react-query-03).`,
					severity: "high",
					suggestion:
						"Split into one file per request: src/entities/<entity>/api/get-<entity>.ts, create-<entity>.ts, update-<entity>.ts, delete-<entity>.ts — each exporting a single async function.",
				});
			}
		}

		// R-08: generated codegen (banner OR openapi-typescript shape) outside
		// src/shared/api/
		const first8 = content.split("\n").slice(0, 8).join("\n");
		// Strong codegen banner only — anchored phrases real codegen tools emit.
		// A bare prose mention of "auto-generated" in a doc comment (e.g.
		// "Mirrors X's auto-generated table") must NOT trip this.
		const hasGenBanner =
			/\bopenapi-typescript\b/i.test(first8) ||
			/\borval\b/i.test(first8) ||
			/@generated\b/.test(first8) ||
			/\bThis file (?:was|is) (?:auto[- ]?generated|generated)\b/i.test(first8) ||
			/\bdo not (?:edit|modify) (?:this file )?(?:manually|by hand)\b/i.test(first8) ||
			/eslint-disable\b[\s\S]*\bauto-generated\b/i.test(first8);
		// Banner-independent structural signal: openapi-typescript output shape.
		const hasOpenapiShape =
			/\bexport\s+(interface|type)\s+paths\b/.test(content) &&
			/\bexport\s+(interface|type)\s+components\b/.test(content);
		if (hasGenBanner || hasOpenapiShape) {
			if (!inSharedApi) {
				violations.reactQueryPlacement.push({
					file: `src/${relPosix}`,
					message: `Generated API code (codegen banner / openapi-typescript paths|components shape) found outside src/shared/api/ (src/${relPosix}) (Rtech-react-query-08).`,
					severity: "medium",
					suggestion:
						'Configure your codegen tool\'s output to src/shared/api/ (e.g. src/shared/api/<spec-name>/) and re-export the needed surface from src/shared/api/index.ts. Do not hand-place or generate OpenAPI client code, interface paths, or components["schemas"] inside an entity/feature/widget/page, and do not strip the auto-generated banner.',
				});
			}
		}
	}
}

const BATCH_D_REDIRECT_NAV_RE =
	/\b(useRouter|useNavigate|redirect|next\/navigation|react-router)\b/;
const BATCH_D_NAV_CALL_RE = /\b(redirect|navigate|push|replace)\s*\(/;
const BATCH_D_ROUTE_LITERAL_RE = /['"`]\/(?!\/)[^'"`\s]*/;

/**
 * Rule Riss-routes-02 — Redirect/route-decision ownership (ADVISORY).
 *
 * Not statically decidable (injected-callback vs lower-layer decision is
 * intent). Emits a LOW advisory for files under entities/features/widgets
 * that BOTH import a router/navigation API AND contain conditional logic
 * feeding a navigation call — flagged for human review, never a hard fail.
 */
async function checkRedirectOwnership(allSrcFiles: readonly string[]): Promise<void> {
	for (const filePath of allSrcFiles) {
		if (isTestFile(filePath)) {
			continue;
		}
		const layer = getLayerFromPath(filePath);
		if (!(layer === "entities" || layer === "features" || layer === "widgets")) {
			continue;
		}
		const content = batchBReadFile(filePath);
		if (!content) {
			continue;
		}
		if (!BATCH_D_REDIRECT_NAV_RE.test(content)) {
			continue;
		}
		const hasNavCall = BATCH_D_NAV_CALL_RE.test(content);
		const hasConditional = /\bif\s*\(|\?\s*[^:]+:|&&|\|\|/.test(content);
		if (!(hasNavCall && hasConditional)) {
			continue;
		}
		const relPosix = batchDPosix(relative(srcPath, filePath));
		violations.redirectOwnership.push({
			file: `src/${relPosix}`,
			message: `Possible redirect-logic-in-lower-layer: src/${relPosix} (layer=${layer}) imports a router/navigation API AND contains conditional logic feeding a navigation call. Verify the route is INJECTED via props/callback, not decided here (Riss-routes-02, advisory).`,
			severity: "low",
			suggestion:
				"If this file decides where/whether to redirect, lift that decision into the owning page at src/views/<page>/ (or src/app/ for app-wide redirects). Have the page pass a ready-to-call handler down: `const onDone = () => router.push(ROUTES.dashboard); <Form onDone={onDone} />`. This src/{entities|features|widgets}/ file should only invoke the injected callback (props.onDone()) and contain no destination-selection logic. Route constants live in src/shared/routes/; the decision lives in src/views//src/app/. (Advisory — confirm it is injected before acting.)",
		});
	}
}

/**
 * Harden the existing `hardcodedUrls` category for the iss-routes / Rskill-08
 * gaps the ledgers list:
 *  - GAP A: redirect("/x") / redirect(`/x`)
 *  - GAP B: aliased router calls — const nav = useNavigate(); nav("/x")
 *  - GAP C: src/shared/ slice-level routing logic now scanned
 *  - renamed nav props: dest/destination/targetHref/goTo
 *  - the `shared/routes` substring allowlist hole → require an import/require
 *    specifier ending in shared/routes (not a mere substring on the line).
 * Additive: only PUSHES new findings into violations.hardcodedUrls; never
 * removes or mutates the surviving detector's output.
 */
async function checkHardcodedUrlsBatchDHardening(allSrcFiles: readonly string[]): Promise<void> {
	const scopedLayers = new Set(["entities", "features", "widgets", "shared"]);
	const redirectCallRe = /\bredirect\s*\(\s*[`'"]\/(?!\/)[^`'"]+[`'"]/;
	const redirectTplRe = /\bredirect\s*\(\s*`\/(?!\/)[^`]*`/;
	const renamedPropRe = /\b(dest|destination|targetHref|goTo)\s*=\s*[{]?\s*[`'"]\/(?!\/)[^`'"]+/;
	const aliasDeclRe =
		/\bconst\s+(\w+)\s*=\s*(?:useNavigate\s*\(\s*\)|useRouter\s*\(\s*\)\s*\.\s*(?:push|replace)|router\s*\.\s*(?:push|replace))/g;
	for (const filePath of allSrcFiles) {
		if (isTestFile(filePath)) {
			continue;
		}
		const layer = getLayerFromPath(filePath);
		if (!layer || !scopedLayers.has(layer)) {
			continue;
		}
		const content = batchBReadFile(filePath);
		if (!content) {
			continue;
		}
		const relPosix = batchDPosix(relative(srcPath, filePath));
		const lines = content.split("\n");

		// Tighten the shared/routes allowlist: a line is allowlisted ONLY if
		// the FILE actually imports from a specifier ending in `shared/routes`.
		const importsSharedRoutes = batchDExtractEdges(content).some((e) => {
			const s = batchBNormalizeSpecifier(e.spec).replace(/\\/g, "/");
			return s.endsWith("shared/routes") || s.includes("shared/routes/");
		});

		// Resolve simple `const nav = useNavigate()` / router.push aliases.
		const aliasNames = new Set<string>();
		let m: RegExpExecArray | null;
		aliasDeclRe.lastIndex = 0;
		m = aliasDeclRe.exec(content);
		while (m) {
			if (m[1]) {
				aliasNames.add(m[1]);
			}
			m = aliasDeclRe.exec(content);
		}

		for (let i = 0; i < lines.length; i++) {
			const raw = lines[i] ?? "";
			const trimmed = raw.trim();
			if (trimmed.startsWith("//") || trimmed.startsWith("*")) {
				continue;
			}
			if (IMPORT_STATEMENT_REGEX.test(trimmed) || EXPORT_FROM_STATEMENT_REGEX.test(trimmed)) {
				continue;
			}

			let matchKind: string | null = null;
			if (redirectCallRe.test(raw) || redirectTplRe.test(raw)) {
				matchKind = 'redirect("/...") server/client redirect';
			} else if (renamedPropRe.test(raw)) {
				matchKind = "renamed navigation prop (dest/destination/targetHref/goTo) with a /-route";
			} else {
				for (const alias of aliasNames) {
					const callRe = new RegExp(`\\b${alias}\\s*\\(\\s*[\`'"]\\/(?!\\/)[^\`'"]+`);
					const callTplRe = new RegExp(`\\b${alias}\\s*\\(\\s*\`\\/(?!\\/)[^\`]*`);
					if (callRe.test(raw) || callTplRe.test(raw)) {
						matchKind = `aliased navigation call ${alias}("/...")`;
						break;
					}
				}
			}
			if (!matchKind) {
				continue;
			}
			// shared/routes allowlist — but ONLY honor it when the file truly
			// imports from a shared/routes specifier (defeats the comment /
			// bare-substring evasion the ledger calls out).
			if (importsSharedRoutes && /shared\/routes/.test(raw)) {
				continue;
			}
			const litMatch = raw.match(BATCH_D_ROUTE_LITERAL_RE);
			const literal = litMatch ? litMatch[0].replace(/^['"`]/, "") : "/…";
			violations.hardcodedUrls.push({
				file: `src/${relPosix}`,
				line: i + 1,
				message: `Hardcoded route below the pages layer via ${matchKind} ("${literal}") in src/${relPosix} (layer=${layer}). Layers below views/ must be URL-agnostic (Riss-routes-01 / Rskill-08).`,
				severity: "high",
				suggestion:
					'Move this route literal out of the lower layer. (1) Add it to the centralized registry src/shared/routes/ (e.g. `export const ROUTES = { login: "/login", post: (id: string) => `/post/${id}` } as const;`). (2) In the owning page src/views/<page>/ui/<Page>.tsx compute the URL from ROUTES and pass it down as a prop. (3) This src/{entities|features|widgets|shared}/ file must accept the route via props/factory and contain no `/...` literal, redirect(), router.push/replace, navigate(), or aliased nav call. Only src/views/ and src/app/ own URLs and redirect logic.',
			});
		}
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
		violations.nonCanonicalLayers.length +
		violations.nonCanonicalSegments.length +
		violations.segmentAsSlice.length +
		violations.scatteredDomain.length +
		violations.reservedTermNaming.length +
		violations.sharedNameMirrorsSlice.length +
		violations.godSlices.length +
		violations.insignificantSlices.length +
		violations.excessiveSlicing.length +
		violations.atxMisuse.length +
		violations.indexTheater.length +
		violations.launderedCrossImports.length +
		violations.sharedAggregateImports.length +
		violations.sliceGroupCode.length +
		violations.crudInEntities.length +
		violations.authInEntities.length +
		violations.localDtoInEntities.length +
		violations.misplacedDtoMapper.length +
		violations.misplacedTypes.length +
		violations.httpClientOutsideShared.length +
		violations.misplacedApiRequest.length +
		violations.sharedQueryKeys.length +
		violations.genericFeatureName.length +
		violations.featureInfraSmuggling.length +
		violations.multiPurposeFeature.length +
		violations.authInPageWidget.length +
		violations.authPagePairing.length +
		violations.electronBoundary.length +
		violations.routerPlacement.length +
		violations.reactQueryPlacement.length +
		violations.redirectOwnership.length;

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
		nonCanonicalLayers: violations.nonCanonicalLayers.length,
		nonCanonicalSegments: violations.nonCanonicalSegments.length,
		segmentAsSlice: violations.segmentAsSlice.length,
		scatteredDomain: violations.scatteredDomain.length,
		reservedTermNaming: violations.reservedTermNaming.length,
		sharedNameMirrorsSlice: violations.sharedNameMirrorsSlice.length,
		godSlices: violations.godSlices.length,
		insignificantSlices: violations.insignificantSlices.length,
		excessiveSlicing: violations.excessiveSlicing.length,
		atxMisuse: violations.atxMisuse.length,
		indexTheater: violations.indexTheater.length,
		launderedCrossImports: violations.launderedCrossImports.length,
		sharedAggregateImports: violations.sharedAggregateImports.length,
		sliceGroupCode: violations.sliceGroupCode.length,
		crudInEntities: violations.crudInEntities.length,
		authInEntities: violations.authInEntities.length,
		localDtoInEntities: violations.localDtoInEntities.length,
		misplacedDtoMapper: violations.misplacedDtoMapper.length,
		misplacedTypes: violations.misplacedTypes.length,
		httpClientOutsideShared: violations.httpClientOutsideShared.length,
		misplacedApiRequest: violations.misplacedApiRequest.length,
		sharedQueryKeys: violations.sharedQueryKeys.length,
		genericFeatureName: violations.genericFeatureName.length,
		featureInfraSmuggling: violations.featureInfraSmuggling.length,
		multiPurposeFeature: violations.multiPurposeFeature.length,
		authInPageWidget: violations.authInPageWidget.length,
		authPagePairing: violations.authPagePairing.length,
		electronBoundary: violations.electronBoundary.length,
		routerPlacement: violations.routerPlacement.length,
		reactQueryPlacement: violations.reactQueryPlacement.length,
		redirectOwnership: violations.redirectOwnership.length,
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
		...violations.nonCanonicalLayers,
		...violations.nonCanonicalSegments,
		...violations.segmentAsSlice,
		...violations.scatteredDomain,
		...violations.reservedTermNaming,
		...violations.sharedNameMirrorsSlice,
		...violations.godSlices,
		...violations.insignificantSlices,
		...violations.excessiveSlicing,
		...violations.atxMisuse,
		...violations.indexTheater,
		...violations.launderedCrossImports,
		...violations.sharedAggregateImports,
		...violations.sliceGroupCode,
		...violations.crudInEntities,
		...violations.authInEntities,
		...violations.localDtoInEntities,
		...violations.misplacedDtoMapper,
		...violations.misplacedTypes,
		...violations.httpClientOutsideShared,
		...violations.misplacedApiRequest,
		...violations.sharedQueryKeys,
		...violations.genericFeatureName,
		...violations.featureInfraSmuggling,
		...violations.multiPurposeFeature,
		...violations.authInPageWidget,
		...violations.authPagePairing,
		...violations.electronBoundary,
		...violations.routerPlacement,
		...violations.reactQueryPlacement,
		...violations.redirectOwnership,
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
		...violations.atxMisuse.map((v) => ({
			...v,
			category: "@x Cross-Import Misuse",
		})),
		...violations.indexTheater.map((v) => ({
			...v,
			category: "Public-API Index Theater",
		})),
		...violations.launderedCrossImports.map((v) => ({
			...v,
			category: "Laundered / Deep Cross-Slice Imports",
		})),
		...violations.sharedAggregateImports.map((v) => ({
			...v,
			category: "Shared Aggregate Mega-Barrel",
		})),
		...violations.sliceGroupCode.map((v) => ({
			...v,
			category: "Slice-Group Folder Code",
		})),
		...violations.crudInEntities.map((v) => ({
			...v,
			category: "CRUD/Data-Access in Entities",
		})),
		...violations.authInEntities.map((v) => ({
			...v,
			category: "Authentication Data in Entities",
		})),
		...violations.localDtoInEntities.map((v) => ({
			...v,
			category: "Local Backend DTO in Entities",
		})),
		...violations.misplacedDtoMapper.map((v) => ({
			...v,
			category: "DTO/Mapper Outside api/ Segment",
		})),
		...violations.misplacedTypes.map((v) => ({
			...v,
			category: "Misplaced Types / types Segment",
		})),
		...violations.httpClientOutsideShared.map((v) => ({
			...v,
			category: "HTTP Client Outside shared/api",
		})),
		...violations.misplacedApiRequest.map((v) => ({
			...v,
			category: "Misplaced API Request",
		})),
		...violations.sharedQueryKeys.map((v) => ({
			...v,
			category: "Cross-Slice Shared Query Keys",
		})),
		...violations.genericFeatureName.map((v) => ({
			...v,
			category: "Generic/Technical Feature Name",
		})),
		...violations.featureInfraSmuggling.map((v) => ({
			...v,
			category: "Infrastructure Smuggled in Feature",
		})),
		...violations.multiPurposeFeature.map((v) => ({
			...v,
			category: "Multi-Purpose / God Feature Slice",
		})),
		...violations.authInPageWidget.map((v) => ({
			...v,
			category: "Auth Store in Page/Widget",
		})),
		...violations.authPagePairing.map((v) => ({
			...v,
			category: "Auth Page Pairing / Duplicate Login UI",
		})),
		// Batch D — Framework boundaries
		...violations.electronBoundary.map((v) => ({
			...v,
			category: "Electron Process-Boundary Violation",
		})),
		...violations.routerPlacement.map((v) => ({
			...v,
			category: "Router Placement / Purity",
		})),
		...violations.reactQueryPlacement.map((v) => ({
			...v,
			category: "React-Query Factory/Client/Provider Placement",
		})),
		...violations.redirectOwnership.map((v) => ({
			...v,
			category: "Redirect/Route-Decision Ownership (advisory)",
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
	console.log(`  Non-Canonical Layers:  ${violations.summary.byCategory.nonCanonicalLayers}`);
	console.log(`  Non-Canonical Segments:${violations.summary.byCategory.nonCanonicalSegments}`);
	console.log(`  Segment-As-Slice:      ${violations.summary.byCategory.segmentAsSlice}`);
	console.log(`  Scattered Domain:      ${violations.summary.byCategory.scatteredDomain}`);
	console.log(`  Reserved-Term Naming:  ${violations.summary.byCategory.reservedTermNaming}`);
	console.log(`  Shared Mirrors Slice:  ${violations.summary.byCategory.sharedNameMirrorsSlice}`);
	console.log(`  God Slices:            ${violations.summary.byCategory.godSlices}`);
	console.log(`  Insignificant Slices:  ${violations.summary.byCategory.insignificantSlices}`);
	console.log(`  Excessive Slicing:     ${violations.summary.byCategory.excessiveSlicing}`);
	console.log(`  @x Cross-Import Misuse:${violations.summary.byCategory.atxMisuse}`);
	console.log(`  Public-API Theater:    ${violations.summary.byCategory.indexTheater}`);
	console.log(`  Laundered X-Imports:   ${violations.summary.byCategory.launderedCrossImports}`);
	console.log(`  Shared Mega-Barrel:    ${violations.summary.byCategory.sharedAggregateImports}`);
	console.log(`  Slice-Group Code:      ${violations.summary.byCategory.sliceGroupCode}`);
	console.log(`  CRUD in Entities:      ${violations.summary.byCategory.crudInEntities}`);
	console.log(`  Auth in Entities:      ${violations.summary.byCategory.authInEntities}`);
	console.log(`  Local DTO in Entities: ${violations.summary.byCategory.localDtoInEntities}`);
	console.log(`  DTO/Mapper Misplaced:  ${violations.summary.byCategory.misplacedDtoMapper}`);
	console.log(`  Misplaced Types:       ${violations.summary.byCategory.misplacedTypes}`);
	console.log(`  HTTP Client !shared:   ${violations.summary.byCategory.httpClientOutsideShared}`);
	console.log(`  Misplaced API Request: ${violations.summary.byCategory.misplacedApiRequest}`);
	console.log(`  Shared Query Keys:     ${violations.summary.byCategory.sharedQueryKeys}`);
	console.log(`  Generic Feature Name:  ${violations.summary.byCategory.genericFeatureName}`);
	console.log(`  Feature Infra Smuggle: ${violations.summary.byCategory.featureInfraSmuggling}`);
	console.log(`  Multi-Purpose Feature: ${violations.summary.byCategory.multiPurposeFeature}`);
	console.log(`  Auth in Page/Widget:   ${violations.summary.byCategory.authInPageWidget}`);
	console.log(`  Auth Page Pairing:     ${violations.summary.byCategory.authPagePairing}`);
	console.log(`  Electron Boundary:     ${violations.summary.byCategory.electronBoundary}`);
	console.log(`  Router Placement:     ${violations.summary.byCategory.routerPlacement}`);
	console.log(`  React-Query Placement: ${violations.summary.byCategory.reactQueryPlacement}`);
	console.log(`  Redirect Ownership:    ${violations.summary.byCategory.redirectOwnership}`);

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

	// Batch A: Non-Canonical Top-Level Layers
	if (violations.nonCanonicalLayers.length > 0) {
		console.log("\n\n  HIGH: Non-Canonical / Ad-Hoc Top-Level Layers");
		console.log("=".repeat(80));
		for (let i = 0; i < violations.nonCanonicalLayers.length; i++) {
			const v = violations.nonCanonicalLayers[i];
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

	// Batch A: Non-Canonical Segment Names / Generic Folders
	if (violations.nonCanonicalSegments.length > 0) {
		console.log("\n\n  HIGH: Non-Canonical Segment Names / Generic Folders");
		console.log("=".repeat(80));
		const toShow = violations.nonCanonicalSegments.slice(0, 30);
		for (let i = 0; i < toShow.length; i++) {
			const v = toShow[i];
			if (!v) {
				continue;
			}
			console.log(`\n${i + 1}. ${v.file}`);
			console.log(`   ${v.message}`);
			if (v.suggestion) {
				console.log(`    ${v.suggestion}`);
			}
		}
		if (violations.nonCanonicalSegments.length > 30) {
			console.log(`\n... and ${violations.nonCanonicalSegments.length - 30} more`);
		}
	}

	// Batch A: Segment Placed Directly Under Sliced Layer (no slice)
	if (violations.segmentAsSlice.length > 0) {
		console.log("\n\n  HIGH: Segment / Loose File Directly Under Sliced Layer");
		console.log("=".repeat(80));
		for (let i = 0; i < violations.segmentAsSlice.length; i++) {
			const v = violations.segmentAsSlice[i];
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

	// Batch A: Scattered Domain (package-by-layer)
	if (violations.scatteredDomain.length > 0) {
		console.log("\n\n  MEDIUM: Domain Scattered Across Generic Folders");
		console.log("=".repeat(80));
		for (let i = 0; i < violations.scatteredDomain.length; i++) {
			const v = violations.scatteredDomain[i];
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

	// Eyeball heuristic: shared/ module name mirrors a feature/widget slice (advisory)
	if (violations.sharedNameMirrorsSlice.length > 0) {
		console.log("\n\nℹ  LOW: shared/ Module Mirrors a Feature/Widget Slice (advisory)");
		console.log("=".repeat(80));
		const toShow = violations.sharedNameMirrorsSlice.slice(0, 20);
		for (let i = 0; i < toShow.length; i++) {
			const v = toShow[i];
			if (!v) {
				continue;
			}
			console.log(`\n${i + 1}. ${v.file}`);
			console.log(`   ${v.message}`);
			if (v.suggestion) {
				console.log(`    ${v.suggestion}`);
			}
		}
		if (violations.sharedNameMirrorsSlice.length > 20) {
			console.log(`\n... and ${violations.sharedNameMirrorsSlice.length - 20} more`);
		}
	}

	// Batch A: Reserved FSD-Term Slice/File Naming (advisory)
	if (violations.reservedTermNaming.length > 0) {
		console.log("\n\nℹ  LOW: Reserved FSD-Term Slice/File Naming (advisory)");
		console.log("=".repeat(80));
		const toShow = violations.reservedTermNaming.slice(0, 20);
		for (let i = 0; i < toShow.length; i++) {
			const v = toShow[i];
			if (!v) {
				continue;
			}
			console.log(`\n${i + 1}. ${v.file}`);
			console.log(`   ${v.message}`);
			if (v.suggestion) {
				console.log(`    ${v.suggestion}`);
			}
		}
		if (violations.reservedTermNaming.length > 20) {
			console.log(`\n... and ${violations.reservedTermNaming.length - 20} more`);
		}
	}

	// Batch B: @x Cross-Import Misuse
	if (violations.atxMisuse.length > 0) {
		console.log("\n\n CRITICAL: @x Cross-Import Misuse");
		console.log("=".repeat(80));
		const toShow = violations.atxMisuse.slice(0, 40);
		for (let i = 0; i < toShow.length; i++) {
			const v = toShow[i];
			if (!v) {
				continue;
			}
			console.log(`\n${i + 1}. ${v.file}${v.line ? `:${v.line}` : ""}`);
			console.log(`   ${v.message}`);
			if (v.suggestion) {
				console.log(`    ${v.suggestion}`);
			}
		}
		if (violations.atxMisuse.length > 40) {
			console.log(`\n... and ${violations.atxMisuse.length - 40} more`);
		}
	}

	// Batch B: Public-API Index Theater
	if (violations.indexTheater.length > 0) {
		console.log("\n\n  HIGH: Public-API Index Theater");
		console.log("=".repeat(80));
		const toShow = violations.indexTheater.slice(0, 40);
		for (let i = 0; i < toShow.length; i++) {
			const v = toShow[i];
			if (!v) {
				continue;
			}
			console.log(`\n${i + 1}. ${v.file}${v.line ? `:${v.line}` : ""}`);
			console.log(`   ${v.message}`);
			if (v.suggestion) {
				console.log(`    ${v.suggestion}`);
			}
		}
		if (violations.indexTheater.length > 40) {
			console.log(`\n... and ${violations.indexTheater.length - 40} more`);
		}
	}

	// Batch B: Laundered / Deep Cross-Slice Imports
	if (violations.launderedCrossImports.length > 0) {
		console.log("\n\n CRITICAL: Laundered / Deep Cross-Slice Imports");
		console.log("=".repeat(80));
		const toShow = violations.launderedCrossImports.slice(0, 40);
		for (let i = 0; i < toShow.length; i++) {
			const v = toShow[i];
			if (!v) {
				continue;
			}
			console.log(`\n${i + 1}. ${v.file}${v.line ? `:${v.line}` : ""}`);
			console.log(`   ${v.message}`);
			if (v.suggestion) {
				console.log(`    ${v.suggestion}`);
			}
		}
		if (violations.launderedCrossImports.length > 40) {
			console.log(`\n... and ${violations.launderedCrossImports.length - 40} more`);
		}
	}

	// Batch B: Shared Aggregate Mega-Barrel
	if (violations.sharedAggregateImports.length > 0) {
		console.log("\n\n  MEDIUM: Shared Aggregate Mega-Barrel (Tree-Shaking)");
		console.log("=".repeat(80));
		const toShow = violations.sharedAggregateImports.slice(0, 40);
		for (let i = 0; i < toShow.length; i++) {
			const v = toShow[i];
			if (!v) {
				continue;
			}
			console.log(`\n${i + 1}. ${v.file}${v.line ? `:${v.line}` : ""}`);
			console.log(`   ${v.message}`);
			if (v.suggestion) {
				console.log(`    ${v.suggestion}`);
			}
		}
		if (violations.sharedAggregateImports.length > 40) {
			console.log(`\n... and ${violations.sharedAggregateImports.length - 40} more`);
		}
	}

	// Batch B: Slice-Group Folder Code
	if (violations.sliceGroupCode.length > 0) {
		console.log("\n\n  HIGH: Slice-Group Folder Contains Code");
		console.log("=".repeat(80));
		for (let i = 0; i < violations.sliceGroupCode.length; i++) {
			const v = violations.sliceGroupCode[i];
			if (!v) {
				continue;
			}
			console.log(`\n${i + 1}. ${v.file}${v.line ? `:${v.line}` : ""}`);
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

	// Batch C — Entities/Feature semantics & Shared-layer purity
	const batchCSections: Array<{ label: string; list: Violation[]; cap: number }> = [
		{
			label: " CRITICAL: HTTP Client Outside shared/api",
			list: violations.httpClientOutsideShared,
			cap: 40,
		},
		{
			label: "  HIGH: Generic/Technical Feature Slice Names",
			list: violations.genericFeatureName,
			cap: 40,
		},
		{ label: '  HIGH: Forbidden "types"-Style Segment', list: violations.misplacedTypes, cap: 40 },
		{ label: "  MEDIUM: CRUD / Data-Access in Entities", list: violations.crudInEntities, cap: 40 },
		{
			label: "  MEDIUM: Authentication Data in Entities",
			list: violations.authInEntities,
			cap: 40,
		},
		{
			label: "  MEDIUM: Local Backend DTO Defined in Entities",
			list: violations.localDtoInEntities,
			cap: 40,
		},
		{
			label: "  MEDIUM: DTO/Mapper Outside api/ Segment",
			list: violations.misplacedDtoMapper,
			cap: 40,
		},
		{ label: "  MEDIUM: Misplaced API Request", list: violations.misplacedApiRequest, cap: 40 },
		{
			label: "  MEDIUM: Infrastructure Smuggled in Feature",
			list: violations.featureInfraSmuggling,
			cap: 40,
		},
		{
			label: "  MEDIUM: Multi-Purpose / God Feature Slice",
			list: violations.multiPurposeFeature,
			cap: 40,
		},
		{ label: "  MEDIUM: Auth Store in Page/Widget", list: violations.authInPageWidget, cap: 40 },
		{
			label: "  MEDIUM: Auth Page Pairing / Duplicate Login UI",
			list: violations.authPagePairing,
			cap: 40,
		},
		{ label: "ℹ  LOW: Cross-Slice Shared Query Keys", list: violations.sharedQueryKeys, cap: 40 },
	];
	for (const { label, list, cap } of batchCSections) {
		if (list.length === 0) {
			continue;
		}
		console.log(`\n\n${label}`);
		console.log("=".repeat(80));
		const toShow = list.slice(0, cap);
		for (let i = 0; i < toShow.length; i++) {
			const v = toShow[i];
			if (!v) {
				continue;
			}
			console.log(`\n${i + 1}. ${v.file}${v.line ? `:${v.line}` : ""}`);
			console.log(`   ${v.message}`);
			if (v.suggestion) {
				console.log(`    ${v.suggestion}`);
			}
		}
		if (list.length > cap) {
			console.log(`\n... and ${list.length - cap} more`);
		}
	}

	// Batch D — Framework boundaries (Electron / Vite / React-Query / routes)
	const batchDSections: Array<{ label: string; list: Violation[]; cap: number }> = [
		{
			label: " CRITICAL: Electron Process-Boundary Violation",
			list: violations.electronBoundary,
			cap: 60,
		},
		{ label: "  HIGH: Router Placement / Purity", list: violations.routerPlacement, cap: 60 },
		{
			label: "  HIGH: React-Query Factory/Client/Provider Placement",
			list: violations.reactQueryPlacement,
			cap: 60,
		},
		{
			label: "ℹ  LOW: Redirect/Route-Decision Ownership (advisory — verify injected)",
			list: violations.redirectOwnership,
			cap: 60,
		},
	];
	for (const { label, list, cap } of batchDSections) {
		if (list.length === 0) {
			continue;
		}
		console.log(`\n\n${label}`);
		console.log("=".repeat(80));
		const toShow = list.slice(0, cap);
		for (let i = 0; i < toShow.length; i++) {
			const v = toShow[i];
			if (!v) {
				continue;
			}
			console.log(`\n${i + 1}. ${v.file}${v.line ? `:${v.line}` : ""}`);
			console.log(`   ${v.message}`);
			if (v.suggestion) {
				console.log(`    ${v.suggestion}`);
			}
		}
		if (list.length > cap) {
			console.log(`\n... and ${list.length - cap} more`);
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
		// Batch A — structural layer/segment integrity
		checkNonCanonicalLayers(),
		checkNestedProcessesDirs(),
		checkSegmentAsSlice(),
		checkReservedTermNaming(),
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
	await checkScatteredDomain(files);
	await checkSharedNameMirrorsSlice(files);

	// Batch C — Entities/Feature semantics & Shared-layer purity
	await checkCrudInEntities(files);
	await checkAuthInEntities(files);
	await checkLocalDtoInEntities(files);
	await checkMisplacedDtoMapper(files);
	await checkMisplacedTypes(files);
	await checkHttpClientOutsideShared(files);
	await checkMisplacedApiRequest(files);
	await checkSharedQueryKeys(files);
	await checkGenericFeatureNames();
	await checkFeatureInfraSmuggling(files);
	await checkMultiPurposeFeature();
	await checkAuthInPageWidget(files);
	await checkAuthPagePairing(files);

	// Batch B — Public API & Cross-Import Hardening (need the full file list)
	await checkAtxMisuse(files);
	await checkIndexTheater(files);
	await checkSharedAggregateImports(files);
	await checkSliceGroupCode();
	await checkLaunderedCrossImports(files);
	checkHardenedCircularImports(files);

	// Batch D — Framework boundaries (Electron / Vite / React-Query / routes)
	await checkElectronBoundary(files);
	await checkRouterPlacement();
	await checkReactQueryPlacement(files);
	await checkRedirectOwnership(files);
	await checkHardcodedUrlsBatchDHardening(files);

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
						nonCanonicalLayers: violations.nonCanonicalLayers,
						nonCanonicalSegments: violations.nonCanonicalSegments,
						segmentAsSlice: violations.segmentAsSlice,
						scatteredDomain: violations.scatteredDomain,
						reservedTermNaming: violations.reservedTermNaming,
						sharedNameMirrorsSlice: violations.sharedNameMirrorsSlice,
						godSlices: violations.godSlices,
						circularImports: violations.circularImports,
						insignificantSlices: violations.insignificantSlices,
						excessiveSlicing: violations.excessiveSlicing,
						atxMisuse: violations.atxMisuse,
						indexTheater: violations.indexTheater,
						launderedCrossImports: violations.launderedCrossImports,
						sharedAggregateImports: violations.sharedAggregateImports,
						sliceGroupCode: violations.sliceGroupCode,
						crudInEntities: violations.crudInEntities,
						authInEntities: violations.authInEntities,
						localDtoInEntities: violations.localDtoInEntities,
						misplacedDtoMapper: violations.misplacedDtoMapper,
						misplacedTypes: violations.misplacedTypes,
						httpClientOutsideShared: violations.httpClientOutsideShared,
						misplacedApiRequest: violations.misplacedApiRequest,
						sharedQueryKeys: violations.sharedQueryKeys,
						genericFeatureName: violations.genericFeatureName,
						featureInfraSmuggling: violations.featureInfraSmuggling,
						multiPurposeFeature: violations.multiPurposeFeature,
						authInPageWidget: violations.authInPageWidget,
						authPagePairing: violations.authPagePairing,
						electronBoundary: violations.electronBoundary,
						routerPlacement: violations.routerPlacement,
						reactQueryPlacement: violations.reactQueryPlacement,
						redirectOwnership: violations.redirectOwnership,
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
