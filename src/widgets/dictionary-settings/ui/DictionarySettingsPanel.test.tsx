import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import { useSettingsStore } from "@/entities/setting";
import { DictionarySettingsPanel } from "./DictionarySettingsPanel";

const initial = useSettingsStore.getState().settings;

beforeEach(() => {
	useSettingsStore.setState({ settings: { ...initial, dictionary: [] } });
});

afterEach(() => {
	useSettingsStore.setState({ settings: initial });
});

describe("DictionarySettingsPanel", () => {
	test("renders without crashing", () => {
		const { container } = render(
			<IntlProvider>
				<DictionarySettingsPanel />
			</IntlProvider>,
		);
		expect(container.firstElementChild).not.toBeNull();
	});

	test("renders existing dictionary entries", () => {
		useSettingsStore.setState({
			settings: {
				...initial,
				dictionary: [{ id: "1", term: "Kubernetes" }],
			},
		});
		const { container } = render(
			<IntlProvider>
				<DictionarySettingsPanel />
			</IntlProvider>,
		);
		expect(container.textContent).toContain("Kubernetes");
	});

	test("adds the first term into an empty table immediately", async () => {
		render(
			<IntlProvider>
				<DictionarySettingsPanel />
			</IntlProvider>,
		);

		fireEvent.change(await screen.findByRole("textbox", { name: /term/i }), {
			target: { value: "Kubernetes" },
		});
		fireEvent.click(screen.getByRole("button", { name: /add/i }));

		await waitFor(() => {
			expect(
				useSettingsStore
					.getState()
					.settings.dictionary.map((entry) => entry.term),
			).toEqual(["Kubernetes"]);
		});
		expect(screen.getByText("Kubernetes")).toBeDefined();
	});

	test("does not append a duplicate term", async () => {
		useSettingsStore.setState({
			settings: {
				...initial,
				dictionary: [{ id: "1", term: "Kubernetes" }],
			},
		});

		render(
			<IntlProvider>
				<DictionarySettingsPanel />
			</IntlProvider>,
		);

		fireEvent.change(await screen.findByRole("textbox", { name: /term/i }), {
			target: { value: " kubernetes " },
		});
		fireEvent.click(screen.getByRole("button", { name: /add/i }));

		await waitFor(() => {
			expect(useSettingsStore.getState().settings.dictionary).toHaveLength(1);
		});
	});

	test("edits an existing dictionary entry", async () => {
		useSettingsStore.setState({
			settings: {
				...initial,
				dictionary: [{ id: "1", term: "Kubernetes" }],
			},
		});

		render(
			<IntlProvider>
				<DictionarySettingsPanel />
			</IntlProvider>,
		);

		fireEvent.doubleClick(screen.getByText("Kubernetes"));
		const input = screen.getByDisplayValue("Kubernetes");
		fireEvent.change(input, {
			target: { value: " DirectML " },
		});
		fireEvent.keyDown(input, { key: "Enter" });

		await waitFor(() => {
			expect(
				useSettingsStore
					.getState()
					.settings.dictionary.map((entry) => entry.term),
			).toEqual(["DirectML"]);
		});
		expect(screen.getByText("DirectML")).toBeDefined();
	});
});
