import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";

const { RootLayout } = await import("./RootLayout");

describe("RootLayout", () => {
	test("renders children inside the chrome", () => {
		const { container } = render(
			<RootLayout>
				<div data-testid="content">app content</div>
			</RootLayout>,
		);
		expect(container.firstElementChild).not.toBeNull();
	});
});
