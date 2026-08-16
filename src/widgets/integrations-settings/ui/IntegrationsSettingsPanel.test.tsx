import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import { useSettingsStore } from "@/entities/setting";
import { useIntegrationVerifyStore } from "../model/integration-verify-store";
import { IntegrationsSettingsPanel } from "./IntegrationsSettingsPanel";

const initial = useSettingsStore.getState().settings;

// Hard-coded (not imported) so these tests also pin the exact wire values the
// backend emits — a rename on either side must fail here, not silently pass.
const SECRET_PRESENT_SENTINEL = "__WINSTT_SECRET_PRESENT__";
const SECRET_CLEAR_SENTINEL = "__WINSTT_SECRET_CLEAR__";
/** A hinted mask: the sentinel plus the non-secret last 4 of the real key. */
const HINTED_MASK = `${SECRET_PRESENT_SENTINEL}:4f2a`;

function renderPanel() {
	return render(
		<IntlProvider>
			<IntegrationsSettingsPanel />
		</IntlProvider>,
	);
}

/** Seed the store with the default settings plus a patch, without mutating the
 *  shared `initial` object the afterEach restores. */
function setSettings(patch: Partial<typeof initial>) {
	useSettingsStore.setState({ settings: { ...initial, ...patch } });
}

function withOpenrouterKey(key: string) {
	setSettings({ llm: { ...initial.llm, openrouterApiKey: key } });
}

function withElevenlabsKey(key: string) {
	setSettings({
		integrations: {
			...initial.integrations,
			elevenlabs: { ...initial.integrations.elevenlabs, apiKey: key },
		},
	});
}

/**
 * The key input a given accessible name belongs to.
 *
 * `getByLabelText` is avoided throughout: happy-dom + Base UI can hang on it
 * (see the repo gotcha), so a scoped `querySelector` is used instead.
 *
 * Two shapes, because the two fields name themselves differently. The EDITABLE
 * field is a real control and carries its own `aria-label`. The SEALED field is
 * a picture of a key: its input is `aria-hidden` (otherwise the asterisk run is
 * announced character by character) and the accessible text lives in an adjacent
 * visually-hidden span, so it is found through that span instead.
 */
function inputByAria(scope: HTMLElement, label: string): HTMLInputElement {
	const labelled = scope.querySelector<HTMLInputElement>(
		`input[aria-label="${label}"]`,
	);
	if (labelled) {
		return labelled;
	}
	const described = Array.from(scope.querySelectorAll(".sr-only")).find(
		(node) => node.textContent === label,
	);
	const el = described?.parentElement?.querySelector("input");
	if (!el) {
		throw new Error(`no input labelled ${label}`);
	}
	return el;
}

function inputValues(scope: HTMLElement): string[] {
	return Array.from(scope.querySelectorAll("input")).map((i) => i.value);
}

/** The card's status pill. NOT `getByRole("status")`: the pill wraps a `Spinner`
 *  while probing, and `Spinner` renders an `<output>` — implicit role `status`
 *  — so the role is ambiguous in that one state. The pill is the outer element,
 *  hence first in document order. */
function pillText(card: HTMLElement): string {
	const pill = card.querySelector('[role="status"]');
	if (!pill) {
		throw new Error("card has no status pill");
	}
	return pill.textContent ?? "";
}

beforeEach(() => {
	useSettingsStore.setState({ settings: { ...initial } });
	// Live probe status is a MODULE-level store (it has to outlive Base UI
	// unmounting the tab panel), so it leaks between tests unless reset.
	useIntegrationVerifyStore.setState({
		byProvider: {
			elevenlabs: { status: "idle" },
			ollama: { status: "idle" },
			openrouter: { status: "idle" },
		},
	});
});

afterEach(() => {
	// Unmount every rendered panel so React runs its effect cleanups — chiefly
	// the key rows' `VERIFY_DEBOUNCE_MS` `clearTimeout`. Without this the pending
	// debounce timers survive the file (bun:test shares one process) and fire
	// later against `verifyCredential`, inflating the call count in the sibling
	// verify-race suite.
	cleanup();
	useSettingsStore.setState({ settings: initial });
});

