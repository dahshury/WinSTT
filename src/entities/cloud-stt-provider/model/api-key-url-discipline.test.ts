import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { CLOUD_PROVIDERS, getApiKeyUrl } from "./catalog";

/**
 * Guardrail: `getApiKeyUrl` is the single source for every provider's key
 * console, so no UI may paste one of those URLs inline.
 *
 * The Integrations rework replaced a duplicated `OPENROUTER_KEYS_URL` with this
 * function precisely because the copies drifted; anything that re-inlines a URL
 * puts the vendor's console back in two places, where only one of them gets
 * updated when the vendor moves the page.
 *
 * The banned literals are DERIVED from `getApiKeyUrl` rather than restated, so
 * changing a URL there cannot leave this check policing a stale string.
 */

const FRONTEND_ROOT = resolve(import.meta.dir, "../../../..");
const SCAN_DIRS = [join(FRONTEND_ROOT, "src"), join(FRONTEND_ROOT, "packages")];
const SCAN_EXTENSIONS = [".ts", ".tsx"];
const SKIP_DIRS = new Set([
	"node_modules",
	".turbo",
	"dist",
	"build",
	"coverage",
	"playwright-report",
]);

/** Files allowed to contain a console URL verbatim. */
const ALLOWED = new Set([
	// The canonical definition and the test that pins its exact values — that is
	// their job. (This file derives the URLs, so it is not itself an offender.)
	"src/entities/cloud-stt-provider/model/catalog.ts",
	"src/entities/cloud-stt-provider/model/catalog.test.ts",
	// KNOWN, PRE-EXISTING duplicates outside the reworked Integrations surface.
	// Both predate `getApiKeyUrl` and are listed rather than silently tolerated:
	// deleting an entry here is the whole fix. Follow-up is to route both through
	// `getApiKeyUrl(provider)` and empty this list.
	"src/widgets/llm-settings/ui/provider-dialogs.tsx",
	"src/widgets/onboarding-wizard/ui/steps/OnboardingCloudKeysStep.tsx",
]);

function walk(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (SKIP_DIRS.has(entry.name)) {
			continue;
		}
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(...walk(path));
		} else if (SCAN_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
			out.push(path);
		}
	}
	return out;
}

function relPosix(file: string): string {
	return relative(FRONTEND_ROOT, file).replaceAll("\\", "/");
}

const SCAN_FILES = SCAN_DIRS.filter(existsSync).flatMap(walk);
const CONSOLE_URLS = CLOUD_PROVIDERS.map(getApiKeyUrl);

/** Every file that contains a key-console URL verbatim, as posix paths. */
const OFFENDERS = SCAN_FILES.map(relPosix).filter((rel) => {
	const content = readFileSync(join(FRONTEND_ROOT, rel), "utf8");
	return CONSOLE_URLS.some((url) => content.includes(url));
});

describe("API key console URLs live in getApiKeyUrl only", () => {
	test("the scan actually found the frontend sources", () => {
		// A broken root would make every assertion below vacuously pass.
		expect(SCAN_FILES.length).toBeGreaterThan(100);
		expect(CONSOLE_URLS.length).toBe(CLOUD_PROVIDERS.length);
	});

	test("the reworked Integrations surface hardcodes no console URL", () => {
		expect(
			OFFENDERS.filter(
				(rel) =>
					rel.startsWith("src/widgets/integrations-settings/") ||
					rel.startsWith("src/features/verify-credentials/"),
			),
		).toEqual([]);
	});

	test("no file outside the allow-list inlines a console URL", () => {
		expect(OFFENDERS.filter((rel) => !ALLOWED.has(rel))).toEqual([]);
	});

	test("no allow-list entry names a file that no longer exists", () => {
		// A renamed or deleted path would leave a silent hole in the check.
		// Deliberately NOT asserting each entry still offends: fixing one of the
		// listed duplicates should not fail the suite — just delete its line.
		expect(
			[...ALLOWED].filter((rel) => !existsSync(join(FRONTEND_ROOT, rel))),
		).toEqual([]);
	});
});
