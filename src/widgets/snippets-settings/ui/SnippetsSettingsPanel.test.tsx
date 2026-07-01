import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
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

	test("shows the entry count badge when snippets exist", () => {
		useSettingsStore.setState({
			settings: {
				...initial,
				snippets: [{ expansion: "Best,\nSan", id: "1", trigger: "/sig" }],
			},
		});
		render(
			<IntlProvider>
				<SnippetsSettingsPanel />
			</IntlProvider>,
		);
		expect(screen.getByText("1")).toBeDefined();
	});
});