describe("IntegrationsSettingsPanel layout", () => {
	test("renders one card per provider, with its description and capability chips visible without hover", () => {
		// The rework's central claim: what a provider unlocks used to be hidden
		// behind an info-pill tooltip, so the tab read as three anonymous key
		// boxes. Description and capability chips are now static body text.
		const { getByRole, getByText, queryByText } = renderPanel();

		const ollama = getByRole("group", { name: "Ollama" });
		const openrouter = getByRole("group", { name: "OpenRouter" });
		const elevenlabs = getByRole("group", { name: "ElevenLabs" });

		expect(
			getByText(
				"Runs language models on your own machine. No account or key needed.",
			),
		).toBeDefined();
		expect(
			getByText(
				"One key for many hosted models. Powers cleanup, transformations, cloud transcription, and cloud voices.",
			),
		).toBeDefined();
		expect(
			getByText(
				"Hosted speech services. Powers cloud transcription and cloud voices.",
			),
		).toBeDefined();

		// Chips, in the model's declared render order, present in the DOM rather
		// than behind an interaction.
		expect(within(ollama).getByRole("list").textContent).toContain(
			"Dictation cleanup",
		);
		expect(within(ollama).getByRole("list").textContent).toContain(
			"Read-aloud cleanup",
		);
		expect(within(openrouter).getByRole("list").textContent).toContain(
			"Cloud transcription",
		);
		expect(within(elevenlabs).getByRole("list").textContent).toContain(
			"Cloud voices",
		);
		// Ollama is local-only: it must never claim a cloud surface.
		expect(within(ollama).getByRole("list").textContent).not.toContain(
			"Cloud transcription",
		);

		// The two capability SECTIONS the cards replaced are gone — each card now
		// states its own capabilities, so the grouping had no work left to do.
		expect(queryByText("Language Models (LLM)")).toBeNull();
		expect(queryByText("Cloud Speech-to-Text")).toBeNull();
	});

	test("capability chips report the surfaces actually pointing at each provider", () => {
		// Transforms moved to OpenRouter: OpenRouter's chip must go active and
		// Ollama's identically-labelled chip must not — "active" means the surface
		// points here, not that the capability exists.
		//
		// Dictation is switched ON explicitly. It already points at Ollama by
		// default, but a KEYLESS provider's chip also requires the feature to be
		// enabled (it has no key to remove, so its chips can only mean "running
		// here"), and the shipped defaults leave every LLM feature off.
		setSettings({
			llm: {
				...initial.llm,
				dictation: { ...initial.llm.dictation, enabled: true },
				transforms: { ...initial.llm.transforms, provider: "openrouter" },
			},
		});
		const { getByRole } = renderPanel();

		const openrouter = getByRole("group", { name: "OpenRouter" });
		const ollama = getByRole("group", { name: "Ollama" });
		const activeAria = '[aria-label="Transformations — currently in use"]';

		expect(openrouter.querySelector(activeAria)).not.toBeNull();
		expect(ollama.querySelector(activeAria)).toBeNull();
		// Never colour alone: the active chip also carries the word "Active".
		expect(openrouter.querySelector(activeAria)?.textContent).toContain(
			"Active",
		);
		// Dictation still points at Ollama, so its chip is the active one there.
		expect(
			ollama.querySelector(
				'[aria-label="Dictation cleanup — currently in use"]',
			),
		).not.toBeNull();
	});

	test("every card renders a status pill, including the not-connected state", () => {
		// The old pill returned null whenever the probe was idle or the field was
		// empty, which is why a provider row could look completely blank.
		const { getByRole } = renderPanel();

		expect(pillText(getByRole("group", { name: "OpenRouter" }))).toBe(
			"Not connected",
		);
		expect(pillText(getByRole("group", { name: "ElevenLabs" }))).toBe(
			"Not connected",
		);
		// Ollama's "credential" is its endpoint, which is valid by default — a
		// usable-but-unprobed integration reads as unverified, not absent.
		expect(pillText(getByRole("group", { name: "Ollama" }))).toBe(
			"Not verified",
		);
	});

	test("a stored key flips its card's pill out of not-connected", () => {
		withOpenrouterKey(HINTED_MASK);
		const { getByRole } = renderPanel();
		expect(pillText(getByRole("group", { name: "OpenRouter" }))).toBe(
			"Not verified",
		);
	});

	test("'Get a key' exists for the hosted providers only, and shares no slot with Remove", () => {
		// The old rows swapped one 12px text button between "Get a key" and
		// "Remove key", so the link vanished the moment a key was saved.
		withOpenrouterKey(HINTED_MASK);
		const { getAllByRole, getByRole, queryByRole } = renderPanel();

		expect(getAllByRole("link", { name: "Get a key" }).length).toBe(2);
		expect(
			within(getByRole("group", { name: "Ollama" })).queryByRole("link", {
				name: "Get a key",
			}),
		).toBeNull();
		expect(queryByRole("button", { name: "Get a key" })).toBeNull();

		const openrouter = getByRole("group", { name: "OpenRouter" });
		expect(
			within(openrouter).getByRole("link", { name: "Get a key" }),
		).toBeDefined();
		expect(
			within(openrouter).getByRole("button", { name: "Remove key" }),
		).toBeDefined();
	});
});

