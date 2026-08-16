import { afterEach, describe, expect, test } from "bun:test";
import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { useTranslations } from "use-intl";
import { IntlProvider } from "@/app/providers/IntlProvider";
import {
	type CredentialPillState,
	CredentialStatusPill,
} from "./CredentialStatusPill";

/**
 * The pill's contract, stated once here because the whole reason it was
 * rewritten is that the old one returned `null` for the idle/empty case: EVERY
 * state must put a distinguishable, non-empty label on screen. A card whose
 * status area is blank tells the user nothing about whether the integration is
 * configured — the exact complaint that motivated the rework.
 */
const ALL_STATES: readonly CredentialPillState[] = [
	"connected",
	"notConnected",
	"rejected",
	"unreachable",
	"unverified",
	"verifying",
];

/** The two states the pill treats as failures — the only ones that carry a
 *  colour token and the only ones that hang the probe detail off a tooltip. */
const FAILURE_STATES: readonly CredentialPillState[] = [
	"rejected",
	"unreachable",
];

function Harness({
	lastError,
	providerLabel = "OpenRouter",
	state,
}: {
	lastError?: string;
	providerLabel?: string;
	state: CredentialPillState;
}) {
	// Real `integrations` messages rather than a stub `t`, so a renamed or
	// missing message key fails here instead of shipping a raw key to the card.
	const t = useTranslations("integrations");
	return (
		<CredentialStatusPill
			chipLevel={4}
			lastError={lastError}
			providerLabel={providerLabel}
			state={state}
			t={t}
		/>
	);
}

interface PillProps {
	lastError?: string;
	providerLabel?: string;
	state: CredentialPillState;
}

/**
 * The live region: the single, always-mounted `role="status"` wrapper.
 *
 * Its text is what assistive tech announces; its CHILD carries the visual
 * styling and the tooltip trigger (see {@link renderPillVisual}).
 */
function renderPill(props: PillProps): HTMLElement {
	render(
		// delay=0 so a hover opens the tooltip synchronously enough for `waitFor`.
		<TooltipPrimitive.Provider closeDelay={0} delay={0}>
			<IntlProvider>
				<Harness {...props} />
			</IntlProvider>
		</TooltipPrimitive.Provider>,
	);
	// Safe as a role query in EVERY state: the spinner is `aria-hidden`, so its
	// `<output>` no longer contributes a second status node.
	return screen.getByRole("status");
}

/**
 * The styled chip inside the live region — the element that carries the tone
 * classes and, in the two failure states, anchors the detail tooltip. Separate
 * from the region itself so the region can stay mounted across transitions.
 */
function renderPillVisual(props: PillProps): HTMLElement {
	const visual = renderPill(props).firstElementChild;
	if (!(visual instanceof HTMLElement)) {
		throw new Error(`No pill body rendered for state "${props.state}"`);
	}
	return visual;
}

function pillText(state: CredentialPillState, providerLabel?: string): string {
	const text =
		renderPill(
			providerLabel === undefined ? { state } : { providerLabel, state },
		).textContent ?? "";
	cleanup();
	return text;
}

/** Open the tooltip the same way a pointer user would. */
function hover(element: HTMLElement): void {
	fireEvent.pointerEnter(element);
	fireEvent.mouseEnter(element);
	fireEvent.focus(element);
}

afterEach(cleanup);

describe("every state is visible", () => {
	for (const state of ALL_STATES) {
		test(`${state} renders a non-empty label`, () => {
			expect(pillText(state).trim().length).toBeGreaterThan(0);
		});
	}

	test("the idle 'no key yet' state is not blank (the old pill rendered null)", () => {
		expect(pillText("notConnected")).toContain("Not connected");
	});

	test("'has a key, never probed' is distinct from 'has no key'", () => {
		// Two different facts; collapsing them is how a saved-but-unverified key
		// used to read as unconfigured.
		expect(pillText("unverified")).toContain("Not verified");
		expect(pillText("unverified")).not.toBe(pillText("notConnected"));
	});

	test("all six labels are mutually distinguishable", () => {
		const labels = ALL_STATES.map((state) => pillText(state).trim());
		expect(new Set(labels).size).toBe(ALL_STATES.length);
	});

	test("the unreachable label names the provider it could not reach", () => {
		expect(pillText("unreachable", "ElevenLabs")).toContain("ElevenLabs");
		expect(pillText("unreachable", "OpenRouter")).toContain("OpenRouter");
	});

	test("verifying shows a spinner alongside its label", () => {
		const pill = renderPill({ state: "verifying" });
		expect(pill.textContent).toContain("Verifying");
		expect(pill.querySelector("[aria-busy='true']")).not.toBeNull();
	});
});

