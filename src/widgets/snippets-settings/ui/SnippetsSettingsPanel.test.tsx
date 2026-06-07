import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import { useSettingsStore } from "@/entities/setting";
import { SnippetsSettingsPanel } from "./SnippetsSettingsPanel";

const initial = useSettingsStore.getState().settings;

beforeEach(() => {
	useSettingsStore.setState({ settings: { ...initial, snippets: [] } });
});

afterEach(() => {
	useSettingsStore.setState({ settings: initial });
});

describe("SnippetsSettingsPanel", () => {
	test("renders without crashing", () => {
		const { container } = render(
			<IntlProvider>
				<SnippetsSettingsPanel />
			</IntlProvider>,
		);
		expect(container.firstElementChild).not.toBeNull();
	});

	test("renders existing snippets", () => {
		useSettingsStore.setState({
			settings: {
				...initial,
				snippets: [{ id: "1", trigger: "/sig", expansion: "Best,\nSan" }],
			},
		});
		const { container } = render(
			<IntlProvider>
				<SnippetsSettingsPanel />
			</IntlProvider>,
		);
		expect(container.textContent).toContain("/sig");
	});

	test("edits an existing snippet", async () => {
		useSettingsStore.setState({
			settings: {
				...initial,
				snippets: [{ id: "1", trigger: "/sig", expansion: "Best regards" }],
			},
		});

		render(
			<IntlProvider>
				<SnippetsSettingsPanel />
			</IntlProvider>,
		);

		fireEvent.click(screen.getByRole("button", { name: /edit\s+"\/sig"/i }));
		fireEvent.change(screen.getByDisplayValue("/sig"), {
			target: { value: " /bye " },
		});
		fireEvent.change(screen.getByDisplayValue("Best regards"), {
			target: { value: " See you soon " },
		});
		fireEvent.click(screen.getByRole("button", { name: /save\s+"\/sig"/i }));

		await waitFor(() => {
			expect(useSettingsStore.getState().settings.snippets).toEqual([
				{ id: "1", trigger: "/bye", expansion: "See you soon" },
			]);
		});
		expect(screen.getByText("/bye")).toBeDefined();
		expect(screen.getByText("See you soon")).toBeDefined();
	});
});
