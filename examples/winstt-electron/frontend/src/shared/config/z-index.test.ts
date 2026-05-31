import { describe, expect, test } from "bun:test";
import { Z_INDEX } from "./z-index";

const ALL_LAYERS = [
	"raised",
	"overlay",
	"titlebar",
	"titlebarFloat",
	"modalBackdrop",
	"modal",
	"popover",
	"popoverSubmenu",
	"tooltip",
	"confirmBackdrop",
	"confirm",
	"toast",
	"noiseOverlay",
] as const;

describe("Z_INDEX scale", () => {
	test("exposes every documented layer", () => {
		for (const layer of ALL_LAYERS) {
			expect(Z_INDEX).toHaveProperty(layer);
		}
	});

	test("layers are strictly ascending in the documented order", () => {
		const values = ALL_LAYERS.map((layer) => Z_INDEX[layer]);
		for (let i = 1; i < values.length; i++) {
			expect(values[i]).toBeGreaterThan(values[i - 1] as number);
		}
	});

	test("in-flow local stacking sits below all portaled overlays", () => {
		const localMax = Math.max(
			Z_INDEX.raised,
			Z_INDEX.overlay,
			Z_INDEX.titlebar,
			Z_INDEX.titlebarFloat
		);
		const portalMin = Math.min(
			Z_INDEX.modalBackdrop,
			Z_INDEX.modal,
			Z_INDEX.popover,
			Z_INDEX.popoverSubmenu,
			Z_INDEX.tooltip,
			Z_INDEX.confirmBackdrop,
			Z_INDEX.confirm,
			Z_INDEX.toast
		);
		expect(localMax).toBeLessThan(100);
		expect(portalMin).toBeGreaterThanOrEqual(1000);
	});

	test("popovers sit above modals so a modal can host a dropdown", () => {
		expect(Z_INDEX.popover).toBeGreaterThan(Z_INDEX.modal);
	});

	test("tooltips sit above every interactive popover", () => {
		expect(Z_INDEX.tooltip).toBeGreaterThan(Z_INDEX.popover);
		expect(Z_INDEX.tooltip).toBeGreaterThan(Z_INDEX.popoverSubmenu);
	});

	test("confirm dialog sits above modals and popovers", () => {
		expect(Z_INDEX.confirm).toBeGreaterThan(Z_INDEX.modal);
		expect(Z_INDEX.confirm).toBeGreaterThan(Z_INDEX.popover);
		expect(Z_INDEX.confirm).toBeGreaterThan(Z_INDEX.tooltip);
	});

	test("toast is the top interactive layer below the cosmetic noise overlay", () => {
		expect(Z_INDEX.toast).toBeGreaterThan(Z_INDEX.confirm);
		expect(Z_INDEX.noiseOverlay).toBeGreaterThan(Z_INDEX.toast);
	});

	test("all values are positive integers", () => {
		for (const value of Object.values(Z_INDEX)) {
			expect(Number.isInteger(value)).toBe(true);
			expect(value).toBeGreaterThan(0);
		}
	});
});
