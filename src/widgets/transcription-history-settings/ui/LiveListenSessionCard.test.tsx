import { describe, expect, mock, test } from "bun:test";
import { render } from "@testing-library/react";
import { LiveListenSessionCardView } from "./LiveListenSessionCard";

const baseProps = {
	canFinalize: true,
	emptyLabel: "Waiting for speech…",
	finalizeLabel: "Save as entry",
	finalizing: false,
	livePreview: "",
	onFinalize: () => undefined,
	title: "Listening now",
};

describe("LiveListenSessionCardView", () => {
	test("renders committed lines and the in-flight preview", () => {
		const { getByText } = render(
			<LiveListenSessionCardView
				{...baseProps}
				lines={["Speaker 1: hello there", "and welcome"]}
				livePreview="the next sen"
			/>,
		);
		expect(getByText("Speaker 1: hello there")).toBeTruthy();
		expect(getByText("and welcome")).toBeTruthy();
		expect(getByText("the next sen")).toBeTruthy();
	});

	test("shows the waiting placeholder for a silent session", () => {
		const { getByText } = render(
			<LiveListenSessionCardView {...baseProps} lines={[]} />,
		);
		expect(getByText("Waiting for speech…")).toBeTruthy();
	});

	test("finalize button fires only when finalizable", () => {
		const onFinalize = mock(() => undefined);
		const { getByText, rerender } = render(
			<LiveListenSessionCardView
				{...baseProps}
				lines={["hello"]}
				onFinalize={onFinalize}
			/>,
		);
		getByText("Save as entry").closest("button")?.click();
		expect(onFinalize).toHaveBeenCalledTimes(1);

		// No committed lines yet → the button is disabled and inert.
		rerender(
			<LiveListenSessionCardView
				{...baseProps}
				canFinalize={false}
				lines={[]}
				onFinalize={onFinalize}
			/>,
		);
		const button = getByText("Save as entry").closest("button");
		expect(button?.disabled).toBe(true);
		button?.click();
		expect(onFinalize).toHaveBeenCalledTimes(1);
	});
});