/**
 * ONE live region, in every state, mounted for the component's whole life.
 *
 * Two bugs this pins. Giving each state its own `role="status"` destroys and
 * recreates the region on every transition, so assistive tech reads the new
 * region's existing content as an update — static states get announced as if
 * something just happened, and a real change can be missed. And the `verifying`
 * state used to nest the Spinner's implicit `role="status"` (`<output>`) inside
 * the pill's own, announcing the same news twice.
 */
describe("live-region shape", () => {
	for (const state of ALL_STATES) {
		test(`${state} exposes exactly one status node`, () => {
			renderPill({ state });
			expect(screen.getAllByRole("status").length).toBe(1);
		});
	}

	test("the region survives a state transition as the same DOM node", () => {
		const { rerender } = render(
			<IntlProvider>
				<Harness state="verifying" />
			</IntlProvider>,
		);
		const before = screen.getByRole("status");
		rerender(
			<IntlProvider>
				<Harness state="connected" />
			</IntlProvider>,
		);
		// Same element, new text — which is what makes the announcement an update
		// rather than a freshly-mounted region reading itself out.
		expect(screen.getByRole("status")).toBe(before);
		expect(before.textContent).toContain("Connected");
	});
});

/**
 * Grayscale-except-failures (the no-green-status preference): "Connected" is a
 * solid dot plus full-contrast text, NOT a success colour, and only the two
 * failures may reach for a semantic token.
 */
describe("colour is reserved for the two failures", () => {
	test("rejected uses the error token, unreachable the warning token", () => {
		expect(renderPillVisual({ state: "rejected" }).className).toContain(
			"error",
		);
		cleanup();
		expect(renderPillVisual({ state: "unreachable" }).className).toContain(
			"warning",
		);
	});

	for (const state of ALL_STATES.filter((s) => !FAILURE_STATES.includes(s))) {
		test(`${state} carries no success/error/warning token`, () => {
			const { className } = renderPillVisual({ state });
			expect(className).not.toContain("success");
			expect(className).not.toContain("error");
			expect(className).not.toContain("warning");
		});
	}
});

describe("the probe's own message stays on hover", () => {
	const DETAIL = "HTTP 401: invalid api key supplied";

	for (const state of FAILURE_STATES) {
		test(`${state} keeps the detail out of the pill but reachable on hover`, async () => {
			// The VISUAL chip is the tooltip trigger; the live region wraps it.
			const pill = renderPillVisual({ lastError: DETAIL, state });
			// Far too long for a pill — it must not be inlined.
			expect(pill.textContent).not.toContain(DETAIL);
			expect(document.body.textContent).not.toContain(DETAIL);

			hover(pill);
			await waitFor(() => {
				expect(document.body.textContent).toContain(DETAIL);
			});
		});

		test(`${state} renders fine with no detail to show`, () => {
			const pill = renderPill({ state });
			expect((pill.textContent ?? "").trim().length).toBeGreaterThan(0);
			hover(pill);
			// No tooltip wrapper at all — nothing to reveal, nothing to crash on.
			expect(screen.getAllByRole("status").length).toBe(1);
		});
	}

	test("a stale error from an earlier probe never leaks into a good state", async () => {
		// `lastError` outlives the failure it describes in the verify store, so a
		// later success must not still be offering "invalid api key" on hover.
		const pill = renderPill({ lastError: DETAIL, state: "connected" });
		hover(pill);
		await waitFor(() => {
			expect(pill.textContent).toContain("Connected");
		});
		expect(document.body.textContent).not.toContain(DETAIL);
	});
});
