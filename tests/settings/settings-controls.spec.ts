import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { settingsContractPaths } from "../../src/shared/config/settings-contract";

interface ManifestSelector {
	name: string;
	role: Parameters<Page["getByRole"]>[0];
}

interface ManifestTab {
	id: string;
	items: Array<{
		id: string;
		kind: "action" | "control";
		settingsPaths: string[];
	}>;
	label: string;
	rawControlBaseline: { minimum: number; observed: number };
	smokeSelectors: ManifestSelector[];
}

interface SettingsManifest {
	nonInteractivePaths: Array<{ path: string; reason: string }>;
	tabOrder: string[];
	tabs: ManifestTab[];
	version: number;
}

const manifestPath = fileURLToPath(
	new URL("../../spec/settings-controls.manifest.json", import.meta.url),
);
const manifest = JSON.parse(
	readFileSync(manifestPath, "utf8"),
) as SettingsManifest;
const SETTINGS_PATH = "/windows/settings.html";
const BASE_ORIGIN = "http://127.0.0.1:1428";
const CONTROL_SELECTOR = [
	"button",
	"input",
	"select",
	"textarea",
	'[role="button"]',
	'[role="checkbox"]',
	'[role="combobox"]',
	'[role="grid"]',
	'[role="slider"]',
	'[role="spinbutton"]',
	'[role="switch"]',
].join(",");

async function installRuntimeLeakGuards(page: Page): Promise<{
	consoleErrors: string[];
	externalRequests: string[];
	pageErrors: string[];
}> {
	const consoleErrors: string[] = [];
	const externalRequests: string[] = [];
	const pageErrors: string[] = [];
	page.on("console", (message) => {
		if (message.type() === "error") {
			consoleErrors.push(message.text());
		}
	});
	page.on("pageerror", (error) => pageErrors.push(error.message));
	await page.route("**/*", async (route) => {
		const url = new URL(route.request().url());
		if (
			(url.protocol === "http:" || url.protocol === "https:") &&
			url.origin !== BASE_ORIGIN
		) {
			externalRequests.push(url.href);
			await route.abort("blockedbyclient");
			return;
		}
		await route.continue();
	});
	return { consoleErrors, externalRequests, pageErrors };
}

async function openSettings(page: Page): Promise<void> {
	await page.goto(SETTINGS_PATH, {
		timeout: 30_000,
		waitUntil: "domcontentloaded",
	});
	await expect(page.getByRole("tab", { name: "Recording" })).toBeVisible();
}

async function selectTab(page: Page, tab: ManifestTab): Promise<void> {
	// The sidebar mounts before settings hydration and the window reveal complete.
	await expect(page.locator(".settings-window-shell")).toHaveClass(
		/\bis-open\b/,
	);
	const tabButton = page.getByRole("tab", { exact: true, name: tab.label });
	await tabButton.click();
	await expect(tabButton).toHaveAttribute("aria-selected", "true");
	await expect(
		page.locator('[data-slot="settings-panel-fallback"]'),
	).toHaveCount(0);
}

test("the static inventory covers every tab and each default panel stays browser-safe", async ({
	page,
}) => {
	const leaks = await installRuntimeLeakGuards(page);
	await openSettings(page);

	expect(manifest.version).toBe(1);
	expect(manifest.tabs.map((tab) => tab.id)).toEqual(manifest.tabOrder);
	expect(
		new Set(
			manifest.tabs.flatMap((tab) =>
				tab.items.map((item) => `${tab.id}:${item.id}`),
			),
		).size,
	).toBe(manifest.tabs.reduce((total, tab) => total + tab.items.length, 0));
	const interactivePaths = manifest.tabs.flatMap((tab) =>
		tab.items.flatMap((item) =>
			item.settingsPaths.filter((path) => path !== "*"),
		),
	);
	const nonInteractivePaths = manifest.nonInteractivePaths.map(
		({ path, reason }) => {
			expect(
				reason.trim().length,
				`${path} needs a concrete exclusion reason`,
			).toBeGreaterThan(11);
			return path;
		},
	);
	expect(new Set(interactivePaths).size).toBeLessThanOrEqual(
		interactivePaths.length,
	);
	expect(new Set(nonInteractivePaths).size).toBe(nonInteractivePaths.length);
	expect(
		interactivePaths.filter((path) => nonInteractivePaths.includes(path)),
	).toEqual([]);
	expect(
		[...new Set([...interactivePaths, ...nonInteractivePaths])].toSorted(),
	).toEqual(settingsContractPaths().toSorted());

	for (const tab of manifest.tabs) {
		await test.step(tab.label, async () => {
			await selectTab(page, tab);
			for (const selector of tab.smokeSelectors) {
				await expect(
					page
						.getByRole(selector.role, { exact: true, name: selector.name })
						.first(),
				).toBeVisible();
			}
			const visiblePanel = page.locator('[role="tabpanel"]:visible');
			await expect(visiblePanel).toHaveCount(1);
			const rawCount = await visiblePanel.locator(CONTROL_SELECTOR).count();
			expect
				.soft(
					rawCount,
					`${tab.label} raw controls fell well below its non-authoritative ${tab.rawControlBaseline.observed}-control baseline`,
				)
				.toBeGreaterThanOrEqual(tab.rawControlBaseline.minimum);
		});
	}

	expect(leaks.externalRequests).toEqual([]);
	expect(leaks.pageErrors).toEqual([]);
	expect(leaks.consoleErrors).toEqual([]);
});

