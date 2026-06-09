import { describe, expect, test } from "bun:test";
import { act, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { ScrollArea } from "./ScrollArea";

function touchEvent(type: string, clientY: number) {
	const event = new Event(type, {
		bubbles: true,
		cancelable: true,
	}) as Event & {
		changedTouches: Array<{ clientY: number }>;
		touches: Array<{ clientY: number }>;
	};
	Object.defineProperty(event, "touches", {
		value: type === "touchend" || type === "touchcancel" ? [] : [{ clientY }],
	});
	Object.defineProperty(event, "changedTouches", { value: [{ clientY }] });
	return event;
}

function setScrollMetrics(
	viewport: HTMLElement,
	metrics: { clientHeight: number; scrollHeight: number; scrollTop: number },
) {
	Object.defineProperty(viewport, "clientHeight", {
		configurable: true,
		value: metrics.clientHeight,
	});
	Object.defineProperty(viewport, "scrollHeight", {
		configurable: true,
		value: metrics.scrollHeight,
	});
	Object.defineProperty(viewport, "scrollTop", {
		configurable: true,
		value: metrics.scrollTop,
		writable: true,
	});
}

describe("ScrollArea", () => {
	test("renders children inside a scroll viewport", () => {
		render(
			<ScrollArea>
				<div data-testid="content">Long content</div>
			</ScrollArea>,
		);
		expect(screen.getByTestId("content")).toBeDefined();
	});

	test("merges custom className on the root", () => {
		const { container } = render(
			<ScrollArea className="custom-root">
				<div>x</div>
			</ScrollArea>,
		);
		const root = container.firstElementChild as HTMLElement;
		expect(root.className).toContain("custom-root");
	});

	test("forwards viewportClassName to the inner viewport", () => {
		render(
			<ScrollArea viewportClassName="custom-viewport">
				<div data-testid="c">x</div>
			</ScrollArea>,
		);
		const contentLayer = screen.getByTestId("c").parentElement as HTMLElement;
		const viewport = contentLayer.parentElement as HTMLElement;
		expect(viewport.className).toContain("custom-viewport");
	});

	test("hides the native viewport scrollbar behind the custom scrollbar", () => {
		render(
			<ScrollArea>
				<div data-testid="c">x</div>
			</ScrollArea>,
		);
		const contentLayer = screen.getByTestId("c").parentElement as HTMLElement;
		const viewport = contentLayer.parentElement as HTMLElement;
		expect(viewport.className).toContain("[scrollbar-width:none]");
		expect(viewport.className).toContain("[&::-webkit-scrollbar]:hidden");
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

	test("wraps children in a transformable layer when touch rubber banding is enabled", () => {
		render(
			<ScrollArea rubberBandOnTouch>
				<div data-testid="content">x</div>
			</ScrollArea>,
		);
		const contentLayer = screen.getByTestId("content")
			.parentElement as HTMLElement;
		expect(contentLayer.dataset.rubberBandContent).toBe("true");
	});

	test("enables touch rubber banding by default", () => {
		render(
			<ScrollArea>
				<div data-testid="content">x</div>
			</ScrollArea>,
		);
		const contentLayer = screen.getByTestId("content")
			.parentElement as HTMLElement;
		expect(contentLayer.dataset.rubberBandContent).toBe("true");
	});

	test("pulls the content down when a touch drag overscrolls the top edge", () => {
		render(
			<ScrollArea rubberBandOnTouch>
				<div data-testid="content">x</div>
			</ScrollArea>,
		);
		const contentLayer = screen.getByTestId("content")
			.parentElement as HTMLElement;
		const viewport = contentLayer.parentElement as HTMLElement;
		setScrollMetrics(viewport, {
			clientHeight: 100,
			scrollHeight: 400,
			scrollTop: 0,
		});

		act(() => {
			viewport.dispatchEvent(touchEvent("touchstart", 100));
			viewport.dispatchEvent(touchEvent("touchmove", 150));
		});

		expect(contentLayer.style.transform).toContain("translate3d(0, ");
		expect(contentLayer.style.transform).not.toContain("0px");

		act(() => {
			viewport.dispatchEvent(touchEvent("touchend", 150));
		});

		expect(contentLayer.style.transform).toContain("0px");
	});

	test("pulls the content up when a touch drag overscrolls the bottom edge", () => {
		render(
			<ScrollArea rubberBandOnTouch>
				<div data-testid="content">x</div>
			</ScrollArea>,
		);
		const contentLayer = screen.getByTestId("content")
			.parentElement as HTMLElement;
		const viewport = contentLayer.parentElement as HTMLElement;
		setScrollMetrics(viewport, {
			clientHeight: 100,
			scrollHeight: 400,
			scrollTop: 300,
		});

		act(() => {
			viewport.dispatchEvent(touchEvent("touchstart", 150));
			viewport.dispatchEvent(touchEvent("touchmove", 100));
		});

		expect(contentLayer.style.transform).toContain("translate3d(0, -");
	});
});
