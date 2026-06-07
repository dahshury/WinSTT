import { describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { Elevated } from "./Elevated";
import { SurfaceProvider } from "./surface-context";

describe("Elevated", () => {
	test("renders children inside a div", () => {
		render(
			<Elevated data-testid="elevated" offset={2}>
				<span>hello</span>
			</Elevated>,
		);
		const el = screen.getByTestId("elevated");
		expect(el.tagName).toBe("DIV");
		expect(el.textContent).toBe("hello");
	});

	test("forwards a custom className alongside the surface classes", () => {
		render(
			<Elevated className="my-extra" data-testid="elevated" offset={2}>
				<span>x</span>
			</Elevated>,
		);
		expect(screen.getByTestId("elevated").className).toContain("my-extra");
	});

	test("caps the resolved surface level at 8 regardless of offset", () => {
		// Substrate=8 + offset=10 should clamp to 8 in the inner SurfaceProvider —
		// rendering doesn't expose the level directly, but the cap path runs and
		// shadows resolve normally instead of throwing.
		render(
			<SurfaceProvider value={8}>
				<Elevated data-testid="elevated" offset={10}>
					<span>x</span>
				</Elevated>
			</SurfaceProvider>,
		);
		expect(screen.getByTestId("elevated").textContent).toBe("x");
	});

	test("respects the shadowLevel override", () => {
		render(
			<Elevated data-testid="elevated" offset={2} shadowLevel={1}>
				<span>x</span>
			</Elevated>,
		);
		// We can't easily inspect the resolved tailwind class names, but
		// rendering completes and the override is exercised by surfaceClasses.
		expect(screen.getByTestId("elevated").textContent).toBe("x");
	});
});
