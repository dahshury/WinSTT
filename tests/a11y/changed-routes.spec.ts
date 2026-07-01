import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import type { Result } from "axe-core";

// Each Tauri window is a separate HTML entry served by the Vite dev server.
// The set below covers the windows whose UI changed in this branch (app/layouts
// changed, which every window mounts, plus the settings widgets, model-picker,
// overlay, onboarding, and history surfaces).
const ROUTES: ReadonlyArray<{ name: string; path: string }> = [
	{ name: "main", path: "/" },
	{ name: "settings", path: "/windows/settings.html" },
	{ name: "model-picker", path: "/windows/model-picker.html" },
	{ name: "device-picker", path: "/windows/device-picker.html" },
	{ name: "onboarding", path: "/windows/onboarding.html" },
	{ name: "history", path: "/windows/history.html" },
	{ name: "overlay", path: "/windows/overlay.html" },
	{ name: "tray-menu", path: "/windows/tray-menu.html" },
];

// The audit fails on these impact levels only. "serious" is the goal threshold;
// "critical" is strictly worse, so it is always included. Moderate/minor issues
// are reported (see the console summary) but do not fail the run.
const FAILING_IMPACTS = new Set(["serious", "critical"]);

async function settle(page: Page): Promise<void> {
	// Wait for the React root to mount past the static startup shell, then let
	// any mount-time effects / lazy chunks land before snapshotting the DOM.
	await page
		.waitForFunction(
			() => {
				const root = document.getElementById("root");
				if (!root) {
					return false;
				}
				return Boolean(
					root.querySelector(":scope > *:not([data-winstt-startup-shell])"),
				);
			},
			undefined,
			{ timeout: 20_000 },
		)
		.catch(() => {
			// Some windows (overlay/tray) may render minimal DOM; audit whatever exists.
		});
	await page.waitForLoadState("networkidle").catch(() => {});
	await page.waitForTimeout(1200);
}

function formatViolations(violations: Result[]): string {
	return violations
		.map((v) => {
			const targets = v.nodes
				.slice(0, 8)
				.map((n) => {
					const sel = Array.isArray(n.target) ? n.target.join(" ") : n.target;
					const summary = (n.failureSummary ?? "").replace(/\s+/g, " ").trim();
					return `      - ${sel}\n        ${summary}`;
				})
				.join("\n");
			return `  [${v.impact}] ${v.id}: ${v.help}\n    ${v.helpUrl}\n${targets}`;
		})
		.join("\n\n");
}

for (const route of ROUTES) {
	test(`a11y: ${route.name} (${route.path})`, async ({ page }) => {
		await page.goto(route.path, { waitUntil: "domcontentloaded" });
		await settle(page);

		const results = await new AxeBuilder({ page }).analyze();

		const failing = results.violations.filter(
			(v) => v.impact != null && FAILING_IMPACTS.has(v.impact),
		);
		const other = results.violations.filter(
			(v) => v.impact == null || !FAILING_IMPACTS.has(v.impact),
		);

		// Always print a per-route summary so the loop can read what's left.
		const otherSummary = other
			.map((v) => `${v.id}(${v.impact ?? "n/a"})`)
			.join(", ");
		// biome-ignore lint/suspicious/noConsole: audit progress output is the point here.
		console.log(
			`\n[a11y:${route.name}] serious/critical=${failing.length} | other=${other.length}${
				otherSummary ? ` -> ${otherSummary}` : ""
			}`,
		);

		if (failing.length > 0) {
			// biome-ignore lint/suspicious/noConsole: surface the actionable detail.
			console.log(`\n[a11y:${route.name}] FAILING:\n${formatViolations(failing)}`);
		}

		expect(
			failing,
			`Serious/critical a11y violations on "${route.name}" (${route.path}):\n${formatViolations(
				failing,
			)}`,
		).toEqual([]);
	});
}
