import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { describe, expect, test } from "bun:test";
import { IntlProvider as RawIntlProvider } from "use-intl";
import { IntlProvider } from "@/app/providers/IntlProvider";
import { IPC } from "@test/mocks/legacy-ipc";
import enMessages from "../../../../messages/en.json";
import { AboutSettingsPanel } from "./AboutSettingsPanel";

interface TauriInternals {
	invoke: (cmd: string, args?: unknown, options?: unknown) => Promise<unknown>;
	transformCallback: (
		cb?: (payload: unknown) => void,
		once?: boolean,
	) => number;
}

type CommandHandler = (args?: unknown) => unknown;

/**
 * Per-test fakes over the two native surfaces the About tab reaches through:
 * `__TAURI_INTERNALS__.invoke` (everything routed via the generated `commands.*`
 * bindings) and `window.nativeBridge` (the legacy channel names some wrappers
 * still fall back to). Both record into ONE call log, so an assertion can accept
 * either spelling of the same operation — the same shape the hand-rolled setup
 * in each test used to build, just not five times over.
 *
 * Handlers are keyed by command/channel name; an unhandled name resolves
 * `undefined`, which is exactly what `test/preload.ts` installs by default.
 */
function installNativeFakes(handlers: Record<string, CommandHandler>) {
	const calls: string[] = [];
	const tauriWindow = window as unknown as Window & {
		__TAURI_INTERNALS__: TauriInternals;
	};
	const previousNativeBridge = window.nativeBridge;
	const previousTauriInvoke = tauriWindow.__TAURI_INTERNALS__.invoke;

	const dispatch = (name: string, args?: unknown): unknown => {
		calls.push(name);
		const handler = handlers[name];
		return handler ? handler(args) : undefined;
	};

	tauriWindow.__TAURI_INTERNALS__.invoke = async (cmd, args) =>
		dispatch(cmd, args);
	window.nativeBridge = {
		...previousNativeBridge,
		invoke: async (channel) => dispatch(channel),
		secureInvoke: async (channel) => dispatch(channel),
	};

	return {
		calls,
		/** How many times any of `names` was invoked (either spelling counts once). */
		countOf(...names: string[]): number {
			return calls.filter((call) => names.includes(call)).length;
		},
		restore() {
			window.nativeBridge = previousNativeBridge;
			tauriWindow.__TAURI_INTERNALS__.invoke = previousTauriInvoke;
		},
	};
}

const APP_INFO = { copyright: "Copyright WinSTT", version: "1.2.3" };
/** A resolved updater history — its presence suppresses the mount auto-check. */
const UP_TO_DATE_HISTORY = [{ status: "not-available", timestamp: 1 }];

const CHECK_UPDATES = [
	"winstt_updater_check_and_download",
	IPC.UPDATER_CHECK_NOW,
];
const READ_UPDATE_HISTORY = [
	"winstt_updater_get_status_history",
	IPC.UPDATER_GET_STATUS_HISTORY,
];

function renderPanel() {
	return render(
		<IntlProvider>
			<AboutSettingsPanel />
		</IntlProvider>,
	);
}

/** Let queued microtasks (and the state updates they schedule) settle. */
async function flush() {
	await act(async () => {
		await Promise.resolve();
		await Promise.resolve();
	});
}

/** Scope queries to one SettingSection by its heading — the panel's four
 *  sections are otherwise only distinguishable by position. */
function sectionByHeading(name: string): HTMLElement {
	const heading = screen.getByRole("heading", { level: 3, name });
	const section = heading.closest("section");
	if (!section) {
		throw new Error(`No <section> wraps the heading "${name}"`);
	}
	return section as HTMLElement;
}

