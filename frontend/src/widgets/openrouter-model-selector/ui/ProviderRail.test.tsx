import { describe, expect, mock, test } from "bun:test";
import { Tooltip as TooltipProvider } from "@base-ui/react/tooltip";
import { render } from "@testing-library/react";
import { __provider_rail_test_helpers__ as helpers, ProviderRail } from "./ProviderRail";

describe("ProviderRail", () => {
	test("renders nothing visible when there are no providers (empty list still renders the rail)", () => {
		const { container } = render(
			<TooltipProvider.Provider>
				<ProviderRail
					activeProvider={null}
					favorites={[]}
					onProviderClick={mock(() => undefined)}
					onToggleFavorite={mock(() => undefined)}
					providers={[]}
				/>
			</TooltipProvider.Provider>
		);
		expect(container.firstElementChild).not.toBeNull();
	});

	test("renders provider buttons", () => {
		const { container } = render(
			<TooltipProvider.Provider>
				<ProviderRail
					activeProvider="openai"
					favorites={["openai"]}
					onProviderClick={mock(() => undefined)}
					onToggleFavorite={mock(() => undefined)}
					providers={["openai", "anthropic"]}
				/>
			</TooltipProvider.Provider>
		);
		expect(container.firstElementChild).not.toBeNull();
	});
});

