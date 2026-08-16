import { describe, expect, test } from "bun:test";
import {
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import type { AppDataUsageEntry } from "@/bindings";
import { AppDataUsageBreakdown } from "./AppDataUsageBreakdown";

interface TauriInternals {
	invoke: (cmd: string, args?: unknown, options?: unknown) => Promise<unknown>;
	transformCallback: (
		cb?: (payload: unknown) => void,
		once?: boolean,
	) => number;
}

interface InvokeCall {
	args: unknown;
	cmd: string;
}

const MIB = 1024 * 1024;

/**
 * The breakdown reaches the backend through the generated `commands.*` bindings
 * (`app_data_usage`, `remove_app_data_category`, `history_clear`), which invoke
 * Tauri directly rather than going through `window.nativeBridge` — so the fake
 * has to sit on `__TAURI_INTERNALS__`, the same seam `AboutSettingsPanel.test`
 * uses. Returns the recorded calls plus the restore the caller runs in `finally`
 * (the shared happy-dom window is reused by every other test file).
 */
function installInvoke(handler: (cmd: string, args?: unknown) => unknown): {
	calls: InvokeCall[];
	restore: () => void;
} {
	const tauriWindow = window as unknown as Window & {
		__TAURI_INTERNALS__: TauriInternals;
	};
	const previous = tauriWindow.__TAURI_INTERNALS__.invoke;
	const calls: InvokeCall[] = [];
	tauriWindow.__TAURI_INTERNALS__.invoke = async (cmd, args) => {
		calls.push({ args, cmd });
		return handler(cmd, args);
	};
	return {
		calls,
		restore: () => {
			tauriWindow.__TAURI_INTERNALS__.invoke = previous;
		},
	};
}

/** Deliberately unsorted, and with two empty categories, so the component's own
 *  sort + zero-filter are what the assertions observe. Sizes are exact MiB
 *  multiples so `formatBytes` output is stable to the character. */
const ENTRIES: AppDataUsageEntry[] = [
	{ bytes: 0, key: "logs" },
	{ bytes: 50 * MIB, key: "history" },
	{ bytes: 400 * MIB, key: "stt" },
	{ bytes: 100 * MIB, key: "other" },
	{ bytes: 200 * MIB, key: "tts" },
	{ bytes: 0, key: "dictionary" },
];

function renderBreakdown() {
	return render(
		<IntlProvider>
			<AppDataUsageBreakdown />
		</IntlProvider>,
	);
}

describe("AppDataUsageBreakdown", () => {
	test("lists one row per non-zero category, largest first", async () => {
		const { restore } = installInvoke((cmd) =>
			cmd === "app_data_usage" ? ENTRIES : undefined,
		);
		try {
			renderBreakdown();

			await screen.findByRole("group", { name: "Speech-to-Text models" });
			expect(
				screen
					.getAllByRole("group")
					.map((row) => row.getAttribute("aria-label")),
			).toEqual([
				"Speech-to-Text models",
				"Text-to-Speech models",
				"Other",
				"Transcription history",
			]);

			// 400 of 750 MiB — the share is computed against the total of ALL
			// entries, including the ones filtered out of the list.
			const stt = screen.getByRole("group", {
				name: "Speech-to-Text models",
			});
			expect(stt.textContent).toContain("400 MB");
			expect(stt.textContent).toContain("53%");
		} finally {
			restore();
		}
	});

	test("omits categories with no bytes on disk", async () => {
		const { restore } = installInvoke((cmd) =>
			cmd === "app_data_usage" ? ENTRIES : undefined,
		);
		try {
			renderBreakdown();

			await screen.findByRole("group", { name: "Speech-to-Text models" });
			expect(screen.queryByRole("group", { name: "Logs" })).toBeNull();
			expect(screen.queryByRole("group", { name: "Dictionary" })).toBeNull();
		} finally {
			restore();
		}
	});

	test("saved voices are their own row, removable apart from the models", async () => {
		// They live under the same `tts` folder on disk but are NOT a cache: the
		// clips were recorded or picked by hand, so "remove the TTS models" must
		// not be the gesture that destroys them.
		const { calls, restore } = installInvoke((cmd) => {
			if (cmd === "app_data_usage") {
				return [...ENTRIES, { bytes: 25 * MIB, key: "voices" }];
			}
			if (cmd === "remove_app_data_category") {
				return [];
			}
			return undefined;
		});
		try {
			renderBreakdown();

			const voices = await screen.findByRole("group", { name: "Voices" });
			expect(voices.textContent).toContain("25 MB");

			fireEvent.click(screen.getByRole("button", { name: "Remove Voices" }));
			expect(await screen.findByText("Remove Voices?")).toBeDefined();
			fireEvent.click(screen.getByRole("button", { name: "Remove" }));

			await waitFor(() => {
				expect(
					calls.find((call) => call.cmd === "remove_app_data_category")?.args,
				).toEqual({ key: "voices" });
			});
		} finally {
			restore();
		}
	});

	test("renders the total through the appDataTotalUsed key", async () => {
		const { restore } = installInvoke((cmd) =>
			cmd === "app_data_usage" ? ENTRIES : undefined,
		);
		try {
			renderBreakdown();

			expect(await screen.findByText("Application data on disk")).toBeDefined();
			// 400 + 200 + 100 + 50 MiB, rendered by `{size} used`.
			expect(screen.getByText("750 MB used")).toBeDefined();
		} finally {
			restore();
		}
	});

	test("gives the non-removable 'other' category no remove action", async () => {
		const { restore } = installInvoke((cmd) =>
			cmd === "app_data_usage" ? ENTRIES : undefined,
		);
		try {
			renderBreakdown();

			const other = await screen.findByRole("group", { name: "Other" });
			expect(within(other).queryAllByRole("button")).toHaveLength(0);
			// Every other row keeps its own, individually-named action.
			expect(
				screen.getByRole("button", { name: "Remove Speech-to-Text models" }),
			).toBeDefined();
		} finally {
			restore();
		}
	});

	test("routes a confirmed history removal to historyClear", async () => {
		const { calls, restore } = installInvoke((cmd) => {
			if (cmd === "app_data_usage") {
				return ENTRIES;
			}
			return undefined;
		});
		try {
			renderBreakdown();

			fireEvent.click(
				await screen.findByRole("button", {
					name: "Remove Transcription history",
				}),
			);
			expect(
				await screen.findByText("Remove Transcription history?"),
			).toBeDefined();
			// The dialog's confirm is the only control whose accessible name is the
			// bare "Remove"; every row button is named "Remove {category}".
			fireEvent.click(screen.getByRole("button", { name: "Remove" }));

			await waitFor(() => {
				expect(calls.some((call) => call.cmd === "history_clear")).toBe(true);
			});
			expect(
				calls.some((call) => call.cmd === "remove_app_data_category"),
			).toBe(false);
		} finally {
			restore();
		}
	});

	test("routes every other confirmed removal to removeAppDataCategory", async () => {
		const { calls, restore } = installInvoke((cmd) => {
			if (cmd === "app_data_usage") {
				return ENTRIES;
			}
			if (cmd === "remove_app_data_category") {
				return [];
			}
			return undefined;
		});
		try {
			renderBreakdown();

			fireEvent.click(
				await screen.findByRole("button", {
					name: "Remove Speech-to-Text models",
				}),
			);
			expect(
				await screen.findByText("Remove Speech-to-Text models?"),
			).toBeDefined();
			fireEvent.click(screen.getByRole("button", { name: "Remove" }));

			await waitFor(() => {
				expect(
					calls.find((call) => call.cmd === "remove_app_data_category")?.args,
				).toEqual({ key: "stt" });
			});
			expect(calls.some((call) => call.cmd === "history_clear")).toBe(false);
			// The list refreshes itself so the freed space is reflected immediately.
			await waitFor(() => {
				expect(
					calls.filter((call) => call.cmd === "app_data_usage"),
				).toHaveLength(2);
			});
		} finally {
			restore();
		}
	});

	test("dismissing the confirm dialog removes nothing", async () => {
		const { calls, restore } = installInvoke((cmd) =>
			cmd === "app_data_usage" ? ENTRIES : undefined,
		);
		try {
			renderBreakdown();

			fireEvent.click(
				await screen.findByRole("button", {
					name: "Remove Text-to-Speech models",
				}),
			);
			expect(
				await screen.findByText("Remove Text-to-Speech models?"),
			).toBeDefined();
			fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

			await waitFor(() => {
				expect(screen.queryByText("Remove Text-to-Speech models?")).toBeNull();
			});
			expect(
				calls.some(
					(call) =>
						call.cmd === "remove_app_data_category" ||
						call.cmd === "history_clear",
				),
			).toBe(false);
		} finally {
			restore();
		}
	});

	test("renders nothing while entries are unresolved and when nothing is on disk", async () => {
		const { restore } = installInvoke((cmd) =>
			cmd === "app_data_usage" ? [] : undefined,
		);
		try {
			const { container } = renderBreakdown();

			// entries === null: the fetch has not resolved yet.
			expect(container.textContent).toBe("");

			// total === 0: resolved, but every category is empty.
			await waitFor(() => {
				expect(screen.queryAllByRole("group")).toHaveLength(0);
			});
			expect(container.textContent).toBe("");
		} finally {
			restore();
		}
	});

	test("renders nothing when every reported category is empty", async () => {
		const { restore } = installInvoke((cmd) =>
			cmd === "app_data_usage"
				? [
						{ bytes: 0, key: "stt" },
						{ bytes: 0, key: "history" },
					]
				: undefined,
		);
		try {
			const { container } = renderBreakdown();

			await waitFor(() => {
				expect(screen.queryAllByRole("group")).toHaveLength(0);
			});
			expect(container.textContent).toBe("");
		} finally {
			restore();
		}
	});

	test("survives a failing app_data_usage read", async () => {
		const { restore } = installInvoke((cmd) => {
			if (cmd === "app_data_usage") {
				throw new Error("usage read failed");
			}
			return undefined;
		});
		try {
			const { container } = renderBreakdown();

			await waitFor(() => {
				expect(container.textContent).toBe("");
			});
		} finally {
			restore();
		}
	});
});
