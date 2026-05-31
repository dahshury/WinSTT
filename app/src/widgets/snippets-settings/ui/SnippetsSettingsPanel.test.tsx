import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
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
			</IntlProvider>
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
			</IntlProvider>
		);
		expect(container.textContent).toContain("/sig");
	});
});
