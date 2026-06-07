import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import { useRevertNoticeStore } from "../model/revert-notice-store";
import { CloudKeyRevertNotice } from "./CloudKeyRevertNotice";

afterEach(() => {
	cleanup();
	useRevertNoticeStore.setState({ notices: [] });
});

function renderNotice() {
	return render(
		<IntlProvider>
			<CloudKeyRevertNotice />
		</IntlProvider>,
	);
}

describe("CloudKeyRevertNotice", () => {
	test("renders nothing when there are no notices", () => {
		const { container } = renderNotice();
		expect(container.querySelector('[role="status"]')).toBeNull();
	});

	test("renders a status toast naming the affected provider", () => {
		useRevertNoticeStore.getState().push("openrouter");
		renderNotice();
		expect(screen.getByRole("status")).toBeTruthy();
		// "OpenRouter" is the {provider} interpolation — present in every locale.
		expect(screen.getByText(/OpenRouter/)).toBeTruthy();
	});
});
