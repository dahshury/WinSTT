import { describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { useRef } from "react";
import { ScrollArea } from "./ScrollArea";

describe("ScrollArea", () => {
	test("renders children inside a scroll viewport", () => {
		render(
			<ScrollArea>
				<div data-testid="content">Long content</div>
			</ScrollArea>
		);
		expect(screen.getByTestId("content")).toBeDefined();
	});

	test("merges custom className on the root", () => {
		const { container } = render(
			<ScrollArea className="custom-root">
				<div>x</div>
			</ScrollArea>
		);
		const root = container.firstElementChild as HTMLElement;
		expect(root.className).toContain("custom-root");
	});

	test("forwards viewportClassName to the inner viewport", () => {
		render(
			<ScrollArea viewportClassName="custom-viewport">
				<div data-testid="c">x</div>
			</ScrollArea>
		);
		const viewport = screen.getByTestId("c").parentElement as HTMLElement;
		expect(viewport.className).toContain("custom-viewport");
	});

	test("forwards a viewportRef so callers can imperatively scroll", () => {
		function Probe() {
			const ref = useRef<HTMLDivElement>(null);
			return (
				<>
					<button data-testid="probe" onClick={() => undefined} type="button">
						{ref.current ? "yes" : "init"}
					</button>
					<ScrollArea viewportRef={ref}>
						<div data-testid="content">x</div>
					</ScrollArea>
				</>
			);
		}
		render(<Probe />);
		expect(screen.getByTestId("content")).toBeDefined();
	});
});