describe("sealed key display", () => {
	test("the present sentinel never reaches an input value, hinted or bare", () => {
		// Doubly load-bearing now that the mask can carry a suffix: a naive
		// "render the stored value" would leak `__WINSTT_SECRET_PRESENT__:4f2a`
		// verbatim into the field.
		withOpenrouterKey(HINTED_MASK);
		useSettingsStore.setState((s) => ({
			settings: {
				...s.settings,
				integrations: {
					...s.settings.integrations,
					elevenlabs: {
						...s.settings.integrations.elevenlabs,
						apiKey: SECRET_PRESENT_SENTINEL,
					},
				},
			},
		}));
		const { container } = renderPanel();

		for (const value of inputValues(container)) {
			expect(value).not.toContain(SECRET_PRESENT_SENTINEL);
		}
		expect(container.textContent).not.toContain(SECRET_PRESENT_SENTINEL);
	});

	test("a hinted mask shows the key's last four characters, sealed", () => {
		withOpenrouterKey(HINTED_MASK);
		const { getByRole } = renderPanel();

		const card = getByRole("group", { name: "OpenRouter" });
		const sealed = inputByAria(card, "Saved key ending in 4f2a");
		// Prefix comes from the provider's own i18n placeholder, so the visible
		// key shape and the placeholder can never disagree.
		expect(sealed.value).toBe("sk-or-v1-********4f2a");
		expect(sealed.disabled).toBe(true);
		expect(sealed.readOnly).toBe(true);
		// No editable field while sealed — replacement goes through Replace.
		expect(
			card.querySelector('input[aria-label="OpenRouter API Key"]'),
		).toBeNull();
	});

	test("a bare mask still renders sealed, with no null/undefined leaking into the display", () => {
		// The backend withholds the hint for short keys and on the settings-export
		// path, so the hintless shape is a first-class case, not an error state.
		withElevenlabsKey(SECRET_PRESENT_SENTINEL);
		const { getByRole } = renderPanel();

		const card = getByRole("group", { name: "ElevenLabs" });
		const sealed = inputByAria(card, "A key is saved");
		expect(sealed.value).toBe("el-********");
		expect(sealed.disabled).toBe(true);
		for (const value of inputValues(card)) {
			expect(value).not.toContain("null");
			expect(value).not.toContain("undefined");
		}
		expect(card.textContent).not.toContain("undefined");
	});

	test("a key typed but not yet round-tripped seals without exposing its plaintext", () => {
		const { getByRole } = renderPanel();
		const card = getByRole("group", { name: "OpenRouter" });
		const keyInput = inputByAria(card, "OpenRouter API Key");

		fireEvent.change(keyInput, { target: { value: "sk-or-new-key" } });
		expect(keyInput.disabled).toBe(false);
		expect(keyInput.value).toBe("sk-or-new-key");

		fireEvent.blur(keyInput);
		// Only `secretHint` may contribute characters from the key, and plaintext
		// carries no hint — so the sealed display degrades to the hintless form
		// rather than echoing what was typed.
		const sealed = inputByAria(card, "A key is saved");
		expect(sealed.disabled).toBe(true);
		expect(sealed.value).toBe("sk-or-v1-********");
		expect(sealed.value).not.toContain("new-key");
	});
});

describe("Ollama endpoint", () => {
	test("a valid loopback endpoint is normalized into settings", () => {
		const { getByRole } = renderPanel();
		const endpoint = inputByAria(
			getByRole("group", { name: "Ollama" }),
			"Ollama Endpoint",
		);

		fireEvent.change(endpoint, {
			target: { value: "http://127.0.0.1:9999/api/" },
		});
		expect(useSettingsStore.getState().settings.llm.endpoint).toBe(
			"http://127.0.0.1:9999",
		);
	});

	test("a remote endpoint remains an editable error and is not persisted", () => {
		const before = useSettingsStore.getState().settings.llm.endpoint;
		const { getByRole } = renderPanel();
		const endpoint = inputByAria(
			getByRole("group", { name: "Ollama" }),
			"Ollama Endpoint",
		);

		fireEvent.focus(endpoint);
		fireEvent.change(endpoint, {
			target: { value: "http://example.com:9999" },
		});
		expect(endpoint.value).toBe("http://example.com:9999");
		expect(endpoint.getAttribute("aria-invalid")).toBe("true");
		expect(useSettingsStore.getState().settings.llm.endpoint).toBe(before);
	});
});

