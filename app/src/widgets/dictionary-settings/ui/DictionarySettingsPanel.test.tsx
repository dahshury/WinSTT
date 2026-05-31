import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
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
			</IntlProvider>
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
			</IntlProvider>
		);
		expect(container.textContent).toContain("Kubernetes");
	});
});
