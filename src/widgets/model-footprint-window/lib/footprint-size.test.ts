import { describe, expect, test } from "bun:test";
import { resolveFootprintContentSize } from "./footprint-size";

describe("resolveFootprintContentSize", () => {
	test("uses intrinsic content height when the current native viewport crops it", () => {
		expect(
			resolveFootprintContentSize({
				boxHeight: 420,
				scrollHeight: 476.2,
			}),
		).toEqual({ height: 489, width: 292 });
	});

	test("keeps the visible box when it already contains the full content", () => {
		expect(
			resolveFootprintContentSize({
				boxHeight: 480,
				scrollHeight: 476,
			}),
		).toEqual({ height: 492, width: 292 });
	});
});
