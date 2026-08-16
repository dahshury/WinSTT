import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import {
	configSnapshotFromSavedConfiguration,
	type AppProfileRule,
} from "../model/app-profile-rules";
import { BUILTIN_CONFIGURATIONS } from "../model/configurations";
import { useAppProfileIndicatorStore } from "../model/use-app-profile-indicator";
import { AppProfileRuleDialog } from "./AppProfileRuleDialog";
import {
	buildAppProfileAppOptions,
	reconcileAppProfileRules,
} from "./app-profile-rules-grid-helpers";
import {
	AppProfileRulesGrid,
	ConfigurationPickerCell,
} from "./AppProfileRulesGrid";

const RUNNING_APP = {
	exe: "chatgpt.exe",
	icon: null,
	id: "chatgpt.exe",
	label: "AI Prompt",
	title: null,
};

function profileRule(index: number): AppProfileRule {
	const configuration = BUILTIN_CONFIGURATIONS[0];
	if (!configuration) {
		throw new Error("Expected a built-in configuration");
	}
	return {
		appExe: `app-${index}.exe`,
		config: configSnapshotFromSavedConfiguration(configuration.config),
		configurationId: configuration.id,
		configurationName: configuration.name,
		enabled: true,
		id: `rule-${index}`,
		titlePattern: "",
		urlPattern: "",
	};
}

function renderGrid(count: number) {
	const onChange = mock((_rules: AppProfileRule[]) => undefined);
	const rules = Array.from({ length: count }, (_, index) =>
		profileRule(index + 1),
	);
	const result = render(
		<IntlProvider>
			<AppProfileRulesGrid
				apps={[RUNNING_APP]}
				configurations={[...BUILTIN_CONFIGURATIONS]}
				enabled={true}
				fallback="Default profile"
				onChange={onChange}
				rules={rules}
			/>
		</IntlProvider>,
	);
	return { ...result, onChange };
}

// The row aria-label interpolates the display label, which for these fixtures is
// the exe itself (RUNNING_APP is chatgpt.exe, the fixtures are app-N.exe).
function ruleRow(index: number): HTMLElement {
	return screen.getByRole("group", {
		name: `Per-app rule for app-${index}.exe`,
	});
}

function allRuleRows(): HTMLElement[] {
	// Scoped by name: each row also nests the picker's own "Configuration" group,
	// so a bare getAllByRole("group") returns two elements per rule.
	return screen.queryAllByRole("group", { name: /^Per-app rule for / });
}

