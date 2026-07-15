import { describe, expect, mock, test } from "bun:test";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import {
	configSnapshotFromSavedConfiguration,
	type AppProfileRule,
} from "../model/app-profile-rules";
import { BUILTIN_CONFIGURATIONS } from "../model/configurations";
import { AppProfileRuleDialog } from "./AppProfileRuleDialog";
import {
	AppProfileRulesGrid,
	buildAppProfileAppOptions,
	ConfigurationPickerCell,
	reconcileAppProfileRules,
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

describe("AppProfileRulesGrid", () => {
	test("uses the grid footer and opens the matcher dialog for the new rule", async () => {
		const { onChange } = renderGrid(0);

		expect(screen.getByRole("grid", { name: "Data grid" })).toBeDefined();
		await act(async () => {
			fireEvent.click(screen.getByText("Add row"));
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
					open={true}
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

	test("keeps configuration, matcher editor, and toggle as the grid columns", () => {
		renderGrid(1);

		const grid = screen.getByRole("grid", { name: "Data grid" });
		expect(screen.getByText("Configuration")).toBeDefined();
		expect(screen.getByText("Edit per-app rule")).toBeDefined();
		expect(grid.style.getPropertyValue("--col-select-size")).toBe("40");
		expect(grid.style.getPropertyValue("--col-configurationId-size")).toBe(
			"270",
		);
		expect(grid.style.getPropertyValue("--col-matcher-size")).toBe("200");
		expect(grid.style.getPropertyValue("--col-actions-size")).toBe("72");
		const configurationHeader = screen
			.getByText("Configuration")
			.closest('[role="columnheader"]');
		const matcherHeader = screen
			.getByText("Edit per-app rule")
			.closest('[role="columnheader"]');
		const actionHeader = screen.getAllByRole("columnheader").at(-1);
		expect(configurationHeader?.classList.contains("grow")).toBe(false);
		expect(matcherHeader?.classList.contains("grow")).toBe(false);
		expect(actionHeader?.classList.contains("grow")).toBe(true);
		expect(screen.queryByText("Window title contains")).toBeNull();
		expect(screen.queryByRole("button", { name: "Move rule up" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Move rule down" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Sort" })).toBeNull();
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

		expect((screen.getByRole("combobox") as HTMLInputElement).value).toBe(
			"AI Prompt",
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

	test("paginates profile rules at five rows per page", () => {
		renderGrid(6);

		const grid = screen.getByRole("grid", { name: "Data grid" });
		const pagination = screen.getByRole("navigation", {
			name: "Page 1 of 2",
		});
		// Five data rows plus the grid's add-row footer.
		expect(grid.getAttribute("aria-rowcount")).toBe("6");

		fireEvent.click(
			within(pagination).getByRole("button", { name: "Next page" }),
		);

		// One data row plus the same add-row footer.
		expect(grid.getAttribute("aria-rowcount")).toBe("2");
		expect(
			screen.getByRole("navigation", { name: "Page 2 of 2" }),
		).toBeDefined();
	});
});
