import { describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach } from "bun:test";
import { StoredSecretField } from "./StoredSecretField";

afterEach(cleanup);

function renderField(props: Parameters<typeof StoredSecretField>[0] = {}) {
	const { container } = render(<StoredSecretField {...props} />);
	const input = container.querySelector("input");
	if (!input) {
		throw new Error("StoredSecretField rendered no input");
	}
	return { container, input };
}

/**
 * The sealed field is a PICTURE of a stored key, not a control and not text
 * worth reading out character by character. Everything below pins that split:
 * sighted users get the mask, assistive tech gets one sentence naming the key.
 */
describe("accessible representation", () => {
	test("the masked input is hidden from assistive tech", () => {
		// Without this the value is announced as a run of asterisks — "asterisk
		// asterisk asterisk…" — which is noise, not information.
		const { input } = renderField({ maskedValue: "sk-or-v1-********4f2a" });
		expect(input.getAttribute("aria-hidden")).toBe("true");
	});

	test("hiding the input is safe because it holds no focusable content", () => {
		// `aria-hidden` on a focusable element is an a11y violation; the field is
		// only allowed to hide itself because it is disabled.
		const { input } = renderField({ maskedValue: "sk-or-v1-********4f2a" });
		expect(input.disabled).toBe(true);
		expect(input.readOnly).toBe(true);
	});

	test("the caller's label becomes the announced content", () => {
		renderField({
			"aria-label": "Saved key ending in 4f2a",
			maskedValue: "sk-or-v1-********4f2a",
		});
		expect(screen.getByText("Saved key ending in 4f2a")).toBeDefined();
	});

	test("the announced text carries the hint, not the asterisks", () => {
		const { container } = renderField({
			"aria-label": "Saved key ending in 4f2a",
			maskedValue: "sk-or-v1-********4f2a",
		});
		const announced = container.querySelector(".sr-only");
		expect(announced?.textContent).toBe("Saved key ending in 4f2a");
		expect(announced?.textContent).not.toContain("*");
	});
});

describe("the visible mask", () => {
	test("renders the caller's masked value verbatim", () => {
		// Masking is the caller's job (see `maskedKeyDisplay`); this field must not
		// second-guess it, or a last-4 hint could be re-dotted away.
		const { input } = renderField({ maskedValue: "sk-or-v1-********4f2a" });
		expect(input.value).toBe("sk-or-v1-********4f2a");
		expect(input.type).toBe("text");
	});

	test("falls back to a bare asterisk run when given nothing identifying", () => {
		const { input } = renderField();
		expect(input.value).toBe("********");
	});

	test("marks the field invalid when the stored key was rejected", () => {
		const { input } = renderField({
			invalid: true,
			maskedValue: "sk-or-v1-********4f2a",
		});
		expect(input.getAttribute("aria-invalid")).toBe("true");
	});
});
