import { afterEach, describe, expect, test } from "bun:test";
import { installTouchRubberBand } from "./touch-rubber-band";

function touchEvent(type: string, clientY: number) {
	const event = new Event(type, {
		bubbles: true,
		cancelable: true,
	}) as Event & {
		touches: Array<{ clientY: number }>;
	};
	Object.defineProperty(event, "touches", {
		value: type === "touchend" || type === "touchcancel" ? [] : [{ clientY }],
	});
	return event;
}

function setScrollMetrics(
	element: HTMLElement,
	metrics: { clientHeight: number; scrollHeight: number; scrollTop: number },
) {
	Object.defineProperty(element, "clientHeight", {
		configurable: true,
		value: metrics.clientHeight,
	});
	Object.defineProperty(element, "scrollHeight", {
		configurable: true,
		value: metrics.scrollHeight,
	});
	Object.defineProperty(element, "scrollTop", {
		configurable: true,
		value: metrics.scrollTop,
		writable: true,
	});
}

afterEach(() => {
	document.body.innerHTML = "";
});

describe("installTouchRubberBand", () => {
	test("pulls a native overflow scroller down at the top edge", () => {
		installTouchRubberBand();
		const scroller = document.createElement("div");
		scroller.style.overflowY = "auto";
		const content = document.createElement("div");
		scroller.append(content);
		document.body.append(scroller);
		setScrollMetrics(scroller, {
			clientHeight: 100,
			scrollHeight: 400,
			scrollTop: 0,
		});

		content.dispatchEvent(touchEvent("touchstart", 100));
		content.dispatchEvent(touchEvent("touchmove", 150));

		expect(scroller.style.translate).toStartWith("0 ");
		expect(scroller.style.translate).not.toContain("0px");
	});

	test("skips scroll areas that are managed by the local ScrollArea behavior", () => {
		installTouchRubberBand();
		const scroller = document.createElement("div");
		scroller.dataset["rubberBandManaged"] = "local";
		scroller.style.overflowY = "auto";
		const content = document.createElement("div");
		scroller.append(content);
		document.body.append(scroller);
		setScrollMetrics(scroller, {
			clientHeight: 100,
			scrollHeight: 400,
			scrollTop: 0,
		});

		content.dispatchEvent(touchEvent("touchstart", 100));
		content.dispatchEvent(touchEvent("touchmove", 150));

		expect(scroller.style.translate ?? "").toBe("");
	});
});
