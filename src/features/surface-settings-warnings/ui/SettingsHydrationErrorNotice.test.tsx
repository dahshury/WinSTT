import { afterEach, describe, expect, test } from "bun:test";
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
} from "@testing-library/react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import { useSettingsHydrationStore } from "@/entities/setting";
import { SettingsHydrationErrorNotice } from "./SettingsHydrationErrorNotice";

afterEach(() => {
	cleanup();
	useSettingsHydrationStore.getState().reset();
});

function renderNotice() {
	return render(
		<IntlProvider>
			<SettingsHydrationErrorNotice />
		</IntlProvider>,
	);
}

describe("SettingsHydrationErrorNotice", () => {
	test("renders nothing while hydration is healthy", () => {
		useSettingsHydrationStore.getState().setStatus("ready");
		const { container } = renderNotice();
		expect(container.querySelector('[role="alert"]')).toBeNull();
	});

	test("shows the error surface with a Retry action on hydration error", () => {
		useSettingsHydrationStore.getState().setStatus("error", "boom");
		renderNotice();
		expect(screen.getByRole("alert")).toBeTruthy();
		expect(screen.getByRole("button", { name: /retry/i })).toBeTruthy();
	});

	test("Retry bumps the retry token so the sync hook re-hydrates", () => {
		useSettingsHydrationStore.getState().setStatus("error", "boom");
		const before = useSettingsHydrationStore.getState().retryToken;
		renderNotice();
		fireEvent.click(screen.getByRole("button", { name: /retry/i }));
		expect(useSettingsHydrationStore.getState().retryToken).toBe(before + 1);
	});

	test("shows a reconnecting state while a retry is in flight", () => {
		useSettingsHydrationStore.getState().setStatus("error", "boom");
		renderNotice();
		fireEvent.click(screen.getByRole("button", { name: /retry/i }));
		// The sync hook would flip status to `loading` on the retry token change.
		act(() => useSettingsHydrationStore.getState().setStatus("loading"));
		expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();
		expect(screen.getByText(/Reconnecting/i)).toBeTruthy();
	});
});
