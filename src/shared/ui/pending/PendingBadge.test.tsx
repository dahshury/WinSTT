import { describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { PendingBadge } from "./PendingBadge";

function Probe({ pending }: { pending: boolean }) {
	return (
		<PendingBadge pending={pending}>
			<button type="button">Enable</button>
		</PendingBadge>
	);
}

describe("PendingBadge", () => {
	test("always renders its child", () => {
		render(<Probe pending={false} />);
		expect(screen.getByRole("button", { name: "Enable" })).not.toBeNull();
	});

	test("shows no badge and no busy state when idle", () => {
		const { container } = render(<Probe pending={false} />);

		expect(container.querySelector('[data-slot="pending-badge"]')).toBeNull();
		const wrapper = container.firstElementChild;
		expect(wrapper?.getAttribute("aria-busy")).toBeNull();
	});

	test("floats a decorative spinner badge and marks the wrapper busy when pending", () => {
		const { container } = render(<Probe pending />);

		const badge = container.querySelector('[data-slot="pending-badge"]');
		expect(badge).not.toBeNull();
		// Absolutely positioned so it never reflows the wrapped control.
		expect(badge?.className).toContain("absolute");
		// Hidden from assistive tech — the wrapper's aria-busy carries the meaning.
		expect(badge?.getAttribute("aria-hidden")).toBe("true");

		const wrapper = container.firstElementChild;
		expect(wrapper?.getAttribute("aria-busy")).toBe("true");
	});

	test("honours a logical corner placement", () => {
		const { container } = render(
			<PendingBadge pending placement="bottom-start">
				<button type="button">Enable</button>
			</PendingBadge>,
		);

		const badge = container.querySelector('[data-slot="pending-badge"]');
		expect(badge?.className).toContain("-bottom-1.5");
		expect(badge?.className).toContain("-start-1.5");
	});
});