describe("credential editing", () => {
	test("typing in the OpenRouter key field persists immediately, before verification", () => {
		// Persistence is not gated on verification — every keystroke writes
		// through to settings.llm.openrouterApiKey, so a tab switch before the
		// debounced verify completes can never lose the key. The probe only
		// drives the status pill.
		const { getByRole } = renderPanel();
		const keyInput = inputByAria(
			getByRole("group", { name: "OpenRouter" }),
			"OpenRouter API Key",
		);

		fireEvent.change(keyInput, { target: { value: "sk-or-new-key" } });
		expect(keyInput.value).toBe("sk-or-new-key");
		expect(useSettingsStore.getState().settings.llm.openrouterApiKey).toBe(
			"sk-or-new-key",
		);
	});

	test("Replace hands over an empty field WITHOUT destroying the stored key", () => {
		withOpenrouterKey(HINTED_MASK);
		const { getByRole } = renderPanel();
		const card = getByRole("group", { name: "OpenRouter" });

		fireEvent.click(within(card).getByRole("button", { name: "Replace" }));

		const editable = inputByAria(card, "OpenRouter API Key");
		expect(editable.value).toBe("");
		expect(editable.disabled).toBe(false);
		// The whole point of Replace over remove-then-retype: abandoning it must
		// leave the saved key intact, so the store still holds the mask.
		expect(useSettingsStore.getState().settings.llm.openrouterApiKey).toBe(
			HINTED_MASK,
		);
		expect(
			card.querySelector('input[aria-label="Saved key ending in 4f2a"]'),
		).toBeNull();
	});

	test("cancelling a Replace returns to the sealed display with the key unchanged", () => {
		withOpenrouterKey(HINTED_MASK);
		const { getByRole } = renderPanel();
		const card = getByRole("group", { name: "OpenRouter" });

		fireEvent.click(within(card).getByRole("button", { name: "Replace" }));
		fireEvent.keyDown(inputByAria(card, "OpenRouter API Key"), {
			key: "Escape",
		});

		expect(inputByAria(card, "Saved key ending in 4f2a").value).toBe(
			"sk-or-v1-********4f2a",
		);
		expect(useSettingsStore.getState().settings.llm.openrouterApiKey).toBe(
			HINTED_MASK,
		);
	});

	test("a half-typed Replace NEVER reaches settings, so abandoning it cannot destroy the stored key", () => {
		// The renderer only holds the MASK of a sealed key. If a keystroke wrote
		// through, `preserve_masked_secret` would seal the fragment over the real
		// key — and cancelling could only post the mask back, which the backend
		// reads as "keep what is stored", i.e. the fragment. So the assertion that
		// matters is on the intermediate state: nothing is written until commit.
		withOpenrouterKey(HINTED_MASK);
		const { getByRole } = renderPanel();
		const card = getByRole("group", { name: "OpenRouter" });

		fireEvent.click(within(card).getByRole("button", { name: "Replace" }));
		const editable = inputByAria(card, "OpenRouter API Key");
		fireEvent.change(editable, { target: { value: "sk-or-half-typed" } });
		expect(editable.value).toBe("sk-or-half-typed");
		expect(useSettingsStore.getState().settings.llm.openrouterApiKey).toBe(
			HINTED_MASK,
		);

		// Blur with an empty value is the other cancel path (alongside Escape).
		fireEvent.change(editable, { target: { value: "" } });
		fireEvent.blur(editable);

		expect(useSettingsStore.getState().settings.llm.openrouterApiKey).toBe(
			HINTED_MASK,
		);
		expect(inputByAria(card, "Saved key ending in 4f2a").disabled).toBe(true);
	});

	test("a Replace abandoned with Escape leaves the stored key AND keeps the Settings window open", () => {
		// `useEscapeToClose` is a window-level listener that stands down only for
		// `defaultPrevented` events, so the row must claim the Escape it consumes —
		// otherwise cancelling an edit also shuts the window.
		withOpenrouterKey(HINTED_MASK);
		const { getByRole } = renderPanel();
		const card = getByRole("group", { name: "OpenRouter" });

		fireEvent.click(within(card).getByRole("button", { name: "Replace" }));
		const editable = inputByAria(card, "OpenRouter API Key");
		fireEvent.change(editable, { target: { value: "sk-or-half-typed" } });
		const consumed = !fireEvent.keyDown(editable, { key: "Escape" });

		expect(consumed).toBe(true);
		expect(useSettingsStore.getState().settings.llm.openrouterApiKey).toBe(
			HINTED_MASK,
		);
		expect(inputByAria(card, "Saved key ending in 4f2a").disabled).toBe(true);
	});

	test("Escape in an untouched empty field is NOT claimed, so the window can still close", () => {
		const { getByRole } = renderPanel();
		const card = getByRole("group", { name: "OpenRouter" });

		const consumed = !fireEvent.keyDown(
			inputByAria(card, "OpenRouter API Key"),
			{ key: "Escape" },
		);
		expect(consumed).toBe(false);
	});

	test("a completed Replace commits the new key on blur", () => {
		withOpenrouterKey(HINTED_MASK);
		const { getByRole } = renderPanel();
		const card = getByRole("group", { name: "OpenRouter" });

		fireEvent.click(within(card).getByRole("button", { name: "Replace" }));
		const editable = inputByAria(card, "OpenRouter API Key");
		fireEvent.change(editable, { target: { value: "sk-or-v1-replacement" } });
		fireEvent.blur(editable);

		// Blur is the commit point — and the ONLY moment the sealed key is
		// overwritten, with a whole value rather than a fragment.
		expect(useSettingsStore.getState().settings.llm.openrouterApiKey).toBe(
			"sk-or-v1-replacement",
		);
		expect(inputByAria(card, "A key is saved").disabled).toBe(true);
	});
});

