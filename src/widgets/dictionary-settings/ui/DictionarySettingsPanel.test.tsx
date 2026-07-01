import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
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

	test("shows the entry count badge when entries exist", () => {
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
		expect(screen.getByText("1")).toBeDefined();
	});
});
