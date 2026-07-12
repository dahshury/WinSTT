import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import { useSmartEndpointDisabledNoticeStore } from "@/widgets/llm-settings/model/use-llm-settings-panel";
import { SmartEndpointDisabledNotice } from "./SmartEndpointDisabledNotice";

afterEach(() => {
	cleanup();
	useSmartEndpointDisabledNoticeStore.getState().clear();
});

function renderNotice() {
	return render(
		<IntlProvider>
			<SmartEndpointDisabledNotice />
		</IntlProvider>,
	);
}

describe("SmartEndpointDisabledNotice", () => {
	test("renders nothing until the notice is shown", () => {
		const { container } = renderNotice();
		expect(container.querySelector("[aria-live]")).toBeNull();
	});

	test("explains why Smart Endpoint was turned off", () => {
		useSmartEndpointDisabledNoticeStore.getState().show({});
		renderNotice();
		expect(screen.getByText(/Smart Endpoint turned off/i)).toBeTruthy();
		expect(screen.getByText(/finalize speech/i)).toBeTruthy();
	});

	test("dismissing clears the store slot", () => {
		useSmartEndpointDisabledNoticeStore.getState().show({});
		renderNotice();
		fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
		expect(useSmartEndpointDisabledNoticeStore.getState().current).toBeNull();
	});
});
