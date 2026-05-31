import { describe, expect, test } from "bun:test";
import { LockIcon } from "@hugeicons/core-free-icons";
import type { SwitcherOption } from "./switcher-option";

// `switcher-option.ts` is a type-only module: the `SwitcherOption` interface is
// erased at compile time, so there is no runtime code to execute. These tests
// therefore lock the *contract* of the type — they fail to compile if a
// required field is dropped, an optional field becomes required, or a value
// type changes. The runtime `expect`s document the consumer-visible invariants
// (which fields are mandatory, and the "badge becomes interactive when tooltip
// or onBadgeClick is present" rule that downstream components rely on).

// Mirrors the predicate `SwitcherBadge`/`Switcher` use to decide whether the
// corner badge should be interactive (a button) vs. presentational (a span).
const isInteractiveBadge = <T extends string>(option: SwitcherOption<T>): boolean =>
	option.badgeTooltip !== undefined || option.onBadgeClick !== undefined;

describe("SwitcherOption type contract", () => {
	test("minimal option requires only label and value", () => {
		const option: SwitcherOption<"cloud"> = { label: "Cloud", value: "cloud" };
		expect(option.label).toBe("Cloud");
		expect(option.value).toBe("cloud");
		// All other fields are optional and absent on the minimal shape.
		expect(option.icon).toBeUndefined();
		expect(option.color).toBeUndefined();
		expect(option.disabled).toBeUndefined();
		expect(option.badgeIcon).toBeUndefined();
		expect(option.badgeTooltip).toBeUndefined();
		expect(option.onBadgeClick).toBeUndefined();
	});

	test("value is narrowed by the generic parameter", () => {
		const local = { label: "Local", value: "local" } satisfies SwitcherOption<"local">;
		// The literal type is preserved, not widened to string.
		const value: "local" = local.value;
		expect(value).toBe("local");
	});

	test("value defaults to the string generic when no parameter is supplied", () => {
		const option: SwitcherOption = { label: "Any", value: "anything" };
		expect(option.value).toBe("anything");
	});

	test("color is a string accent (hex) when present", () => {
		const option = {
			label: "Accented",
			value: "x",
			color: "#ff8800",
		} satisfies SwitcherOption<"x">;
		expect(typeof option.color).toBe("string");
		expect(option.color).toBe("#ff8800");
	});

	test("disabled is a boolean flag when present", () => {
		const option = {
			label: "Locked",
			value: "locked",
			disabled: true,
		} satisfies SwitcherOption<"locked">;
		expect(option.disabled).toBe(true);
	});

	test("badge is presentational when only badgeIcon is set (no tooltip/handler)", () => {
		const option = {
			label: "Pro",
			value: "pro",
			badgeIcon: LockIcon,
		} satisfies SwitcherOption<"pro">;
		expect(option.badgeIcon).toBe(LockIcon);
		// Without a tooltip or click handler the badge stays presentational.
		expect(isInteractiveBadge(option)).toBe(false);
	});

	test("badge becomes interactive when badgeTooltip is supplied", () => {
		const option = {
			label: "Pro",
			value: "pro",
			badgeIcon: LockIcon,
			badgeTooltip: "Unlock by installing a model",
		} satisfies SwitcherOption<"pro">;
		expect(isInteractiveBadge(option)).toBe(true);
	});

	test("badge becomes interactive when onBadgeClick is supplied", () => {
		let clicked = 0;
		const option = {
			label: "Pro",
			value: "pro",
			badgeIcon: LockIcon,
			onBadgeClick: () => {
				clicked += 1;
			},
		} satisfies SwitcherOption<"pro">;
		expect(isInteractiveBadge(option)).toBe(true);
		option.onBadgeClick?.();
		expect(clicked).toBe(1);
	});

	test("icon is the leading icon and is distinct from the corner badgeIcon", () => {
		const option = {
			label: "Both",
			value: "both",
			icon: LockIcon,
			badgeIcon: LockIcon,
		} satisfies SwitcherOption<"both">;
		// Both slots accept an IconSvgElement; they are independent fields.
		expect(option.icon).toBe(LockIcon);
		expect(option.badgeIcon).toBe(LockIcon);
	});

	test("a fully-populated option exposes every documented field", () => {
		const handler = () => {
			/* noop */
		};
		const option = {
			badgeIcon: LockIcon,
			badgeTooltip: "tip",
			color: "#123456",
			disabled: false,
			icon: LockIcon,
			label: "Full",
			onBadgeClick: handler,
			value: "full",
		} satisfies SwitcherOption<"full">;

		const keys = Object.keys(option).sort();
		expect(keys).toEqual(
			[
				"badgeIcon",
				"badgeTooltip",
				"color",
				"disabled",
				"icon",
				"label",
				"onBadgeClick",
				"value",
			].sort()
		);
	});
});
