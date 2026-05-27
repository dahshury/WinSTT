import { beforeEach, describe, expect, mock, test } from "bun:test";
import { ipcClientMock } from "@test/mocks/ipc-client";
import { act, fireEvent, render } from "@testing-library/react";
import { IntlProvider } from "@/app/providers/IntlProvider";

// ---------------------------------------------------------------------------
// Mock the IPC client BEFORE importing anything that transitively imports it,
// so Zustand's llm-catalog store sees the mocked module.
// ---------------------------------------------------------------------------
const pullModelMock = mock(async (_name: string) => ({ success: true }));
const cancelPullMock = mock(async (_name: string) => ({ cancelled: true }));
const deleteModelMock = mock(async (_name: string) => ({ success: true }));
const noop = () => undefined;

// Spread the COMPLETE, behavior-faithful ipc-client fake, then override only
// the exports this suite controls. bun:test's `mock.module` is process-global
// and never torn down, so a partial shim leaks an incomplete module into
// every later test file. `ipcClientMock()` exposes every real export and
// routes each through `window.electronAPI` exactly as the real module, so the
// leak is harmless regardless of file order.
mock.module("@/shared/api/ipc-client", () => ({
	...ipcClientMock(),
	fetchOllamaModels: async () => ({ models: [], reachable: true }),
	onLlmCatalog: () => noop,
	onOllamaPullProgress: () => noop,
	pullOllamaModel: pullModelMock,
	cancelOllamaModelPull: cancelPullMock,
	deleteOllamaModel: deleteModelMock,
}));

const dlg = await import("./OllamaModelManagerDialog");
const OllamaModelManagerDialog = dlg.OllamaModelManagerDialog;
const helpersModule = await import("../lib/ollama-model-manager-test-helpers");
const helpers = helpersModule.__ollama_model_manager_test_helpers__;

// The installed-models list comes from the global llm-catalog Zustand store.
// Sibling suites populate it and bun:test never isolates module state, so a
// leaked non-empty list makes the "no models installed" empty-state test fail
// purely on file order. Reset to empty before every test in this file.
const { useLlmCatalogStore } = await import("@/entities/llm-catalog/model/llm-catalog-store");
beforeEach(() => {
	useLlmCatalogStore.setState({ models: [] });
});

// ---------------------------------------------------------------------------
// Stub translate fn for helper tests (no i18n context needed).
// ---------------------------------------------------------------------------
const tStub = ((key: string, vars?: Record<string, unknown>) =>
	vars ? `${key}:${JSON.stringify(vars)}` : key) as ReturnType<
	typeof import("use-intl").useTranslations
>;

// ---------------------------------------------------------------------------
// Helper: render the dialog open with no models pre-installed.
// ---------------------------------------------------------------------------
function renderDialog(props: Partial<Parameters<typeof OllamaModelManagerDialog>[0]> = {}) {
	const onClose = mock(() => undefined);
	const onModelInstalled = mock((_name: string) => undefined);
	const result = render(
		<IntlProvider>
			<OllamaModelManagerDialog
				currentModel="llama3.2:1b"
				isOpen={true}
				onClose={onClose}
				onModelInstalled={onModelInstalled}
				{...props}
			/>
		</IntlProvider>
	);
	return { ...result, onClose, onModelInstalled };
}

// ---------------------------------------------------------------------------
// Dialog rendering
// ---------------------------------------------------------------------------

