import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import { useSettingsStore } from "@/entities/setting";
import { AudioVisualizer } from "./AudioVisualizer";

const initialSettings = useSettingsStore.getState().settings;

beforeEach(() => {
	useSettingsStore.setState({
		settings: {
			...initialSettings,
			general: {
				...initialSettings.general,
				visualizerType: "bar",
				visualizerBarCount: 9,
			},
		},
	});
});

afterEach(() => {
	useSettingsStore.setState({ settings: initialSettings });
});

describe("AudioVisualizer", () => {
	test.each(["bar", "grid", "radial", "wave", "aura"] as const)(
		"renders without throwing when settings.visualizerType=%s",
		(type) => {
			useSettingsStore.setState({
				settings: {
					...initialSettings,
					general: {
						...initialSettings.general,
						visualizerType: type,
						visualizerBarCount: 9,
					},
				},
			});
			const { container, unmount } = render(<AudioVisualizer />);
			expect(container.firstElementChild).not.toBeNull();
			unmount();
		},
	);

	test("size='auto' wraps in a flex container", () => {
		const { container } = render(<AudioVisualizer size="auto" />);
		const wrapper = container.firstElementChild as HTMLElement;
		expect(wrapper.className).toContain("flex");
	});

	test("default size 'lg' renders the bar variant", () => {
		const { container } = render(<AudioVisualizer />);
		expect(container.firstElementChild).not.toBeNull();
	});
});
