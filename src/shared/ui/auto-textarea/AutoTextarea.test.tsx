import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	test,
} from "bun:test";
import { render, screen } from "@testing-library/react";
import { createRef } from "react";
import { AutoTextarea, type AutoTextareaProps } from "./AutoTextarea";

// happy-dom has no layout engine, so every box metric reads 0 and the component
// deliberately declines to size itself. Drive `scrollHeight` from the suite to
// exercise the growth math; leaving it `null` reproduces the bare happy-dom
// baseline the zero-height guard has to survive.
let stubbedScrollHeight: number | null = null;

// The happy-dom window is shared by every test file in the one bun process, so
// the override is installed and removed around THIS suite only — a permanent
// prototype patch would follow unrelated files that render textareas.
beforeAll(() => {
	Object.defineProperty(HTMLTextAreaElement.prototype, "scrollHeight", {
		configurable: true,
		get(): number {
			return stubbedScrollHeight ?? 0;
		},
	});
});

afterAll(() => {
	// Own property only — deleting it restores the inherited HTMLElement getter.
	Reflect.deleteProperty(HTMLTextAreaElement.prototype, "scrollHeight");
});

afterEach(() => {
	stubbedScrollHeight = null;
});

function renderTextarea(props: Partial<AutoTextareaProps>) {
	const element = (overrides: Partial<AutoTextareaProps>) => (
		<AutoTextarea
			data-testid="ta"
			onChange={() => undefined}
			value=""
			{...props}
			{...overrides}
		/>
	);
	const view = render(element({}));
	return {
		el: screen.getByTestId("ta") as HTMLTextAreaElement,
		rerender: (next: Partial<AutoTextareaProps>) =>
			view.rerender(element(next)),
	};
}

describe("AutoTextarea", () => {
	test("renders its value", () => {
		const { el } = renderTextarea({ value: "hello world" });
		expect(el.tagName).toBe("TEXTAREA");
		expect(el.value).toBe("hello world");
	});

	test("grows when the value gets longer", () => {
		stubbedScrollHeight = 90;
		const { el, rerender } = renderTextarea({
			maxRows: 10,
			minRows: 3,
			value: "one line",
		});
		const initial = Number.parseFloat(el.style.height);
		expect(initial).toBe(90);

		stubbedScrollHeight = 150;
		rerender({ value: "one line\ntwo\nthree\nfour" });
		expect(Number.parseFloat(el.style.height)).toBeGreaterThan(initial);
		expect(el.style.height).toBe("150px");
		// Still under the ceiling, so the content is shown rather than scrolled.
		expect(el.style.overflowY).toBe("hidden");
	});

	test("never shrinks below minRows", () => {
		stubbedScrollHeight = 1;
		const { el } = renderTextarea({ maxRows: 4, minRows: 2, value: "a" });
		expect(Number.parseFloat(el.style.height)).toBeGreaterThan(1);
	});

	test("stops growing at maxRows and scrolls instead", () => {
		stubbedScrollHeight = 1;
		const { el, rerender } = renderTextarea({
			maxRows: 4,
			minRows: 2,
			value: "a",
		});
		const floor = Number.parseFloat(el.style.height);

		stubbedScrollHeight = 10_000;
		rerender({ value: "a\n".repeat(400) });
		const capped = Number.parseFloat(el.style.height);
		expect(capped).toBeGreaterThan(floor);
		// 4 rows against a 2-row floor: the cap lands at most at double the floor,
		// nowhere near the 10000px of content asking to be shown.
		expect(capped).toBeLessThanOrEqual(floor * 2);
		expect(el.style.overflowY).toBe("auto");
	});

	test("keeps a usable height where layout reports nothing", () => {
		// No `scrollHeight` stub — the raw happy-dom case, and equally any element
		// mounted inside a `display:none` subtree.
		const { el } = renderTextarea({ minRows: 4, value: "a\nb\nc\nd\ne\nf" });
		expect(el.style.height).toBe("");
		expect(el.getAttribute("rows")).toBe("4");
	});

	test("has no CSS resize — the native grip is gone", () => {
		const { el } = renderTextarea({ value: "x" });
		expect(el.className).toContain("resize-none");
		expect(el.className).not.toMatch(/\bresize-[xy]\b/);
		expect(el.style.resize).toBe("");
	});

	test("forwards a ref to the underlying textarea", () => {
		const ref = createRef<HTMLTextAreaElement>();
		const { el } = renderTextarea({ ref, value: "x" });
		expect(ref.current).toBe(el);
	});

	test("defaults to dir=auto", () => {
		const { el } = renderTextarea({ value: "مرحبا" });
		expect(el.getAttribute("dir")).toBe("auto");
	});

	test("lets a caller override dir", () => {
		const { el } = renderTextarea({ dir: "rtl", value: "مرحبا" });
		expect(el.getAttribute("dir")).toBe("rtl");
	});

	test("merges a caller className and preserves native props", () => {
		const { el } = renderTextarea({
			className: "custom-class",
			disabled: true,
			placeholder: "type here",
		});
		expect(el.className).toContain("custom-class");
		expect(el.disabled).toBe(true);
		expect(el.placeholder).toBe("type here");
	});
});
