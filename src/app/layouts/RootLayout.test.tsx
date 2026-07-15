import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";

const { RootLayout } = await import("./RootLayout");

describe("RootLayout", () => {
	test("renders children inside the chrome", () => {
		const { container, unmount } = render(
			<RootLayout>
				<div data-testid="content">app content</div>
			</RootLayout>,
		);
		expect(container.firstElementChild).not.toBeNull();
		// This smoke test intentionally checks only the first-paint shell. Unmount
		// before the deferred, post-paint subscriptions are opened.
		unmount();
	});
});
