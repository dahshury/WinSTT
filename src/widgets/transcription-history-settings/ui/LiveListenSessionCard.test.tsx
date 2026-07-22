import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, render, screen } from "@testing-library/react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import { useSettingsStore } from "@/entities/setting";
import { IPC } from "@test/mocks/legacy-ipc";
import {
	LiveListenSessionCard,
	LiveListenSessionCardView,
} from "./LiveListenSessionCard";

const originalApi = window.nativeBridge;
const initialSettings = useSettingsStore.getState().settings;

afterEach(() => {
	cleanup();
	window.nativeBridge = originalApi;
	useSettingsStore.setState({ settings: initialSettings });
});

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

describe("LiveListenSessionCard", () => {
	test("renders pushed snapshots and unsubscribes outside Listen mode", async () => {
		const listeners = new Map<string, (...args: unknown[]) => void>();
		window.nativeBridge = {
			...originalApi,
			on: (channel, callback) => {
				listeners.set(channel, callback);
				return () => listeners.delete(channel);
			},
		};
		useSettingsStore.setState({
			settings: {
				...initialSettings,
				general: { ...initialSettings.general, recordingMode: "listen" },
			},
		});

		render(
			<IntlProvider>
				<LiveListenSessionCard />
			</IntlProvider>,
		);
		expect(listeners.has(IPC.LISTEN_SESSION_CHANGED)).toBe(true);

		act(() => {
			listeners.get(IPC.LISTEN_SESSION_CHANGED)?.({
				active: true,
				lines: ["Speaker 1: pushed line"],
				livePreview: "still speaking",
			});
		});
		expect(screen.getByText("Speaker 1: pushed line")).toBeTruthy();
		expect(screen.getByText("still speaking")).toBeTruthy();

		await act(async () => {
			useSettingsStore.setState({
				settings: {
					...initialSettings,
					general: { ...initialSettings.general, recordingMode: "ptt" },
				},
			});
			await Promise.resolve();
		});
		expect(listeners.has(IPC.LISTEN_SESSION_CHANGED)).toBe(false);
		expect(screen.queryByText("Speaker 1: pushed line")).toBeNull();
	});
});