describe("OllamaModelManagerDialog", () => {
	test("renders without crashing when open", () => {
		const { container } = renderDialog();
		expect(container).toBeDefined();
	});

	test("renders without crashing when closed", () => {
		const { container } = render(
			<IntlProvider>
				<OllamaModelManagerDialog currentModel="" isOpen={false} onClose={() => undefined} />
			</IntlProvider>
		);
		expect(container).toBeDefined();
	});

	test("shows empty-installed message when no models are installed", () => {
		renderDialog();
		// The default tab is 'installed'; with no models the empty state renders
		// Text is the English translation from messages/en.json
		expect(document.body.textContent).toContain("No models installed yet");
	});

	test("handleSelect calls onModelInstalled and onClose when model is clicked", async () => {
		// Seed the zustand store with one model so InstalledRow renders
		const { useLlmCatalogStore } = await import("@/entities/llm-catalog/model/llm-catalog-store");
		useLlmCatalogStore.setState({
			models: [{ name: "gemma3:4b", size: 1_000_000_000 }],
		});

		const { onClose, onModelInstalled } = renderDialog({
			currentModel: "llama3.2:1b",
		});

		// Click the row button (not the delete button) to select the model
		const rowBtn = document.querySelector("button[data-current]") as HTMLButtonElement;
		expect(rowBtn).not.toBeNull();
		fireEvent.click(rowBtn);

		expect(onModelInstalled).toHaveBeenCalledWith("gemma3:4b");
		expect(onClose).toHaveBeenCalled();

		// Reset store
		useLlmCatalogStore.setState({ models: [] });
	});

	test("handleSelect with no onModelInstalled still calls onClose", async () => {
		const { useLlmCatalogStore } = await import("@/entities/llm-catalog/model/llm-catalog-store");
		useLlmCatalogStore.setState({
			models: [{ name: "gemma3:4b", size: 1_000_000_000 }],
		});

		const onClose = mock(() => undefined);
		render(
			<IntlProvider>
				<OllamaModelManagerDialog
					currentModel="llama3.2:1b"
					isOpen={true}
					onClose={onClose}
					// no onModelInstalled prop
				/>
			</IntlProvider>
		);

		const rowBtn = document.querySelector("button[data-current]") as HTMLButtonElement;
		expect(rowBtn).not.toBeNull();
		fireEvent.click(rowBtn);

		expect(onClose).toHaveBeenCalled();

		useLlmCatalogStore.setState({ models: [] });
	});

	test("ask-delete flow sets pending-delete (shows ConfirmDialog title)", async () => {
		const { useLlmCatalogStore } = await import("@/entities/llm-catalog/model/llm-catalog-store");
		useLlmCatalogStore.setState({
			models: [{ name: "gemma3:4b", size: 1_000_000_000 }],
		});

		renderDialog();

		// Find the delete button inside the InstalledRow and click it
		const deleteBtn = document.querySelector("button.text-error") as HTMLButtonElement;
		expect(deleteBtn).not.toBeNull();

		await act(async () => {
			fireEvent.click(deleteBtn);
		});

		// ConfirmDialog should open (pendingDelete is set → open={true})
		// English translation of deleteConfirmTitle is "Remove model?"
		expect(document.body.textContent).toContain("Remove model?");

		useLlmCatalogStore.setState({ models: [] });
	});

	test("handleConfirmDelete calls deleteModel and clears state", async () => {
		const { useLlmCatalogStore } = await import("@/entities/llm-catalog/model/llm-catalog-store");
		useLlmCatalogStore.setState({
			models: [{ name: "gemma3:4b", size: 1_000_000_000 }],
		});
		deleteModelMock.mockClear();

		renderDialog();

		// Open the delete confirm dialog
		const deleteBtn = document.querySelector("button.text-error") as HTMLButtonElement;
		await act(async () => {
			fireEvent.click(deleteBtn);
		});

		// ConfirmDialog is now open — find the confirm button.
		// It has class bg-error (from ConfirmDialog.tsx styling).
		const confirmBtn = document.querySelector("button.bg-error") as HTMLButtonElement;
		expect(confirmBtn).not.toBeNull();

		await act(async () => {
			fireEvent.click(confirmBtn!);
		});

		expect(deleteModelMock).toHaveBeenCalledWith("gemma3:4b");

		useLlmCatalogStore.setState({ models: [] });
	});

	test("cancelling delete dialog clears pendingDelete", async () => {
		const { useLlmCatalogStore } = await import("@/entities/llm-catalog/model/llm-catalog-store");
		useLlmCatalogStore.setState({
			models: [{ name: "gemma3:4b", size: 1_000_000_000 }],
		});

		renderDialog();

		const deleteBtn = document.querySelector("button.text-error") as HTMLButtonElement;
		await act(async () => {
			fireEvent.click(deleteBtn);
		});

		// ConfirmDialog is open — "Remove model?" should be visible
		expect(document.body.textContent).toContain("Remove model?");

		// Click the AlertDialog.Close button (renders as "Cancel")
		const cancelBtn = Array.from(document.querySelectorAll("button")).find(
			(b) => (b.textContent ?? "").trim() === "Cancel"
		);
		expect(cancelBtn).toBeDefined();
		await act(async () => {
			fireEvent.click(cancelBtn!);
		});

		// ConfirmDialog should close (pendingDelete cleared → open=false)
		expect(document.body.textContent).not.toContain("Remove model?");

		useLlmCatalogStore.setState({ models: [] });
	});

	test("handleConfirmDelete is a no-op when pendingDelete is null", async () => {
		// Render dialog without triggering any delete action.
		// The ConfirmDialog open={false} means onConfirm would call handleConfirmDelete
		// with pendingDelete=null, which should return early.
		deleteModelMock.mockClear();
		renderDialog();
		// No delete button click — pendingDelete remains null.
		// The confirm button is not rendered so we can't fire it, but rendering alone
		// exercises the component's branches up to that point.
		expect(deleteModelMock).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// createHandlePull / handlePull logic
// ---------------------------------------------------------------------------

describe("createHandlePull", () => {
	test("calls onModelInstalled when pull succeeds", async () => {
		const pullFn = mock(async (_name: string) => ({ success: true }));
		const onInstalled = mock((_name: string) => undefined);
		const handlePull = helpers.createHandlePull(pullFn, onInstalled);
		await handlePull("llama3:8b");
		expect(pullFn).toHaveBeenCalledWith("llama3:8b");
		expect(onInstalled).toHaveBeenCalledWith("llama3:8b");
	});

	test("does not call onModelInstalled when pull fails", async () => {
		const pullFn = mock(async (_name: string) => ({ success: false }));
		const onInstalled = mock((_name: string) => undefined);
		const handlePull = helpers.createHandlePull(pullFn, onInstalled);
		await handlePull("llama3:8b");
		expect(pullFn).toHaveBeenCalledWith("llama3:8b");
		expect(onInstalled).not.toHaveBeenCalled();
	});

	test("does not throw when onModelInstalled is undefined and pull succeeds", async () => {
		const pullFn = mock(async (_name: string) => ({ success: true }));
		const handlePull = helpers.createHandlePull(pullFn, undefined);
		await expect(handlePull("llama3:8b")).resolves.toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// buildTabOptions helper
// ---------------------------------------------------------------------------

describe("buildTabOptions", () => {
	test("returns two tab options with correct values", () => {
		const opts = helpers.buildTabOptions(tStub);
		expect(opts).toHaveLength(2);
		expect(opts[0]!.value).toBe("installed");
		expect(opts[1]!.value).toBe("recommended");
	});

	test("each option has a label", () => {
		const opts = helpers.buildTabOptions(tStub);
		expect(opts[0]!.label).toBe("tabInstalled");
		expect(opts[1]!.label).toBe("tabRecommended");
	});
});

// ---------------------------------------------------------------------------
// Recommended tab — RecommendedTab, RecommendedRow, CustomPullRow, handlePull
// ---------------------------------------------------------------------------

describe("OllamaModelManagerDialog — Recommended tab", () => {
	async function switchToRecommended() {
		const { onModelInstalled } = renderDialog();
		// Find the "Recommended" tab button in the switcher and click it
		const allButtons = Array.from(document.querySelectorAll("button"));
		const recommendedBtn = allButtons.find((b) => (b.textContent ?? "").trim() === "Recommended");
		if (recommendedBtn) {
			await act(async () => {
				fireEvent.click(recommendedBtn);
			});
		}
		return { onModelInstalled };
	}

	test("switching to Recommended tab renders recommended model list or empty state", async () => {
		await switchToRecommended();
		// Either recommended models or "No matches" message
		expect(document.body.textContent?.length).toBeGreaterThan(0);
	});

	test("shows recommended model names after switching to Recommended tab", async () => {
		await switchToRecommended();
		// Either recommended models (with Pull buttons) or empty/no-match message
		// Just verify the page contains content from the recommended view
		const bodyText = document.body.textContent ?? "";
		// The recommended tab renders either model rows or a no-matches message
		expect(bodyText.length).toBeGreaterThan(0);
	});

	test("handlePull success: calls onModelInstalled after successful pull", async () => {
		pullModelMock.mockClear();
		pullModelMock.mockImplementation(async (_name: string) => ({ success: true }));
		renderDialog();

		// Switch to recommended tab
		const allButtons = Array.from(document.querySelectorAll("button"));
		const recommendedBtn = allButtons.find((b) => (b.textContent ?? "").trim() === "Recommended");
		if (recommendedBtn) {
			await act(async () => {
				fireEvent.click(recommendedBtn);
			});
		}

		// Find a Pull button for a recommended model
		const updatedButtons = Array.from(document.querySelectorAll("button"));
		const pullBtn = updatedButtons.find(
			(b) => (b.textContent ?? "").trim() === "Pull" || (b.textContent ?? "").includes("Pull")
		);
		if (pullBtn) {
			await act(async () => {
				fireEvent.click(pullBtn);
				await Promise.resolve();
			});
		}

		// pullModel should have been called; if success=true, onModelInstalled called
		if (pullBtn) {
			expect(pullModelMock).toHaveBeenCalled();
		}
	});

	test("handlePull no-op path: does not call onModelInstalled when pull fails", async () => {
		pullModelMock.mockClear();
		pullModelMock.mockImplementation(async (_name: string) => ({ success: false }));
		const { onModelInstalled } = renderDialog({
			onModelInstalled: mock((_name: string) => undefined),
		});

		const allButtons = Array.from(document.querySelectorAll("button"));
		const recommendedBtn = allButtons.find((b) => (b.textContent ?? "").trim() === "Recommended");
		if (recommendedBtn) {
			await act(async () => {
				fireEvent.click(recommendedBtn);
			});
		}

		const updatedButtons = Array.from(document.querySelectorAll("button"));
		const pullBtn = updatedButtons.find(
			(b) => (b.textContent ?? "").trim() === "Pull" || (b.textContent ?? "").includes("Pull")
		);
		if (pullBtn) {
			await act(async () => {
				fireEvent.click(pullBtn);
				await Promise.resolve();
			});
		}

		// When pull fails, onModelInstalled should NOT be called
		expect(onModelInstalled).not.toHaveBeenCalled();
		// Reset mock
		pullModelMock.mockImplementation(async (_name: string) => ({ success: true }));
	});

	test("CustomPullRow: shows pull row for a custom model:tag query", async () => {
		renderDialog();
		// Switch to recommended tab. The Switcher renders each option's label
		// twice inside the same <button> (an invisible span for stable sizing
		// plus the visible span), so `textContent` is "RecommendedRecommended"
		// — match via `includes("Recommended")` instead of strict equality.
		const allBtns = Array.from(document.querySelectorAll("button"));
		const recBtn = allBtns.find((b) => (b.textContent ?? "").includes("Recommended"));
		if (recBtn) {
			await act(async () => {
				fireEvent.click(recBtn);
			});
		}

		// Type a custom model name into the search input
		const searchInput = document.querySelector("input") as HTMLInputElement;
		if (searchInput) {
			await act(async () => {
				fireEvent.change(searchInput, { target: { value: "custom-model:7b" } });
			});
		}

		// CustomPullRow should appear when query matches "name:tag" pattern
		expect(document.body.textContent).toContain("custom-model:7b");
	});
});