describe("key removal", () => {
	test("removing an IN-USE provider's key opens the confirm gate and names what breaks", () => {
		setSettings({
			llm: {
				...initial.llm,
				dictation: { ...initial.llm.dictation, provider: "openrouter" },
				openrouterApiKey: HINTED_MASK,
			},
		});
		const { getByRole } = renderPanel();

		fireEvent.click(
			within(getByRole("group", { name: "OpenRouter" })).getByRole("button", {
				name: "Remove key",
			}),
		);

		// The dialog is portalled, so assert against the whole document.
		expect(document.body.textContent).toContain("Remove API key?");
		expect(document.body.textContent).toContain(
			"Removing this key switches Dictation cleanup back to a local engine.",
		);
		// Nothing is destroyed until Remove is confirmed.
		expect(useSettingsStore.getState().settings.llm.openrouterApiKey).toBe(
			HINTED_MASK,
		);
	});

	test("the warning names only the surfaces the revert planner actually rewrites", () => {
		// Read-aloud is a chip, but `planReverts` has no `llmReadAloud` field, so a
		// dialog that listed it would promise a revert that never happens — a
		// falsehood about a destructive action, shipped in every locale.
		setSettings({
			llm: {
				...initial.llm,
				dictation: { ...initial.llm.dictation, provider: "openrouter" },
				openrouterApiKey: HINTED_MASK,
				readAloud: { ...initial.llm.readAloud, provider: "openrouter" },
			},
		});
		const { getByRole } = renderPanel();

		const card = getByRole("group", { name: "OpenRouter" });
		// The chip still reports the honest truth: read-aloud IS pointed here.
		expect(
			card.querySelector(
				'[aria-label="Read-aloud cleanup — currently in use"]',
			),
		).not.toBeNull();

		fireEvent.click(within(card).getByRole("button", { name: "Remove key" }));

		expect(document.body.textContent).toContain(
			"Removing this key switches Dictation cleanup back to a local engine.",
		);
		expect(document.body.textContent).not.toContain("Read-aloud cleanup back");
	});

	test("removing an UNUSED provider's key clears it outright, with no dialog", () => {
		// Defaults point every surface at Ollama and the local STT model, so an
		// ElevenLabs key gates nothing — a confirm here would be pure friction.
		withElevenlabsKey(SECRET_PRESENT_SENTINEL);
		const { getByRole } = renderPanel();

		fireEvent.click(
			within(getByRole("group", { name: "ElevenLabs" })).getByRole("button", {
				name: "Remove key",
			}),
		);

		expect(document.body.textContent).not.toContain("Remove API key?");
		// The CLEAR sentinel, not `""`: the backend reads an empty incoming secret
		// as "keep the stored key", so an empty string would no-op the removal.
		expect(
			useSettingsStore.getState().settings.integrations.elevenlabs.apiKey,
		).toBe(SECRET_CLEAR_SENTINEL);
		// And the card falls back to the editable field, not a sealed one.
		expect(
			getByRole("group", { name: "ElevenLabs" }).querySelector(
				'input[aria-label="ElevenLabs API Key"]',
			),
		).not.toBeNull();
	});
});
