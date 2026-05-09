import { describe, expect, mock, test } from "bun:test";
import { render } from "@testing-library/react";

// next/image fails under happy-dom (Invalid URL on relative src). Stub it.
mock.module("next/image", () => ({
	__esModule: true,
	default: (props: Record<string, unknown>) => {
		const { alt, ...rest } = props as { alt?: string } & Record<string, unknown>;
		return <img alt={alt ?? ""} {...rest} />;
	},
}));

const { RootLayout } = await import("./RootLayout");

describe("RootLayout", () => {
	test("renders children inside the chrome", () => {
		const { container } = render(
			<RootLayout>
				<div data-testid="content">app content</div>
			</RootLayout>
		);
		expect(container.firstElementChild).not.toBeNull();
	});
});
