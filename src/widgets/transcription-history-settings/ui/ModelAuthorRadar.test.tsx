import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import type { AuthorSlice } from "../lib/author-usage";
import { ModelAuthorRadar } from "./ModelAuthorRadar";

afterEach(cleanup);

function slice(partial: Partial<AuthorSlice> & { key: string }): AuthorSlice {
	return {
		label: partial.key,
		logoSrc: `/${partial.key}.svg`,
		count: 1,
		pct: 10,
		...partial,
	};
}

const THREE = [
	slice({ key: "OpenAI", count: 90, pct: 90 }),
	slice({ key: "NVIDIA", count: 6, pct: 6 }),
	slice({ key: "Alibaba", count: 4, pct: 4 }),
];

describe("ModelAuthorRadar", () => {
	test("renders nothing below three makers (a radar needs a polygon)", () => {
		const { container } = render(
			<ModelAuthorRadar
				slices={[
					slice({ key: "OpenAI", count: 9, pct: 90 }),
					slice({ key: "NVIDIA", count: 1, pct: 10 }),
				]}
			/>,
		);
		expect(container.querySelector("svg")).toBeNull();
	});

	test("renders nothing when no maker carries a logo", () => {
		const { container } = render(
			<ModelAuthorRadar
				slices={[
					slice({ key: "a", logoSrc: null }),
					slice({ key: "b", logoSrc: null }),
					slice({ key: "c", logoSrc: null }),
				]}
			/>,
		);
		expect(container.querySelector("svg")).toBeNull();
	});

	test("gives every maker an axis with a logo, even a dominated sliver", () => {
		const { container } = render(<ModelAuthorRadar slices={THREE} />);
		// One logo per maker regardless of share — the whole point vs the pie.
		expect(container.querySelectorAll("image")).toHaveLength(3);
		// One data polygon (plus the grid rings).
		const polygons = container.querySelectorAll("polygon");
		expect(polygons.length).toBeGreaterThanOrEqual(4);
		expect(container.querySelector("title")?.textContent).toBe(
			"OpenAI · 90 (90%)",
		);
	});

	test("a logo-less Other axis falls back to a neutral marker", () => {
		const { container } = render(
			<ModelAuthorRadar
				slices={[
					slice({ key: "OpenAI", count: 90, pct: 90 }),
					slice({ key: "NVIDIA", count: 8, pct: 8 }),
					slice({ key: "__other__", logoSrc: null, count: 2, pct: 2 }),
				]}
			/>,
		);
		// Two real logos; the Other axis has none.
		expect(container.querySelectorAll("image")).toHaveLength(2);
	});
});