describe("ProviderRail helpers", () => {
	describe("partitionByFavorites", () => {
		test("splits providers into favorites and non-favorites", () => {
			const result = helpers.partitionByFavorites(
				["openai", "anthropic", "google"],
				new Set(["anthropic"])
			);
			expect(result.favoriteList).toEqual(["anthropic"]);
			expect(result.nonFavoriteList).toEqual(["openai", "google"]);
			expect(result.hasBoth).toBe(true);
		});

		test("hasBoth is false when only favorites exist", () => {
			const result = helpers.partitionByFavorites(["a"], new Set(["a"]));
			expect(result.hasBoth).toBe(false);
			expect(result.favoriteList).toEqual(["a"]);
			expect(result.nonFavoriteList).toEqual([]);
		});

		test("hasBoth is false when no favorites exist", () => {
			const result = helpers.partitionByFavorites(["a", "b"], new Set());
			expect(result.hasBoth).toBe(false);
			expect(result.favoriteList).toEqual([]);
			expect(result.nonFavoriteList).toEqual(["a", "b"]);
		});
	});

	describe("readScrollState", () => {
		test("reports both directions in the middle of the scroll range", () => {
			const viewport = {
				scrollTop: 50,
				scrollHeight: 200,
				clientHeight: 100,
			} as HTMLDivElement;
			expect(helpers.readScrollState(viewport)).toEqual({
				canScrollUp: true,
				canScrollDown: true,
			});
		});

		test("disables 'up' when at the top", () => {
			const viewport = {
				scrollTop: 0,
				scrollHeight: 200,
				clientHeight: 100,
			} as HTMLDivElement;
			expect(helpers.readScrollState(viewport)).toEqual({
				canScrollUp: false,
				canScrollDown: true,
			});
		});

		test("disables 'down' when at the bottom", () => {
			const viewport = {
				scrollTop: 100,
				scrollHeight: 200,
				clientHeight: 100,
			} as HTMLDivElement;
			expect(helpers.readScrollState(viewport)).toEqual({
				canScrollUp: true,
				canScrollDown: false,
			});
		});
	});

	describe("applyWheelScroll", () => {
		test("calls preventDefault and scrolls down for positive deltaY", () => {
			const preventDefault = mock(() => undefined);
			const scrollBy = mock(() => undefined);
			const event = { preventDefault, deltaY: 100 } as unknown as WheelEvent;
			const el = { scrollBy } as unknown as HTMLDivElement;
			helpers.applyWheelScroll(el, event);
			expect(preventDefault).toHaveBeenCalledTimes(1);
			expect(scrollBy).toHaveBeenCalledWith({ top: 180, behavior: "smooth" });
		});

		test("scrolls up for negative deltaY", () => {
			const scrollBy = mock(() => undefined);
			const event = { preventDefault: () => undefined, deltaY: -10 } as unknown as WheelEvent;
			const el = { scrollBy } as unknown as HTMLDivElement;
			helpers.applyWheelScroll(el, event);
			expect(scrollBy).toHaveBeenCalledWith({ top: -180, behavior: "smooth" });
		});

		test("defaults to scrolling down when deltaY is 0", () => {
			const scrollBy = mock(() => undefined);
			const event = { preventDefault: () => undefined, deltaY: 0 } as unknown as WheelEvent;
			const el = { scrollBy } as unknown as HTMLDivElement;
			helpers.applyWheelScroll(el, event);
			expect(scrollBy).toHaveBeenCalledWith({ top: 180, behavior: "smooth" });
		});
	});

	describe("isHorizontalWheel", () => {
		test.each([
			[10, 5, true],
			[5, 10, false],
			[0, 0, false],
		])("|deltaX|=%p, |deltaY|=%p → %p", (deltaX, deltaY, expected) => {
			expect(helpers.isHorizontalWheel({ deltaX, deltaY } as WheelEvent)).toBe(expected);
		});
	});

	describe("shouldAutoScroll", () => {
		test.each([
			[false, "openai", new Set<string>(), false],
			[true, null, new Set<string>(), false],
			[true, "openai", new Set(["openai"]), false],
			[true, "openai", new Set<string>(), true],
		])("(%p, %p) → %p", (enabled, active, favorites, expected) => {
			expect(helpers.shouldAutoScroll(enabled, active, favorites)).toBe(expected);
		});
	});

	describe("scrollActiveIntoView", () => {
		test("calls scrollIntoView on the matching tile", () => {
			const scrollIntoView = mock(() => undefined);
			const tile = { scrollIntoView } as unknown as HTMLElement;
			const querySelector = mock(() => tile);
			const el = { querySelector } as unknown as HTMLDivElement;
			helpers.scrollActiveIntoView(el, "openai");
			expect(querySelector).toHaveBeenCalled();
			expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest", behavior: "smooth" });
		});

		test("is a no-op when no tile is found", () => {
			const querySelector = mock(() => null);
			const el = { querySelector } as unknown as HTMLDivElement;
			expect(() => helpers.scrollActiveIntoView(el, "missing")).not.toThrow();
		});
	});

	describe("getTileButtonClassName", () => {
		test("includes active classes when isActive=true", () => {
			const cls = helpers.getTileButtonClassName(true);
			expect(cls).toContain("border-accent/40");
			expect(cls).toContain("bg-accent/15");
		});

		test("includes inactive classes when isActive=false", () => {
			const cls = helpers.getTileButtonClassName(false);
			expect(cls).toContain("border-transparent");
			expect(cls).toContain("hover:bg-surface-hover");
		});
	});

	describe("getFavoriteButtonClassName", () => {
		test("includes favorite classes when isFavorite=true", () => {
			const cls = helpers.getFavoriteButtonClassName(true);
			expect(cls).toContain("text-amber-500");
			expect(cls).toContain("opacity-100");
		});

		test("includes non-favorite classes when isFavorite=false", () => {
			const cls = helpers.getFavoriteButtonClassName(false);
			expect(cls).toContain("text-foreground-muted");
			expect(cls).toContain("opacity-0");
		});
	});

	describe("getFavoriteAriaLabel", () => {
		test.each([
			[true, "OpenAI", "Unfavorite OpenAI"],
			[false, "OpenAI", "Favorite OpenAI"],
		])("isFavorite=%p, label=%p → %p", (isFavorite, label, expected) => {
			expect(helpers.getFavoriteAriaLabel(label, isFavorite)).toBe(expected);
		});
	});

	describe("handleFavoriteClick", () => {
		test("prevents default, stops propagation, and toggles", () => {
			const preventDefault = mock(() => undefined);
			const stopPropagation = mock(() => undefined);
			const onToggle = mock(() => undefined);
			const event = { preventDefault, stopPropagation } as unknown as React.MouseEvent;
			helpers.handleFavoriteClick(event, onToggle);
			expect(preventDefault).toHaveBeenCalledTimes(1);
			expect(stopPropagation).toHaveBeenCalledTimes(1);
			expect(onToggle).toHaveBeenCalledTimes(1);
		});
	});

	describe("SCROLL_BUTTON_CONFIG", () => {
		test("defines up and down configurations", () => {
			expect(helpers.SCROLL_BUTTON_CONFIG.up.label).toBe("Scroll providers up");
			expect(helpers.SCROLL_BUTTON_CONFIG.down.label).toBe("Scroll providers down");
		});
	});

	describe("applyWheelDebounce", () => {
		function makeWheelEvent(deltaX: number, deltaY: number): WheelEvent {
			return { deltaX, deltaY, preventDefault: mock(() => undefined) } as unknown as WheelEvent;
		}
		function makeEl(): HTMLDivElement {
			return { scrollBy: mock(() => undefined) } as unknown as HTMLDivElement;
		}

		test("ignores horizontal wheel events (no scroll applied)", () => {
			const event = makeWheelEvent(100, 10); // |deltaX| > |deltaY|
			const el = makeEl();
			const result = helpers.applyWheelDebounce(event, el, 1000, 0, 200);
			expect(result.handled).toBe(false);
			expect((el.scrollBy as ReturnType<typeof mock>).mock.calls.length).toBe(0);
		});

		test("prevents default and skips scroll when within debounce window", () => {
			const event = makeWheelEvent(0, 50);
			const el = makeEl();
			// now=100, lockedUntil=500 → still locked
			const result = helpers.applyWheelDebounce(event, el, 100, 500, 200);
			expect(result.handled).toBe(false);
			expect(result.nextLockedUntil).toBe(500); // unchanged
			expect((event.preventDefault as ReturnType<typeof mock>).mock.calls.length).toBe(1);
		});

		test("applies scroll and updates lockedUntil when debounce window has passed", () => {
			const event = makeWheelEvent(0, 50);
			const el = makeEl();
			// now=1000, lockedUntil=100 → expired
			const result = helpers.applyWheelDebounce(event, el, 1000, 100, 200);
			expect(result.handled).toBe(true);
			expect(result.nextLockedUntil).toBe(1200);
			expect((el.scrollBy as ReturnType<typeof mock>).mock.calls.length).toBe(1);
		});
	});

	describe("scrollRefByAmount", () => {
		test("calls scrollBy on the element with the given delta", () => {
			const scrollBy = mock(() => undefined);
			const el = { scrollBy } as unknown as HTMLDivElement;
			helpers.scrollRefByAmount(el, -180);
			expect(scrollBy).toHaveBeenCalledWith({ top: -180, behavior: "smooth" });
		});

		test("is a no-op when el is null", () => {
			expect(() => helpers.scrollRefByAmount(null, 180)).not.toThrow();
		});
	});
});
