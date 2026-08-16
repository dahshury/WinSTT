import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import {
	act,
	cleanup,
	fireEvent,
	render,
	waitFor,
} from "@testing-library/react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import * as realBindings from "@/bindings";
import { useSettingsStore } from "@/entities/setting";

// The sentinel the backend substitutes for a sealed secret when it hands
// settings back to the renderer (mirrors settings_store.rs). Hard-coded here
// (rather than imported) so this test also pins the exact wire value — including
// the `:<last4>` hint suffix the mask may now carry.
const SECRET_PRESENT_SENTINEL = "__WINSTT_SECRET_PRESENT__";

type VerifyResult = {
	status: "ok";
	data: { code?: string; message?: string; ok: boolean };
};

// A deferred verify probe: the component gets a Promise that stays pending
// until the test calls `resolveVerify()`, so we can deterministically mask the
// stored key WHILE the probe is in flight — exactly the save/broadcast race
// that used to strand the pill on "verifying".
let resolveVerify: (() => void) | null = null;
const mockVerify = mock(
	(_provider: string, _apiKey: string) =>
		new Promise<VerifyResult>((res) => {
			resolveVerify = () => res({ status: "ok", data: { ok: true } });
		}),
);

// Spread the real bindings and override only `verifyCredential` (bun's
// `mock.module` is global — clobbering `commands` wholesale would break other
// suites in the same worker).
mock.module("@/bindings", () => ({
	...realBindings,
	commands: {
		...realBindings.commands,
		verifyCredential: (provider: string, apiKey: string) =>
			mockVerify(provider, apiKey),
	},
}));

const { IntegrationsSettingsPanel } = await import(
	"./IntegrationsSettingsPanel"
);
const { useIntegrationVerifyStore } = await import(
	"../model/integration-verify-store"
);

const initial = useSettingsStore.getState().settings;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The card's status pill.
 *
 * NOT `getByRole("status")`: while the probe is in flight the pill wraps a
 * `Spinner`, which renders an `<output>` — implicit role `status` — so the role
 * is ambiguous exactly during the state this suite exercises. The pill is the
 * outer element, hence first in document order.
 */
function pillText(card: HTMLElement): string {
	const pill = card.querySelector('[role="status"]');
	if (!pill) {
		throw new Error("card has no status pill");
	}
	return pill.textContent ?? "";
}

beforeEach(() => {
	resolveVerify = null;
	mockVerify.mockClear();
	useSettingsStore.setState({ settings: { ...initial } });
	// Probe verdicts live in a MODULE-level store so they survive Base UI
	// unmounting the tab panel — which also means they survive into the next
	// test unless reset, and a leftover "verified" would make the assertions
	// below pass before the probe ever settles.
	useIntegrationVerifyStore.setState({
		byProvider: {
			elevenlabs: { status: "idle" },
			ollama: { status: "idle" },
			openrouter: { status: "idle" },
		},
	});
});

afterEach(() => {
	cleanup();
	useSettingsStore.setState({ settings: initial });
});

/** Paste a key into the OpenRouter card and let the 600ms debounce fire, so the
 *  card is sitting on "verifying" awaiting the still-pending deferred probe. */
async function startInFlightProbe() {
	const view = render(
		<IntlProvider>
			<IntegrationsSettingsPanel />
		</IntlProvider>,
	);
	const card = view.getByRole("group", { name: "OpenRouter" });
	const keyInput = card.querySelector<HTMLInputElement>(
		'input[aria-label="OpenRouter API Key"]',
	);
	if (!keyInput) {
		throw new Error("no OpenRouter key input");
	}

	await act(async () => {
		fireEvent.change(keyInput, { target: { value: "sk-or-test-key" } });
	});
	expect(useSettingsStore.getState().settings.llm.openrouterApiKey).toBe(
		"sk-or-test-key",
	);

	await act(async () => {
		await sleep(700);
	});
	expect(mockVerify).toHaveBeenCalledTimes(1);
	expect(pillText(card)).toBe("Verifying…");

	return { card, keyInput, view };
}

/** Overwrite the store's plaintext copy with the backend's mask, as a debounced
 *  save's broadcast would, then settle the probe. */
async function maskThenResolve(mask: string) {
	act(() => {
		useSettingsStore.setState((s) => ({
			settings: {
				...s.settings,
				llm: { ...s.settings.llm, openrouterApiKey: mask },
			},
		}));
	});
	await act(async () => {
		resolveVerify?.();
		await sleep(0);
	});
}

test("OpenRouter pill reaches Connected even when the key is masked to the BARE sentinel mid-probe", async () => {
	const { card } = await startInFlightProbe();

	await maskThenResolve(SECRET_PRESENT_SENTINEL);

	// Before the fix the pill stayed on "verifying" forever: the stale-check
	// compared the stored value to the probed key by equality and saw a
	// mismatch. It must treat the mask as the SAME key, now sealed.
	await waitFor(() => {
		expect(pillText(card)).toBe("Connected");
	});
});

test("OpenRouter pill reaches Connected when the mask arrives WITH a last-4 hint", async () => {
	// The realistic shape: the backend appends the last 4 characters of the
	// plaintext key, so the broadcast value is never byte-equal to the bare
	// sentinel either. A stale-check that special-cased only the bare sentinel
	// would strand this on "verifying" — hence the prefix test.
	const hintedMask = `${SECRET_PRESENT_SENTINEL}:-key`;
	const { card, keyInput } = await startInFlightProbe();

	await maskThenResolve(hintedMask);

	await waitFor(() => {
		expect(pillText(card)).toBe("Connected");
	});

	// Sealing after the race shows the hint the mask carried — and never the
	// sentinel itself, in any input on the page.
	fireEvent.blur(keyInput);
	// The sealed input is `aria-hidden` (its value is a run of asterisks, which
	// AT would otherwise spell out), so the accessible text lives in the adjacent
	// visually-hidden span and the input is reached through it.
	const described = Array.from(card.querySelectorAll(".sr-only")).find(
		(node) => node.textContent === "Saved key ending in -key",
	);
	const sealed = described?.parentElement?.querySelector("input");
	expect(sealed?.value).toBe("sk-or-v1-********-key");
	for (const input of Array.from(document.querySelectorAll("input"))) {
		expect(input.value).not.toContain(SECRET_PRESENT_SENTINEL);
	}
});