test("a safe appearance setting persists through the dev bridge and reload", async ({
	page,
}) => {
	const leaks = await installRuntimeLeakGuards(page);
	await openSettings(page);
	const appearance = manifest.tabs.find((tab) => tab.id === "appearance");
	expect(appearance).toBeDefined();
	await selectTab(page, appearance as ManifestTab);

	const slider = page.getByRole("slider", { exact: true, name: "Bar Count" });
	await expect(slider).toBeVisible();
	const before = await slider.getAttribute("aria-valuenow");
	expect(before).not.toBeNull();
	const persisted = page.waitForResponse(
		(response) =>
			response.url().endsWith("/__winstt/settings") &&
			response.request().method() === "PATCH" &&
			response.ok(),
		{ timeout: 10_000 },
	);
	await slider.press("ArrowRight");
	await persisted;
	const changed = await slider.getAttribute("aria-valuenow");
	expect(changed).not.toBe(before);

	await page.reload({ timeout: 30_000, waitUntil: "domcontentloaded" });
	await expect(page.getByRole("tab", { name: "Appearance" })).toBeVisible();
	await selectTab(page, appearance as ManifestTab);
	await expect(
		page.getByRole("slider", { exact: true, name: "Bar Count" }),
	).toHaveAttribute("aria-valuenow", changed as string);

	expect(leaks.externalRequests).toEqual([]);
	expect(leaks.pageErrors).toEqual([]);
	expect(leaks.consoleErrors).toEqual([]);
});

test("native ASR presets can be configured without a separate cleanup model", async ({
	page,
}) => {
	const leaks = await installRuntimeLeakGuards(page);
	const snapshotResponse = await page.request.get("/__winstt/settings");
	const snapshot = await snapshotResponse.json();
	const seed = await page.request.patch("/__winstt/settings", {
		data: {
			baseRevision: snapshot.revision,
			settings: {
				model: {
					...snapshot.settings.model,
					model: "nemotron-3.5-transcribe-30b-a4b",
					onnxQuantization: "q4",
					asrPromptSource: "off",
					asrPromptModel: "",
					asrInstruction: "",
					asrAllowSeparateCleanup: false,
				},
			},
		},
	});
	expect(seed.ok()).toBe(true);
	await openSettings(page);
	await selectTab(
		page,
		manifest.tabs.find((tab) => tab.id === "model") as ManifestTab,
	);
	await page
		.getByRole("button", { name: "Use cleanup presets", exact: true })
		.click();
	await expect
		.poll(async () => {
			const state = await (await page.request.get("/__winstt/settings")).json();
			return state.settings.model.asrPromptSource;
		})
		.toBe("cleanupPresets");
	await selectTab(
		page,
		manifest.tabs.find((tab) => tab.id === "processing") as ManifestTab,
	);
	await expect(
		page.getByText("Your speech model handles cleanup directly.", {
			exact: false,
		}),
	).toBeVisible();
	await page.getByRole("button", { name: "Manage profiles" }).click();
	const tone = page.getByText("Tone", { exact: true });
	await expect(tone).toBeVisible();
	expect(
		await tone.evaluate(
			(element) => element.closest('[aria-disabled="true"]') === null,
		),
	).toBe(true);
	await page.screenshot({
		path: test.info().outputPath("native-asr-presets.png"),
	});
	expect(leaks.pageErrors).toEqual([]);
	expect(leaks.externalRequests).toEqual([]);
});

test("file speaker options persist through reload", async ({ page }) => {
	const leaks = await installRuntimeLeakGuards(page);
	await openSettings(page);
	const output = manifest.tabs.find((tab) => tab.id === "output");
	expect(output).toBeDefined();
	await selectTab(page, output as ManifestTab);
	const diarization = page.getByRole("switch", {
		name: "Identify speakers",
		exact: true,
	});
	const prefixes = page.getByRole("switch", {
		name: "Speaker prefixes",
		exact: true,
	});
	await expect(prefixes).toBeDisabled();
	await diarization.click();
	await expect(prefixes).toBeEnabled();
	await prefixes.click();
	await expect(prefixes).toBeChecked();
	await expect
		.poll(async () => {
			const response = await page.request.get("/__winstt/settings");
			return (await response.json()).settings.general
				?.fileTranscriptionSpeakerPrefixes;
		})
		.toBe(true);
	const before = await (await page.request.get("/__winstt/settings")).json();
	expect(before.settings.general.fileTranscriptionDiarization).toBe(true);
	await page.reload({ waitUntil: "domcontentloaded" });
	await selectTab(page, output as ManifestTab);
	await expect(diarization).toBeChecked();
	await expect(prefixes).toBeChecked();
	expect(leaks.pageErrors).toEqual([]);
	expect(leaks.externalRequests).toEqual([]);
});