describe("AppProfileRulesGrid", () => {
	// The indicator store is a process-global singleton; a leaked `current` would
	// paint the "Active now" pill onto an unrelated test's rows.
	beforeEach(() => {
		useAppProfileIndicatorStore.getState().clear();
	});
	afterEach(() => {
		useAppProfileIndicatorStore.getState().clear();
	});

	test("adds a rule from the add affordance and opens the matcher dialog for it", async () => {
		const { onChange } = renderGrid(0);

		expect(screen.queryByRole("grid")).toBeNull();
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "Add rule" }));
			await new Promise<void>((resolve) =>
				requestAnimationFrame(() => resolve()),
			);
		});

		expect(onChange).toHaveBeenCalledTimes(1);
		const addedRules = onChange.mock.calls[0]?.[0];
		expect(addedRules).toHaveLength(1);
		expect(addedRules?.[0]?.appExe).toBe("chatgpt.exe");
		expect(addedRules?.[0]?.configurationId).toBe(
			BUILTIN_CONFIGURATIONS[0]?.id,
		);
		const dialog = screen.getByRole("dialog");
		const appInput = within(dialog).getByLabelText(
			"App executable",
		) as HTMLInputElement;
		expect(appInput).toBeDefined();
		expect(
			within(dialog).getByLabelText("Window title contains"),
		).toBeDefined();
		expect(within(dialog).getByLabelText("Website domain")).toBeDefined();
		expect(within(dialog).queryByLabelText("Configuration")).toBeNull();
		expect(screen.getByText("Everything else")).toBeDefined();
	});

	test("uses the context-app single picker and still accepts a custom executable", async () => {
		const onSave = mock((_rule: AppProfileRule) => undefined);
		render(
			<IntlProvider>
				<AppProfileRuleDialog
					apps={[RUNNING_APP]}
					onClose={() => undefined}
					onSave={onSave}
					rule={profileRule(1)}
				/>
			</IntlProvider>,
		);

		const dialog = screen.getByRole("dialog");
		const appInput = within(dialog).getByLabelText(
			"App executable",
		) as HTMLInputElement;
		await act(async () => {
			fireEvent.click(appInput);
			await new Promise<void>((resolve) =>
				requestAnimationFrame(() => resolve()),
			);
		});
		expect(screen.getByRole("checkbox", { name: "AI Prompt" })).toBeDefined();

		fireEvent.change(appInput, { target: { value: "custom-tool.exe" } });
		expect(appInput.value).toBe("custom-tool.exe");
		await act(async () => {
			fireEvent.click(within(dialog).getByText("Save rule"));
			await new Promise<void>((resolve) =>
				requestAnimationFrame(() => resolve()),
			);
		});

		expect(onSave).toHaveBeenCalledTimes(1);
		expect(onSave.mock.calls[0]?.[0].appExe).toBe("custom-tool.exe");
	});

	test("renders each rule as one addressable line with no grid chrome", () => {
		const { container } = renderGrid(1);

		// The table is gone: no grid, no headers, no selection/row-number column,
		// no pagination, and none of the grid's sizing custom properties.
		expect(screen.queryByRole("grid")).toBeNull();
		expect(screen.queryAllByRole("columnheader")).toHaveLength(0);
		expect(screen.queryAllByRole("row")).toHaveLength(0);
		expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
		expect(screen.queryByText("Configuration")).toBeNull();
		expect(screen.queryByText("Edit per-app rule")).toBeNull();
		expect(screen.queryByText("Add row")).toBeNull();
		expect(screen.queryByRole("navigation")).toBeNull();
		expect(screen.queryByRole("button", { name: "Sort" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Move rule up" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Move rule down" })).toBeNull();
		expect(container.querySelectorAll("[style*='--col-']")).toHaveLength(0);

		const rows = allRuleRows();
		expect(rows).toHaveLength(1);
		const row = rows[0];
		if (!row) {
			throw new Error("Expected a rule row");
		}
		// Everything that acts on the rule lives inside the rule's own group.
		expect(
			within(row).getByRole("button", { name: "Edit per-app rule" }),
		).toBeDefined();
		expect(within(row).getByRole("combobox")).toBeDefined();
		expect(within(row).getByRole("switch")).toBeDefined();
		expect(
			within(row).getByRole("button", { name: "Delete rule" }),
		).toBeDefined();
	});

	test("renders every rule at once instead of paginating", () => {
		renderGrid(6);

		expect(allRuleRows()).toHaveLength(6);
		for (let index = 1; index <= 6; index += 1) {
			expect(ruleRow(index)).toBeDefined();
		}
		expect(screen.queryByRole("navigation")).toBeNull();
		expect(screen.queryByRole("button", { name: "Next page" })).toBeNull();
	});

	test("deletes a rule from its own row", () => {
		const { onChange } = renderGrid(2);

		fireEvent.click(
			within(ruleRow(1)).getByRole("button", { name: "Delete rule" }),
		);

		expect(onChange).toHaveBeenCalledTimes(1);
		const next = onChange.mock.calls[0]?.[0];
		expect(next?.map((rule) => rule.id)).toEqual(["rule-2"]);
	});

	test("toggling a rule writes only that rule", () => {
		const { onChange } = renderGrid(2);

		fireEvent.click(within(ruleRow(2)).getByRole("switch"));

		expect(onChange).toHaveBeenCalledTimes(1);
		const next = onChange.mock.calls[0]?.[0] ?? [];
		expect(next.find((rule) => rule.id === "rule-2")?.enabled).toBe(false);
		expect(next.find((rule) => rule.id === "rule-1")?.enabled).toBe(true);
	});

	test("shows the empty state when there are no rules", () => {
		renderGrid(0);

		expect(
			screen.getByText(
				"No rules yet. Everything uses the default configuration.",
			),
		).toBeDefined();
		expect(allRuleRows()).toHaveLength(0);
		expect(screen.getByRole("button", { name: "Add rule" })).toBeDefined();
	});

	test("closes with the fallback row after the rules and the add affordance", () => {
		const { container } = renderGrid(2);

		const root = container.firstElementChild;
		const fallbackRow = root?.lastElementChild;
		expect(fallbackRow?.textContent).toContain("Everything else");
		expect(fallbackRow?.textContent).toContain("Default profile");
		// `Node.DOCUMENT_POSITION_FOLLOWING` (4): the fallback row comes after both
		// the last rule and the add affordance, so it reads as the catch-all.
		const addButton = screen.getByRole("button", { name: "Add rule" });
		expect(
			ruleRow(2).compareDocumentPosition(addButton) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeGreaterThan(0);
		expect(
			addButton.compareDocumentPosition(fallbackRow as Node) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeGreaterThan(0);
	});

	// Keyed on the rule id the native side resolved, NOT on the foreground exe:
	// the exe here belongs to no row at all, and the pill still lands on rule-2.
	// Matching by exe lit up every row sharing it (two title-scoped rules for the
	// same browser) and no row at all for a title- or url-only rule.
	test("pins the active-rule pill to the rule the broadcast names", () => {
		const configuration = BUILTIN_CONFIGURATIONS[0];
		if (!configuration) {
			throw new Error("Expected a built-in configuration");
		}
		useAppProfileIndicatorStore.getState().show({
			appExe: "chrome.exe",
			configurationName: configuration.name,
			ruleId: "rule-2",
		});
		renderGrid(3);

		// Queried by text, not by accessible name: `status` is not a
		// name-from-content role, so `getByRole("status", { name: … })` never
		// matches this pill even though the text is right there.
		expect(within(ruleRow(2)).getByRole("status").textContent).toBe(
			"Active now",
		);
		expect(within(ruleRow(1)).queryByText("Active now")).toBeNull();
		expect(within(ruleRow(3)).queryByText("Active now")).toBeNull();
		expect(screen.getAllByText("Active now")).toHaveLength(1);

		act(() => {
			useAppProfileIndicatorStore.getState().clear();
		});
		expect(screen.queryByText("Active now")).toBeNull();
	});

	// Two rules on the SAME executable, told apart only by their window-title
	// matcher. The distinction was visible but never in an accessible name, so
	// both rows announced as "Per-app rule for chrome.exe" — and both lit up as
	// active when either fired.
	test("keeps same-app rules addressable and pins the pill to the one that fired", () => {
		const configuration = BUILTIN_CONFIGURATIONS[0];
		if (!configuration) {
			throw new Error("Expected a built-in configuration");
		}
		const rules: AppProfileRule[] = [
			{ ...profileRule(1), appExe: "chrome.exe", titlePattern: "Gmail" },
			{ ...profileRule(2), appExe: "chrome.exe", titlePattern: "GitHub" },
		];
		useAppProfileIndicatorStore.getState().show({
			appExe: "chrome.exe",
			configurationName: configuration.name,
			ruleId: "rule-2",
		});
		render(
			<IntlProvider>
				<AppProfileRulesGrid
					apps={[RUNNING_APP]}
					configurations={[...BUILTIN_CONFIGURATIONS]}
					enabled={true}
					fallback="Default profile"
					onChange={() => undefined}
					rules={rules}
				/>
			</IntlProvider>,
		);

		const gmail = screen.getByRole("group", {
			name: "Per-app rule for chrome.exe — chrome.exe · title contains “Gmail”",
		});
		const github = screen.getByRole("group", {
			name: "Per-app rule for chrome.exe — chrome.exe · title contains “GitHub”",
		});
		expect(within(github).getByRole("status").textContent).toBe("Active now");
		expect(within(gmail).queryByText("Active now")).toBeNull();
	});

	// Two clicks on "Add rule" used to seed the same executable twice, producing
	// two rules with nothing — not even an accessible name — to tell them apart.
	test("seeds a new rule with an app no existing rule claims", () => {
		const onChange = mock((_rules: AppProfileRule[]) => undefined);
		const secondApp = {
			exe: "code.exe",
			icon: null,
			id: "code.exe",
			label: "Editor",
			title: null,
		};
		render(
			<IntlProvider>
				<AppProfileRulesGrid
					apps={[RUNNING_APP, secondApp]}
					configurations={[...BUILTIN_CONFIGURATIONS]}
					enabled={true}
					fallback="Default profile"
					onChange={onChange}
					rules={[{ ...profileRule(1), appExe: RUNNING_APP.exe }]}
				/>
			</IntlProvider>,
		);
		fireEvent.click(screen.getByRole("button", { name: "Add rule" }));

		const next = onChange.mock.calls[0]?.[0] ?? [];
		expect(next[1]?.appExe).toBe(secondApp.exe);
	});

	test("uses the selection-only preset combobox with navigation arrows", () => {
		const onSelect = mock((_id: string) => undefined);
		render(
			<IntlProvider>
				<ConfigurationPickerCell
					configurations={BUILTIN_CONFIGURATIONS}
					disabled={false}
					onSelect={onSelect}
					value={BUILTIN_CONFIGURATIONS[0]?.id ?? ""}
				/>
			</IntlProvider>,
		);

		// Derived, not hardcoded: the shipped list grows (and "Default" was later
		// prepended to head it), so naming an entry here would break on every
		// addition without testing anything about the combobox.
		expect((screen.getByRole("combobox") as HTMLInputElement).value).toBe(
			BUILTIN_CONFIGURATIONS[0]?.name ?? "",
		);
		fireEvent.click(screen.getByRole("button", { name: "Next preset" }));
		expect(onSelect).toHaveBeenCalledWith(BUILTIN_CONFIGURATIONS[1]?.id);
		expect(screen.queryByRole("button", { name: /delete/i })).toBeNull();
		expect(screen.queryByRole("button", { name: /drag/i })).toBeNull();
	});

	test("offers running and already-saved apps as selectable values", () => {
		const options = buildAppProfileAppOptions([RUNNING_APP], [profileRule(2)]);

		expect(options).toEqual([
			{ label: "AI Prompt — chatgpt.exe", value: "chatgpt.exe" },
			{ label: "app-2.exe", value: "app-2.exe" },
		]);
	});

	test("refreshes the saved snapshot when the configuration cell changes", () => {
		const nextConfiguration = BUILTIN_CONFIGURATIONS[1];
		if (!nextConfiguration) {
			throw new Error("Expected a second built-in configuration");
		}
		const [reconciled] = reconcileAppProfileRules(
			[
				{
					...profileRule(1),
					appExe: "C:\\Program Files\\ChatGPT.EXE",
					configurationId: nextConfiguration.id,
				},
			],
			BUILTIN_CONFIGURATIONS,
		);

		expect(reconciled?.appExe).toBe("chatgpt.exe");
		expect(reconciled?.configurationName).toBe(nextConfiguration.name);
		expect(reconciled?.config).toEqual(
			configSnapshotFromSavedConfiguration(nextConfiguration.config),
		);
	});
});