describe("AboutSettingsPanel", () => {
	test("auto-checks updates once when the About tab has no updater history", async () => {
		const native = installNativeFakes({
			about_get_app_info: () => APP_INFO,
			winstt_updater_get_status_history: () => [],
			winstt_updater_check_and_download: () => ({ triggered: false }),
			[IPC.UPDATER_GET_STATUS_HISTORY]: () => [],
			[IPC.UPDATER_CHECK_NOW]: () => ({ triggered: false }),
		});

		try {
			renderPanel();

			// The bespoke update toolbar is gone: the version is a labelled value and
			// the action is a real, named button in the product section.
			const appSection = sectionByHeading("WinSTT");
			expect(within(appSection).getByText("Version")).toBeDefined();
			await waitFor(() => {
				expect(within(appSection).getByText("1.2.3")).toBeDefined();
			});
			expect(
				within(appSection).getByRole("button", { name: "Check for updates" }),
			).toBeDefined();

			await waitFor(() => {
				expect(native.countOf(...READ_UPDATE_HISTORY)).toBe(1);
				expect(native.countOf(...CHECK_UPDATES)).toBe(1);
			});
			// The auto-check is once-per-mount; a later render pass must not re-fire it.
			await flush();
			expect(native.countOf(...CHECK_UPDATES)).toBe(1);
		} finally {
			native.restore();
		}
	});

	test("renders the latest-version status as a sentence and does not auto-check", async () => {
		const native = installNativeFakes({
			about_get_app_info: () => APP_INFO,
			winstt_updater_get_status_history: () => UP_TO_DATE_HISTORY,
			[IPC.UPDATER_GET_STATUS_HISTORY]: () => UP_TO_DATE_HISTORY,
		});

		try {
			renderPanel();

			// The status is a polite live region named after the section it explains,
			// so the sentence is announced with context instead of arriving bare.
			const status = await screen.findByRole("status", { name: "Updates" });
			await waitFor(() => {
				expect(status.textContent).toContain("You're on the latest version.");
			});
			expect(
				within(sectionByHeading("WinSTT")).getByRole("button", {
					name: "Check for updates",
				}),
			).toBeDefined();
			expect(native.countOf(...CHECK_UPDATES)).toBe(0);
		} finally {
			native.restore();
		}
	});

	test("renders exactly four sections with start-on-login folded into the product section", async () => {
		const native = installNativeFakes({
			about_get_app_info: () => APP_INFO,
			winstt_updater_get_status_history: () => UP_TO_DATE_HISTORY,
			[IPC.UPDATER_GET_STATUS_HISTORY]: () => UP_TO_DATE_HISTORY,
		});

		try {
			renderPanel();

			const headings = await screen.findAllByRole("heading", { level: 3 });
			expect(headings.map((heading) => heading.textContent)).toEqual([
				"WinSTT",
				"Settings backup",
				"Diagnostics",
				"Application data",
			]);

			// "Startup" was its own section before the restructure; the switch it
			// carried now lives beside the update controls. Absence is asserted on a
			// COUNT so a regression prints a number rather than a serialized DOM tree.
			expect(screen.queryAllByText("Startup").length).toBe(0);
			expect(
				within(sectionByHeading("WinSTT")).getByRole("switch", {
					name: "Start on Login",
				}),
			).toBeDefined();
			expect(
				within(sectionByHeading("WinSTT")).getByRole("switch", {
					name: "Receive pre-release updates",
				}),
			).toBeDefined();
		} finally {
			native.restore();
		}
	});

	test("labels the update action and disables it while a check is in flight", async () => {
		let releaseCheck: (() => void) | undefined;
		const checkGate = new Promise<void>((resolve) => {
			releaseCheck = resolve;
		});
		const native = installNativeFakes({
			about_get_app_info: () => APP_INFO,
			// No history → the mount auto-check fires, and this gate holds it open so
			// the in-flight disabled state is observable.
			winstt_updater_get_status_history: () => [],
			winstt_updater_check_and_download: async () => {
				await checkGate;
				return { triggered: false };
			},
			[IPC.UPDATER_GET_STATUS_HISTORY]: () => [],
			[IPC.UPDATER_CHECK_NOW]: async () => {
				await checkGate;
				return { triggered: false };
			},
		});

		try {
			renderPanel();

			const action = await screen.findByRole("button", {
				name: "Check for updates",
			});
			// Not an icon-only control: the accessible name comes from visible text,
			// not from an aria-label standing in for a missing label.
			expect(action.textContent).toContain("Check for updates");
			expect(action.getAttribute("aria-label")).toBeNull();

			await waitFor(() => {
				expect(action.hasAttribute("disabled")).toBe(true);
			});

			releaseCheck?.();
			await waitFor(() => {
				expect(action.hasAttribute("disabled")).toBe(false);
			});
		} finally {
			releaseCheck?.();
			await flush();
			native.restore();
		}
	});

	test("runs the open-logs action from the log console toolbar", async () => {
		const native = installNativeFakes({
			about_get_app_info: () => APP_INFO,
			diag_open_logs_folder: () => ({ ok: true, path: "C:\\logs" }),
			winstt_updater_get_status_history: () => UP_TO_DATE_HISTORY,
			[IPC.DIAG_OPEN_LOGS_FOLDER]: () => ({ ok: true, path: "C:\\logs" }),
			[IPC.UPDATER_GET_STATUS_HISTORY]: () => UP_TO_DATE_HISTORY,
		});

		try {
			renderPanel();

			// Both on-disk log commands moved out of their own rows and into the
			// console's toolbar, next to the stream controls they share a subject with.
			const toolbar = await screen.findByRole("toolbar", {
				name: "Log actions",
			});
			await act(async () => {
				fireEvent.click(
					within(toolbar).getByRole("button", { name: "Open folder" }),
				);
				await Promise.resolve();
			});
			expect(
				native.countOf("diag_open_logs_folder", IPC.DIAG_OPEN_LOGS_FOLDER),
			).toBe(1);
		} finally {
			native.restore();
		}
	});

	test("saves a diagnostic bundle from the log console toolbar and stays silent when cancelled", async () => {
		const native = installNativeFakes({
			about_get_app_info: () => APP_INFO,
			// A dismissed save dialog is the user's own decision, not a failure.
			diag_save_bundle: () => ({ cancelled: true, ok: false }),
			winstt_updater_get_status_history: () => UP_TO_DATE_HISTORY,
			[IPC.UPDATER_GET_STATUS_HISTORY]: () => UP_TO_DATE_HISTORY,
		});

		try {
			renderPanel();

			const toolbar = await screen.findByRole("toolbar", {
				name: "Log actions",
			});
			await act(async () => {
				fireEvent.click(
					within(toolbar).getByRole("button", { name: "Save Bundle" }),
				);
				await Promise.resolve();
			});
			expect(native.countOf("diag_save_bundle")).toBe(1);

			await flush();
			// Compared as text, not as nodes: a regression here should print the
			// alert's copy, not a serialized DOM tree.
			expect(
				screen.queryAllByRole("alert").map((alert) => alert.textContent),
			).toEqual([]);
		} finally {
			native.restore();
		}
	});

	test("collapses long operational issue details until the user expands them", async () => {
		const longDetail = Array.from(
			{ length: 8 },
			(_, index) => `stack-frame-${index}`,
		).join("\n");
		const native = installNativeFakes({
			about_get_app_info: () => APP_INFO,
			diag_observability_timeline: () => [
				{
					area: "renderer",
					context: {},
					detail: longDetail,
					id: 10,
					kind: "webview",
					operation: "error",
					severity: "error",
					summary: "Renderer reported a webview error",
					timestampMs: 10,
					userVisible: false,
				},
			],
			winstt_updater_get_status_history: () => UP_TO_DATE_HISTORY,
			[IPC.UPDATER_GET_STATUS_HISTORY]: () => UP_TO_DATE_HISTORY,
		});

		try {
			renderPanel();

			await screen.findByText("Renderer reported a webview error");
			const issueActions = screen.getByRole("toolbar", {
				name: "Operational issue actions",
			});
			expect(
				issueActions.querySelector(
					'[data-slot="observability-action-separator"]',
				),
			).not.toBeNull();
			// The block's copy is translated now; both controls are named by the
			// `about.issues*` keys rather than the deleted English constants.
			expect(
				within(issueActions).getByRole("button", { name: "Refresh" }),
			).toBeDefined();
			// Accessible name is the fuller issuesClearAllTitle, not the visible
			// "Clear all" — the log console's own "Clear" sits in the same section.
			expect(
				within(issueActions).getByRole("button", {
					name: "Clear all operational issues",
				}),
			).toBeDefined();

			const detail = await screen.findByText(
				(_, node) => node?.textContent === longDetail,
			);
			expect(detail.getAttribute("class")).toContain("line-clamp-4");

			fireEvent.click(screen.getByRole("button", { name: "Show more" }));

			expect(detail.getAttribute("class")).not.toContain("line-clamp-4");
			expect(screen.getByRole("button", { name: "Show less" })).toBeDefined();
		} finally {
			native.restore();
		}
	});

	test("renders every operational-issue string from the message bundle", async () => {
		// Swap the whole `about.issues*` block for sentinels. Anything still
		// hardcoded would keep rendering its English literal and fail these
		// queries, so this asserts the strings genuinely come from i18n rather
		// than merely matching en.json today.
		const sentinels: Record<string, string> = {};
		for (const key of Object.keys(enMessages.about)) {
			if (key.startsWith("issues")) {
				sentinels[key] = `i18n:${key}`;
			}
		}
		const messages = {
			...enMessages,
			about: { ...enMessages.about, ...sentinels },
		};
		const native = installNativeFakes({
			about_get_app_info: () => APP_INFO,
			diag_observability_timeline: () => [
				{
					area: "renderer",
					context: {},
					detail: "boom",
					durationMs: 42,
					id: 11,
					kind: "webview",
					operation: "error",
					remediation: "Retry the request",
					severity: "error",
					summary: "Renderer reported a webview error",
					timestampMs: 10,
					userVisible: false,
				},
			],
			winstt_updater_get_status_history: () => UP_TO_DATE_HISTORY,
			[IPC.UPDATER_GET_STATUS_HISTORY]: () => UP_TO_DATE_HISTORY,
		});

		try {
			const { container } = render(
				<RawIntlProvider
					locale="en"
					messages={messages as Record<string, unknown>}
					timeZone="UTC"
				>
					<AboutSettingsPanel />
				</RawIntlProvider>,
			);

			expect(await screen.findByText("i18n:issuesTitle")).toBeDefined();
			expect(screen.getByText("i18n:issuesSummary")).toBeDefined();
			const issueActions = screen.getByRole("toolbar", {
				name: "i18n:issuesActionsLabel",
			});
			expect(
				within(issueActions).getByRole("button", {
					name: "i18n:issuesRefresh",
				}),
			).toBeDefined();
			// Named by issuesClearAllTitle, not by its visible "Clear all" text: the
			// log console in this same section has its own "Clear" button, and the
			// two must not be told apart only by their enclosing group.
			expect(
				within(issueActions).getByRole("button", {
					name: "i18n:issuesClearAllTitle",
				}),
			).toBeDefined();
			expect(screen.getByText("i18n:issuesBackgroundOnly")).toBeDefined();
			expect(screen.getByText("i18n:issuesRemediation")).toBeDefined();
			expect(
				screen.getByRole("button", { name: "i18n:issuesCopy" }),
			).toBeDefined();
			// Meta chips are named, not `title`-attributed — the shelf bans OS tooltips.
			expect(
				container.querySelector('[aria-label="i18n:issuesMetaTime"]'),
			).not.toBeNull();
			expect(
				container.querySelector('[aria-label="i18n:issuesMetaDuration"]'),
			).not.toBeNull();
		} finally {
			native.restore();
		}
	});

	test("renders settings export and import as two buttons in one row", async () => {
		const native = installNativeFakes({
			about_get_app_info: () => APP_INFO,
			winstt_updater_get_status_history: () => UP_TO_DATE_HISTORY,
			[IPC.UPDATER_GET_STATUS_HISTORY]: () => UP_TO_DATE_HISTORY,
		});

		try {
			renderPanel();

			// One labelled row, not two stacked action rows each with a lone button.
			const backup = await screen.findByRole("group", {
				name: "Settings backup",
			});
			const exportButton = within(backup).getByRole("button", {
				name: "Export settings",
			});
			const importButton = within(backup).getByRole("button", {
				name: "Import settings",
			});
			expect(within(backup).getAllByRole("button").length).toBe(2);
			// Siblings in the same row: each button's nearest group is THIS group, and
			// the group holds nothing but the two of them. Compared as booleans so a
			// mismatch reports `false` instead of dumping the whole subtree.
			expect(exportButton.closest("[role='group']") === backup).toBe(true);
			expect(importButton.closest("[role='group']") === backup).toBe(true);
			expect(backup.childElementCount).toBe(2);
		} finally {
			native.restore();
		}
	});

	test("renders per-category usage rows above the destructive group", async () => {
		const native = installNativeFakes({
			about_get_app_info: () => APP_INFO,
			app_data_usage: () => [
				{ bytes: 420_000_000, key: "stt" },
				{ bytes: 96_000_000, key: "logs" },
				{ bytes: 4_000_000, key: "other" },
			],
			winstt_updater_get_status_history: () => UP_TO_DATE_HISTORY,
			[IPC.UPDATER_GET_STATUS_HISTORY]: () => UP_TO_DATE_HISTORY,
		});

		try {
			renderPanel();

			const sttRow = await screen.findByRole("group", {
				name: "Speech-to-Text models",
			});
			expect(
				within(sttRow).getByRole("button", {
					name: "Remove Speech-to-Text models",
				}),
			).toBeDefined();
			expect(
				within(screen.getByRole("group", { name: "Logs" })).getByRole(
					"button",
					{
						name: "Remove Logs",
					},
				),
			).toBeDefined();
			// "Other" is settings + misc cache: no per-row removal, only the reserved
			// action column that keeps the list aligned.
			expect(
				within(screen.getByRole("group", { name: "Other" })).queryAllByRole(
					"button",
				).length,
			).toBe(0);
			expect(screen.getByText("Application data on disk")).toBeDefined();

			const destructive = screen.getByRole("group", {
				name: "Destructive actions",
			});
			for (const name of [
				"Uninstall models",
				"Reset Defaults",
				"Remove app data",
			]) {
				expect(within(destructive).getByRole("button", { name })).toBeDefined();
			}
			// The usage rows come first; the ways to throw data away are fenced below.
			expect(
				Boolean(
					sttRow.compareDocumentPosition(destructive) &
						Node.DOCUMENT_POSITION_FOLLOWING,
				),
			).toBe(true);
		} finally {
			native.restore();
		}
	});

	test("keeps the destructive group when application-data usage is unavailable", async () => {
		const native = installNativeFakes({
			about_get_app_info: () => APP_INFO,
			// Nothing measurable on disk — the breakdown contributes no rows, and the
			// section must NOT collapse with it.
			app_data_usage: () => [],
			winstt_updater_get_status_history: () => UP_TO_DATE_HISTORY,
			[IPC.UPDATER_GET_STATUS_HISTORY]: () => UP_TO_DATE_HISTORY,
		});

		try {
			renderPanel();

			const destructive = await screen.findByRole("group", {
				name: "Destructive actions",
			});
			await flush();
			expect(
				screen.queryAllByRole("group", { name: "Speech-to-Text models" })
					.length,
			).toBe(0);
			expect(screen.queryAllByText("Application data on disk").length).toBe(0);
			expect(within(destructive).getAllByRole("button").length).toBe(3);
			expect(sectionByHeading("Application data")).toBeDefined();
		} finally {
			native.restore();
		}
	});
});
