import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { act, fireEvent, render } from "@testing-library/react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import * as realBindings from "@/bindings";
import { useSettingsStore } from "@/entities/setting";

// The sentinel the backend substitutes for a sealed secret when it hands
// settings back to the renderer (mirrors settings_store.rs). Hard-coded here
// (rather than imported) so this test also pins the exact wire value.
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

const initial = useSettingsStore.getState().settings;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
	resolveVerify = null;
	mockVerify.mockClear();
	useSettingsStore.setState({ settings: { ...initial } });
});

afterEach(() => {
	useSettingsStore.setState({ settings: initial });
});

test("OpenRouter pill reaches Verified even when the key is masked to the sentinel mid-probe", async () => {
	const { container, findByText } = render(
		<IntlProvider>
			<IntegrationsSettingsPanel />
		</IntlProvider>,
	);
	const keyInput = container.querySelector(
		'input[placeholder^="sk-or-"]',
	) as HTMLInputElement | null;
	expect(keyInput).not.toBeNull();
	if (!keyInput) {
		return;
	}

	// Paste a key. This persists it and schedules the debounced verify probe.
	await act(async () => {
		fireEvent.change(keyInput, { target: { value: "sk-or-test-key" } });
	});
	expect(useSettingsStore.getState().settings.llm.openrouterApiKey).toBe(
		"sk-or-test-key",
	);

	// Let the 600ms debounce fire: runOpenrouterVerify flips the pill to
	// "verifying" and awaits our still-pending deferred probe.
	await act(async () => {
		await sleep(700);
	});
	expect(mockVerify).toHaveBeenCalledTimes(1);
	expect(container.textContent).not.toContain("Verified");

	// Simulate the backend sealing the secret and broadcasting it back masked —
	// this overwrites the store's plaintext copy with the sentinel while the
	// probe is still in flight.
	act(() => {
		useSettingsStore.setState((s) => ({
			settings: {
				...s.settings,
				llm: { ...s.settings.llm, openrouterApiKey: SECRET_PRESENT_SENTINEL },
			},
		}));
	});

	// Now resolve the probe. The stale-check must treat the sentinel as the same
	// key it verified and apply the result.
	await act(async () => {
		resolveVerify?.();
		await sleep(0);
	});

	// Before the fix the pill stayed on "verifying" forever; now it resolves.
	await findByText("Verified");
});
