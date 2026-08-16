import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { useTranslations } from "use-intl";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	within,
} from "@/shared/ui/model-picker/test/render-with-intl";
import type {
	SavedVoice,
	SavedVoiceClip,
	SavedVoiceValue,
} from "../model/voice-library";
import { useVoiceLibraryStore } from "../model/voice-library";
import {
	resolveVoiceClips,
	stepVoiceId,
	VoiceField,
	type VoiceFieldClip,
	type VoiceFieldProps,
} from "./VoiceField";

// ── copy the assertions read, quoted from `messages/en.json` ─────────────────
// Spelled out rather than re-derived through `t()`: a test that formats its own
// expectation with the same function the component used would pass even if the
// key were wrong. These also prove every key the component reads still exists.
const PLACEHOLDER = "Select or name a voice…";
const NAME_PLACEHOLDER = "Name this voice";
const DROP_CLIPS = "Drop audio here, or browse";
const UNSUPPORTED =
	"That file isn't a supported audio format. Use WAV, MP3, FLAC, M4A, MP4, OGG or AAC.";
const TRIMMED_NOTICE =
	"That clip was longer than this model accepts — only the first 30 seconds are used.";
const REQUIRED_CLIP =
	"This model has no built-in voice — it can't speak until you add a reference clip.";
const REQUIRED_REF_TEXT =
	"Add the clip's transcript below — this model can't speak without it.";
const REF_PLACEHOLDER =
	"What the reference clip says (auto-filled from your STT model; edit if needed).";
const LAST_CLIP_TITLE = "Remove the last clip?";
/** The confirmation NAMES the voice it destroys — the row was picked out of a
 *  popup list, and the audio it unlinks cannot be recovered. */
const DELETE_VOICE_TITLE = 'Delete "Narrator"?';
const PERSIST_FAILED =
	"Couldn't save the voice library on this device. Your voices work for this session only.";

const COMBINED = "C:\\AppData\\tts\\reference-voices\\narrator-9f.wav";
const PART_A = "C:\\AppData\\tts\\reference-voices\\part-a.wav";
const PART_B = "C:\\AppData\\tts\\reference-voices\\part-b.wav";

function part(path: string, name: string, seconds: number): SavedVoiceClip {
	return { name, path, seconds };
}

function clipVoice(over: Partial<SavedVoiceValue> = {}): SavedVoiceValue {
	return {
		clips: [],
		kind: "clip",
		maxSecs: 30,
		refText: "",
		seconds: 0,
		value: "",
		...over,
	};
}

function designVoice(value: string): SavedVoiceValue {
	return {
		clips: [],
		kind: "design",
		maxSecs: 0,
		refText: "",
		seconds: 0,
		value,
	};
}

function savedClip(
	id: string,
	name: string,
	value: string,
	over: Partial<SavedVoice> = {},
): SavedVoice {
	return {
		clips: [],
		id,
		kind: "clip",
		maxSecs: 30,
		name,
		refText: "",
		seconds: 8,
		value,
		...over,
	};
}

function savedDesign(id: string, name: string, value: string): SavedVoice {
	return {
		clips: [],
		id,
		kind: "design",
		maxSecs: 0,
		name,
		refText: "",
		seconds: 0,
		value,
	};
}

/** The component takes `t` as a prop, so the harness supplies the real `tts`
 *  namespace — which also proves every key it reads exists in `messages/en.json`. */
function Harness(props: Omit<VoiceFieldProps, "t">) {
	const t = useTranslations("tts");
	return <VoiceField {...props} t={t} />;
}

type Handlers = {
	onApply: ReturnType<typeof mock>;
	onBrowse: ReturnType<typeof mock>;
	onDiscard: ReturnType<typeof mock>;
	onOverwrite: ReturnType<typeof mock>;
	onPresetChange: ReturnType<typeof mock>;
	onPreview: ReturnType<typeof mock>;
	onRefTextChange: ReturnType<typeof mock>;
	onSetClips: ReturnType<typeof mock>;
};

function renderField(
	options: {
		busy?: boolean;
		clip?: Partial<VoiceFieldClip> | null;
		disabled?: boolean;
		live?: SavedVoiceValue;
	} = {},
): Handlers & { rerender: (next: typeof options) => void } {
	const handlers: Handlers = {
		onApply: mock((_value: SavedVoiceValue) => undefined),
		onBrowse: mock((_existing: readonly string[]) => undefined),
		onDiscard: mock(
			(_input: { entry: SavedVoice | null; paths: readonly string[] }) =>
				undefined,
		),
		onOverwrite: mock((_id: string, _value: SavedVoiceValue) => undefined),
		onPresetChange: mock((_id: string) => undefined),
		onPreview: mock((_id: string, _lang: string) => undefined),
		onRefTextChange: mock((_next: string) => undefined),
		onSetClips: mock((_paths: readonly string[]) => undefined),
	};

	const element = (opts: typeof options) => {
		const clip: VoiceFieldClip | undefined =
			opts.clip === null
				? undefined
				: {
						error: null,
						maxSecs: 30,
						needsRefText: false,
						onBrowse: handlers.onBrowse,
						onPresetChange: handlers.onPresetChange,
						onRefTextChange: handlers.onRefTextChange,
						onSetClips: handlers.onSetClips,
						preview: {
							activeRequestId: null,
							isLoading: false,
							isSpeaking: false,
							langForVoice: () => "en",
							onPreview: handlers.onPreview,
							previewVoiceId: null,
						},
						presets: [],
						presetVoice: "default",
						refText: "",
						requiresClip: false,
						trimmed: false,
						...opts.clip,
					};
		return (
			<Harness
				busy={opts.busy ?? false}
				{...(clip ? { clip } : {})}
				disabled={opts.disabled ?? false}
				live={opts.live ?? clipVoice()}
				onApply={handlers.onApply}
				onDiscard={handlers.onDiscard}
				onOverwrite={handlers.onOverwrite}
			/>
		);
	};

	const view = render(element(options));
	return {
		...handlers,
		rerender: (next) => view.rerender(element(next)),
	};
}

function card(): HTMLElement {
	return screen.getByTestId("voice-card");
}

function dropFiles(...names: string[]): void {
	const files = names.map(
		(name) =>
			new File([new Uint8Array([1, 2, 3])], name, { type: "audio/wav" }),
	);
	fireEvent.drop(card(), { dataTransfer: { files } });
}

/** Base UI keeps the list in a portal that only mounts once the popup opens.
 *  The chevron trigger is scoped by the nav group and identified by its popup
 *  relationship — its accessible name is inherited from the field label, which
 *  the card and the info tooltip also carry. */
function openPopup(): void {
	const group = screen.getByRole("group", { name: "Saved voice navigation" });
	const trigger = within(group)
		.getAllByRole("button")
		.find((el) => el.getAttribute("aria-haspopup") === "listbox");
	expect(trigger).toBeDefined();
	fireEvent.click(trigger as HTMLElement);
}

function typeAndOpen(text: string): void {
	openPopup();
	fireEvent.change(screen.getByPlaceholderText(PLACEHOLDER), {
		target: { value: text },
	});
}

/** The confirm dialogs render in a portal outside the field; both use the shared
 *  `ConfirmDialog`, whose destructive action is labelled `common.delete`. Only
 *  one can ever be open (both are modal), so the lookup is unambiguous. */
function confirmDestructive(): void {
	const button = screen
		.getAllByRole("button")
		.find((el) => el.textContent?.trim() === "Delete");
	expect(button).toBeDefined();
	fireEvent.click(button as HTMLElement);
}

beforeEach(() => {
	window.localStorage.clear();
	useVoiceLibraryStore.setState({
		voices: [],
		activeVoiceId: null,
		persistFailed: null,
	});
	// `getFilePath` prefers the native bridge; standing one up is the smallest
	// seam for "Tauri resolved this DOM File to an absolute path".
	(window as unknown as { nativeBridge: unknown }).nativeBridge = {
		getPathForFile: (file: File) => `C:\\Users\\me\\${file.name}`,
		invoke: async () => undefined,
		on: () => () => undefined,
		secureInvoke: async () => undefined,
		send: () => undefined,
	};
});

afterEach(() => {
	cleanup();
	(window as unknown as { nativeBridge?: unknown }).nativeBridge = undefined;
});

describe("VoiceField — one field, one voice", () => {
	test("the three old rows are gone: picker, clips and transcript share ONE field", () => {
		renderField({
			clip: { needsRefText: true, refText: "what the clip says" },
			live: clipVoice({
				clips: [part(PART_A, "part-a.wav", 8)],
				refText: "what the clip says",
				seconds: 8,
				value: COMBINED,
			}),
		});

		// One label for the whole thing…
		expect(screen.getAllByText("Voice").length).toBeGreaterThan(0);
		// …and the two rows it replaced no longer exist as separate settings.
		expect(screen.queryByText("Saved voices")).toBeNull();
		expect(screen.queryByText("Reference clip")).toBeNull();
		expect(screen.queryByText("Reference transcript")).toBeNull();

		// All three concerns live inside the single card.
		const region = card();
		expect(within(region).getByText("part-a.wav")).toBeTruthy();
		expect(within(region).getByPlaceholderText(REF_PLACEHOLDER)).toBeTruthy();
		expect(screen.getByPlaceholderText(PLACEHOLDER)).toBeTruthy();
	});

	test("the card is always open — there is no disclosure to click", () => {
		renderField({ live: clipVoice() });

		// A grouped region, not a collapsible: no expand/collapse control exists and
		// the contents are present on first render.
		const region = card();
		expect(region.getAttribute("role")).toBe("group");
		expect(region.getAttribute("aria-label")).toBe("Voice");
		expect(region.getAttribute("aria-expanded")).toBeNull();
		expect(screen.getByText("No voice yet")).toBeTruthy();
	});

	test("a voice-design row gets the picker alone — a prompt has no audio behind it", () => {
		renderField({ clip: null, live: designVoice("A warm, low narrator.") });

		expect(screen.queryByTestId("voice-card")).toBeNull();
		expect(screen.getByPlaceholderText(PLACEHOLDER)).toBeTruthy();
	});
});

describe("VoiceField — auditioning the voice", () => {
	test("a cloning voice can be previewed from the row, as the dropdown it replaced allowed", () => {
		const { onPreview } = renderField({
			live: clipVoice({
				clips: [part(PART_A, "part-a.wav", 8)],
				seconds: 8,
				value: COMBINED,
			}),
		});

		fireEvent.click(screen.getByRole("button", { name: "Preview voice" }));

		// The clip the engine clones from IS what gets spoken.
		expect(onPreview.mock.calls[0]?.[0]).toBe(COMBINED);
	});

	test("without a clip the engine's preset is what would be spoken", () => {
		const { onPreview } = renderField({
			clip: { presetVoice: "female" },
			live: clipVoice(),
		});

		fireEvent.click(screen.getByRole("button", { name: "Preview voice" }));

		expect(onPreview.mock.calls[0]?.[0]).toBe("female");
	});

	test("offers nothing to audition while there is no voice at all", () => {
		// An engine with no built-in voice, before its first clip: a preview here
		// could only error.
		renderField({
			clip: { presetVoice: "", requiresClip: true },
			live: clipVoice(),
		});

		expect(screen.queryByRole("button", { name: "Preview voice" })).toBeNull();
	});
});

describe("VoiceField — adding audio", () => {
	test("a dropped audio file is appended as a native absolute path", () => {
		const { onSetClips } = renderField({
			live: clipVoice({
				clips: [part(PART_A, "part-a.wav", 8)],
				seconds: 8,
				value: COMBINED,
			}),
		});

		dropFiles("narrator.wav");

		expect(onSetClips).toHaveBeenCalledTimes(1);
		expect(onSetClips.mock.calls[0]?.[0]).toEqual([
			PART_A,
			"C:\\Users\\me\\narrator.wav",
		]);
	});

	test("TWO files in one drop become two clips", () => {
		const { onSetClips } = renderField({ live: clipVoice() });

		dropFiles("one.wav", "two.mp3");

		expect(onSetClips.mock.calls[0]?.[0]).toEqual([
			"C:\\Users\\me\\one.wav",
			"C:\\Users\\me\\two.mp3",
		]);
	});

	test("a non-audio drop is refused locally and never reaches the backend", () => {
		const { onSetClips } = renderField({ live: clipVoice() });

		dropFiles("contract.pdf");

		expect(onSetClips).not.toHaveBeenCalled();
		expect(screen.getByText(UNSUPPORTED)).toBeTruthy();
	});

	test("a refusal is retired once a build lands, not left hanging over the voice", () => {
		// The drop error has to survive the re-render the drop itself causes, so
		// nothing clears it on its own — and it used to outlive the voice it was
		// about, still accusing a clip that had since built perfectly well.
		const view = renderField({ live: clipVoice() });

		dropFiles("contract.pdf");
		expect(screen.getByText(UNSUPPORTED)).toBeTruthy();

		view.rerender({
			live: clipVoice({
				clips: [part(PART_A, "part-a.wav", 8)],
				seconds: 8,
				value: COMBINED,
			}),
		});

		expect(screen.queryByText(UNSUPPORTED)).toBeNull();
	});

	test("selecting a different voice retires it too", () => {
		const view = renderField({ live: clipVoice({ value: COMBINED }) });

		dropFiles("contract.pdf");
		expect(screen.getByText(UNSUPPORTED)).toBeTruthy();

		view.rerender({ live: clipVoice({ value: PART_B }) });

		expect(screen.queryByText(UNSUPPORTED)).toBeNull();
	});

	test("clicking the add affordance browses, handing over what the voice already holds", () => {
		const { onBrowse } = renderField({
			live: clipVoice({
				clips: [part(PART_A, "part-a.wav", 8), part(PART_B, "part-b.wav", 4)],
				seconds: 12,
				value: COMBINED,
			}),
		});

		// ONE affordance for both gestures: the card is the drop target and this
		// button is its click half, so the copy names both. Its ACCESSIBLE name is
		// that same copy — see the Label-in-Name test below.
		const add = screen.getByRole("button", { name: DROP_CLIPS });
		expect(add.textContent).toBe(DROP_CLIPS);
		fireEvent.click(add);

		expect(onBrowse).toHaveBeenCalledTimes(1);
		expect(onBrowse.mock.calls[0]?.[0]).toEqual([PART_A, PART_B]);
	});

	test("the add affordance is NAMED by the words it shows, busy state included", () => {
		// WCAG 2.5.3 Label-in-Name: the accessible name must contain the visible
		// label, or "drop audio here" is a phrase voice control cannot act on. It
		// used to be a fixed "Add clip" that shared no word with the copy — and that
		// stayed frozen while the visible text swapped during a build.
		const view = renderField({ live: clipVoice() });

		expect(screen.getByRole("button", { name: DROP_CLIPS })).toBeTruthy();

		view.rerender({ busy: true, live: clipVoice() });

		expect(screen.queryByRole("button", { name: DROP_CLIPS })).toBeNull();
		expect(
			screen.getByRole("button", { name: "Preparing audio…" }),
		).toBeTruthy();
	});

	test("a drop that lands mid-build is ignored rather than racing it", () => {
		// The browse button is `disabled` while busy; a drop target cannot be, so
		// the second weld has to be refused in the handler.
		const { onSetClips } = renderField({ busy: true, live: clipVoice() });

		dropFiles("narrator.wav");

		expect(onSetClips).not.toHaveBeenCalled();
		expect(screen.getByText("Preparing audio…")).toBeTruthy();
	});
});

describe("VoiceField — the clips a voice is made of", () => {
	test("lists each clip's name and duration, keeping the path for the tooltip", () => {
		renderField({
			live: clipVoice({
				clips: [part(PART_A, "part-a.wav", 12.44)],
				seconds: 12.44,
				value: COMBINED,
			}),
		});

		const row = within(card()).getByText("part-a.wav");
		expect(row.getAttribute("title")).toBe(PART_A);
		expect(within(card()).getByText("12.4s")).toBeTruthy();
	});

	test("removing one clip of two rebuilds from the survivor", () => {
		const { onSetClips, onDiscard } = renderField({
			live: clipVoice({
				clips: [part(PART_A, "part-a.wav", 8), part(PART_B, "part-b.wav", 4)],
				seconds: 12,
				value: COMBINED,
			}),
		});

		// Each row is named after the clip it removes, so the two are separately
		// addressable rather than five identical "Remove clip" buttons.
		expect(
			screen.getByRole("button", { name: "Remove part-b.wav" }),
		).toBeTruthy();
		const removes = screen.getAllByRole("button", { name: /^Remove part-/ });
		expect(removes).toHaveLength(2);
		fireEvent.click(removes[0] as HTMLElement);

		expect(onSetClips.mock.calls[0]?.[0]).toEqual([PART_B]);
		// Two clips in, one clip out — nothing was deleted.
		expect(onDiscard).not.toHaveBeenCalled();
	});

	test("removing the LAST clip asks first, then deletes the whole voice", () => {
		// The headline fix: a voice needs audio, so dropping its only clip IS
		// deleting the voice rather than leaving a named row pointing at nothing.
		const entry = savedClip("1", "Narrator", COMBINED, {
			clips: [part(PART_A, "part-a.wav", 8)],
		});
		useVoiceLibraryStore.setState({ voices: [entry] });
		const { onDiscard, onSetClips } = renderField({
			live: clipVoice({
				clips: [part(PART_A, "part-a.wav", 8)],
				seconds: 8,
				value: COMBINED,
			}),
		});

		fireEvent.click(screen.getByRole("button", { name: "Remove part-a.wav" }));

		// Nothing has happened yet — the destructive act is behind a confirm.
		expect(onSetClips).not.toHaveBeenCalled();
		expect(screen.getByText(LAST_CLIP_TITLE)).toBeTruthy();
		expect(
			screen.getByText(
				"A voice needs audio, so removing this clip deletes the voice.",
			),
		).toBeTruthy();

		confirmDestructive();

		expect(onSetClips).not.toHaveBeenCalled();
		expect(onDiscard).toHaveBeenCalledTimes(1);
		const discarded = onDiscard.mock.calls[0]?.[0] as {
			entry: SavedVoice | null;
			paths: readonly string[];
		};
		expect(discarded.entry).toEqual(entry);
		// Its parts AND the combined clip welded from them — both leave the disk.
		expect(discarded.paths).toEqual([PART_A, COMBINED]);
	});

	test("cancelling the last-clip confirm keeps the voice", () => {
		const { onDiscard, onSetClips } = renderField({
			live: clipVoice({
				clips: [part(PART_A, "part-a.wav", 8)],
				seconds: 8,
				value: COMBINED,
			}),
		});

		fireEvent.click(screen.getByRole("button", { name: "Remove part-a.wav" }));
		const cancel = screen
			.getAllByRole("button")
			.find((el) => el.textContent?.trim() === "Cancel");
		fireEvent.click(cancel as HTMLElement);

		expect(onDiscard).not.toHaveBeenCalled();
		expect(onSetClips).not.toHaveBeenCalled();
	});

	test("an unnamed voice's last clip still discards, with no library row to unlist", () => {
		const { onDiscard } = renderField({
			live: clipVoice({
				clips: [part(PART_A, "part-a.wav", 8)],
				seconds: 8,
				value: COMBINED,
			}),
		});

		fireEvent.click(screen.getByRole("button", { name: "Remove part-a.wav" }));
		confirmDestructive();

		expect(onDiscard.mock.calls[0]?.[0]).toEqual({
			entry: null,
			paths: [PART_A, COMBINED],
		});
	});

	test("every clip row locks while a build is running", () => {
		renderField({
			busy: true,
			live: clipVoice({
				clips: [part(PART_A, "part-a.wav", 8)],
				seconds: 8,
				value: COMBINED,
			}),
		});

		expect(
			(
				screen.getByRole("button", {
					name: "Remove part-a.wav",
				}) as HTMLButtonElement
			).disabled,
		).toBe(true);
	});
});

describe("VoiceField — capacity against the model's budget", () => {
	function meterCaption(): string {
		return screen.getByRole("progressbar").getAttribute("aria-labelledby") ===
			null
			? ""
			: (document.getElementById(
					screen.getByRole("progressbar").getAttribute("aria-labelledby") ?? "",
				)?.textContent ?? "");
	}

	test("below the engine's 1s floor it asks for more audio", () => {
		renderField({
			live: clipVoice({
				clips: [part(PART_A, "part-a.wav", 0.5)],
				seconds: 0.5,
				value: COMBINED,
			}),
		});

		expect(screen.getByText("Add at least 1s of audio")).toBeTruthy();
	});

	test("with room left it reports what is left, summed across clips", () => {
		renderField({
			live: clipVoice({
				clips: [part(PART_A, "part-a.wav", 8), part(PART_B, "part-b.wav", 4)],
				seconds: 12,
				value: COMBINED,
			}),
		});

		// 8 + 4 of audio, plus the ONE 0.25s gap the backend welds between them —
		// the cap applies to the concatenation, so the meter spends it too.
		expect(screen.getByText("17.8s left")).toBeTruthy();
		expect(meterCaption()).toBe("12.3s of 30s used · 2 clips");
		const meter = screen.getByRole("progressbar");
		expect(meter.getAttribute("aria-valuenow")).toBe("12.25");
		expect(meter.getAttribute("aria-valuemax")).toBe("30");
	});

	test("the welded gaps count against the cap, not just the clips", () => {
		// The meter used to fill against the bare sum of the parts, which is not what
		// the backend caps. Worst exactly here: on OmniVoice's 5s budget three clips
		// spend 0.5s — a tenth of the whole budget — on gaps, so a parts-only meter
		// reported room that the weld would immediately trim away.
		renderField({
			clip: { maxSecs: 5 },
			live: clipVoice({
				clips: [
					part(PART_A, "a.wav", 1.5),
					part(PART_B, "b.wav", 1.5),
					part("C:\\AppData\\tts\\reference-voices\\part-c.wav", "c.wav", 1.5),
				],
				seconds: 5,
				value: COMBINED,
			}),
		});

		// 4.5s of audio + 2 × 0.25s of silence is AT the cap — not 0.5s short of it.
		expect(screen.getByText("Full — more audio will be trimmed")).toBeTruthy();
		expect(meterCaption()).toBe("5s of 5s used · 3 clips");
		expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe(
			"5",
		);
	});

	test("at capacity it warns that more audio loses its tail", () => {
		renderField({
			live: clipVoice({
				clips: [part(PART_A, "part-a.wav", 30)],
				seconds: 30,
				value: COMBINED,
			}),
		});

		expect(screen.getByText("Full — more audio will be trimmed")).toBeTruthy();
	});

	test("the cap comes from the catalog row, not a second copy in the UI", () => {
		// OmniVoice's reference budget is 5s, not the 30s default. Nothing in the
		// meter may quote 30 when the selected model says 5.
		renderField({
			clip: { maxSecs: 5 },
			live: clipVoice({
				clips: [part(PART_A, "part-a.wav", 3)],
				seconds: 3,
				value: COMBINED,
			}),
		});

		expect(meterCaption()).toBe("3s of 5s used · 1 clip");
		expect(screen.getByRole("progressbar").getAttribute("aria-valuemax")).toBe(
			"5",
		);
		expect(screen.getByText("2s left")).toBeTruthy();
		expect(screen.queryByText(/30s/)).toBeNull();
	});

	test("a restored voice with unmeasured clips is not told it is empty", () => {
		// Durations are not re-derived on restore (that means decoding the audio
		// again), so zero seconds across REAL clips means "unmeasured", not "empty".
		renderField({
			live: clipVoice({
				clips: [part(PART_A, "part-a.wav", 0)],
				seconds: 0,
				value: COMBINED,
			}),
		});

		expect(screen.queryByRole("progressbar")).toBeNull();
		expect(screen.queryByText("Add at least 1s of audio")).toBeNull();
		expect(within(card()).getByText("1 clip")).toBeTruthy();
	});

	test("no meter at all before the voice has audio", () => {
		renderField({ live: clipVoice() });

		expect(screen.queryByRole("progressbar")).toBeNull();
		expect(screen.getByText("No voice yet")).toBeTruthy();
	});
});

describe("VoiceField — what the backend reported", () => {
	test("says plainly that a long clip was trimmed, and to how many seconds", () => {
		renderField({
			clip: { trimmed: true },
			live: clipVoice({
				clips: [part(PART_A, "part-a.wav", 30)],
				seconds: 30,
				value: COMBINED,
			}),
		});

		expect(screen.getByText(TRIMMED_NOTICE)).toBeTruthy();
	});

	test("does not claim a trim when the clips fitted", () => {
		renderField({
			live: clipVoice({
				clips: [part(PART_A, "part-a.wav", 8)],
				seconds: 8,
				value: COMBINED,
			}),
		});

		expect(screen.queryByText(TRIMMED_NOTICE)).toBeNull();
	});

	test("surfaces a build failure verbatim instead of keeping a broken voice quietly", () => {
		renderField({
			clip: {
				error:
					"Reference clip is too short — use at least ~1 second of clear speech.",
			},
			live: clipVoice(),
		});

		expect(screen.getByTestId("voice-notice").textContent).toBe(
			"Reference clip is too short — use at least ~1 second of clear speech.",
		);
	});

	test("the notices are PERSISTENT live regions, present before they have text", () => {
		// A live region is only announced when its contents change while it is
		// already in the accessibility tree. Mounting a fresh element that arrives
		// with its text already inside announces nothing — which is exactly what
		// three conditionally-rendered notices did. So the elements exist from the
		// first render and the text takes turns inside them.
		const view = renderField({ live: clipVoice() });

		const notice = screen.getByTestId("voice-notice");
		const trim = screen.getByTestId("voice-trim-notice");
		expect(notice.textContent).toBe("");
		expect(trim.textContent).toBe("");
		expect(notice.getAttribute("role")).toBe("status");
		expect(trim.getAttribute("role")).toBe("status");

		view.rerender({
			clip: { error: UNSUPPORTED, trimmed: true },
			live: clipVoice({
				clips: [part(PART_A, "part-a.wav", 30)],
				seconds: 30,
				value: COMBINED,
			}),
		});

		// The SAME nodes now carry the text — not replacements.
		expect(screen.getByTestId("voice-notice")).toBe(notice);
		expect(screen.getByTestId("voice-trim-notice")).toBe(trim);
		expect(notice.textContent).toBe(UNSUPPORTED);
		// Two independent facts: a build can trim AND then fail, so the trim report
		// keeps its own region rather than being displaced by the error.
		expect(trim.textContent).toBe(TRIMMED_NOTICE);
	});
});

describe("VoiceField — the transcript", () => {
	const withClip = clipVoice({
		clips: [part(PART_A, "part-a.wav", 9)],
		seconds: 9,
		value: COMBINED,
	});

	test("collects the transcript for an engine that clones from clip + text", () => {
		const { onRefTextChange } = renderField({
			clip: { needsRefText: true, refText: "auto transcript" },
			live: withClip,
		});

		const textarea = screen.getByDisplayValue(
			"auto transcript",
		) as HTMLTextAreaElement;
		fireEvent.change(textarea, { target: { value: "corrected" } });

		expect(onRefTextChange.mock.calls[0]?.[0]).toBe("corrected");
	});

	test("hides the transcript for an engine that clones from the clip alone", () => {
		renderField({ clip: { needsRefText: false }, live: withClip });

		expect(screen.queryByText("Transcript")).toBeNull();
	});

	test("hides the transcript until there is audio to transcribe", () => {
		renderField({ clip: { needsRefText: true }, live: clipVoice() });

		expect(screen.queryByText("Transcript")).toBeNull();
	});

	test("is the shared auto-growing textarea, with no resize grip to drag", () => {
		renderField({ clip: { needsRefText: true }, live: withClip });

		const textarea = screen.getByPlaceholderText(
			REF_PLACEHOLDER,
		) as HTMLTextAreaElement;
		expect(textarea.tagName).toBe("TEXTAREA");
		// `AutoTextarea` owns its height: it starts at `minRows` and grows on input,
		// so no `resize` affordance may survive in the class list.
		expect(textarea.getAttribute("rows")).toBe("2");
		expect(textarea.className).toContain("resize-none");
		expect(textarea.className).not.toContain("resize-y");
	});

	test("says it is transcribing while the STT model runs", () => {
		renderField({ busy: true, clip: { needsRefText: true }, live: withClip });

		expect(screen.getByPlaceholderText("Transcribing reference…")).toBeTruthy();
	});
});

describe("VoiceField — an engine with no built-in voice", () => {
	const withClip = clipVoice({
		clips: [part(PART_A, "part-a.wav", 9)],
		seconds: 9,
		value: COMBINED,
	});

	test("warns that the model cannot speak until audio is added", () => {
		renderField({ clip: { requiresClip: true }, live: clipVoice() });

		expect(screen.getByText(REQUIRED_CLIP)).toBeTruthy();
	});

	test("moves the warning to the transcript once audio exists", () => {
		renderField({
			clip: { needsRefText: true, refText: "", requiresClip: true },
			live: withClip,
		});

		expect(screen.queryByText(REQUIRED_CLIP)).toBeNull();
		expect(screen.getByText(REQUIRED_REF_TEXT)).toBeTruthy();
	});

	test("whitespace does not count as a transcript", () => {
		renderField({
			clip: { needsRefText: true, refText: "   \n  ", requiresClip: true },
			live: withClip,
		});

		expect(screen.getByText(REQUIRED_REF_TEXT)).toBeTruthy();
	});

	test("clears once the requirement is met", () => {
		renderField({
			clip: {
				needsRefText: true,
				refText: "what the clip says",
				requiresClip: true,
			},
			live: withClip,
		});

		expect(screen.queryByTestId("clone-clip-required-warning")).toBeNull();
	});

	test("stays silent for an engine that ships a usable voice", () => {
		renderField({
			clip: { needsRefText: true, requiresClip: false },
			live: clipVoice(),
		});

		expect(screen.queryByTestId("clone-clip-required-warning")).toBeNull();
	});

	test("a real failure suppresses the warning so the two never stack", () => {
		renderField({
			clip: { error: UNSUPPORTED, requiresClip: true },
			live: clipVoice(),
		});

		expect(screen.getByTestId("voice-notice").textContent).toBe(UNSUPPORTED);
		expect(screen.queryByTestId("clone-clip-required-warning")).toBeNull();
	});
});

describe("VoiceField — naming a voice", () => {
	test("name and audio are the same act: the name box lives in the card", () => {
		renderField({
			live: clipVoice({
				clips: [part(PART_A, "part-a.wav", 8)],
				seconds: 8,
				value: COMBINED,
			}),
		});

		expect(within(card()).getByPlaceholderText(NAME_PLACEHOLDER)).toBeTruthy();
	});

	test("on a model that cannot speak without a clip the name is inert until one lands", () => {
		// The backend REJECTS audio below its floor, so a value only ever exists
		// once real audio cleared it — naming stays disabled until then.
		const view = renderField({
			clip: { requiresClip: true },
			live: clipVoice(),
		});

		expect(
			(screen.getByPlaceholderText(NAME_PLACEHOLDER) as HTMLInputElement)
				.disabled,
		).toBe(true);

		view.rerender({
			clip: { requiresClip: true },
			live: clipVoice({
				clips: [part(PART_A, "part-a.wav", 8)],
				seconds: 8,
				value: COMBINED,
			}),
		});

		expect(
			(screen.getByPlaceholderText(NAME_PLACEHOLDER) as HTMLInputElement)
				.disabled,
		).toBe(false);
	});

	test("Enter names the voice, capturing the clips behind it", () => {
		renderField({
			live: clipVoice({
				clips: [part(PART_A, "part-a.wav", 8), part(PART_B, "part-b.wav", 4)],
				seconds: 12,
				value: COMBINED,
			}),
		});

		const input = screen.getByPlaceholderText(NAME_PLACEHOLDER);
		fireEvent.change(input, { target: { value: "Narrator" } });
		fireEvent.keyDown(input, { key: "Enter" });

		const saved = useVoiceLibraryStore.getState().voices;
		expect(saved).toHaveLength(1);
		expect(saved[0]?.name).toBe("Narrator");
		expect(saved[0]?.value).toBe(COMBINED);
		expect(saved[0]?.clips.map((c) => c.path)).toEqual([PART_A, PART_B]);
	});

	test("clicking away commits the name instead of silently dropping it", () => {
		// The trap this closes sat on the PRIMARY path: the field committed on Enter
		// alone, so anyone who typed a name and clicked the next control lost it with
		// no feedback at all.
		renderField({
			live: clipVoice({
				clips: [part(PART_A, "part-a.wav", 8)],
				seconds: 8,
				value: COMBINED,
			}),
		});

		const input = screen.getByPlaceholderText(NAME_PLACEHOLDER);
		fireEvent.change(input, { target: { value: "Narrator" } });
		fireEvent.blur(input);

		expect(useVoiceLibraryStore.getState().voices[0]?.name).toBe("Narrator");
	});

	test("a visible confirm button commits it too — the gesture is not a guess", () => {
		renderField({
			live: clipVoice({
				clips: [part(PART_A, "part-a.wav", 8)],
				seconds: 8,
				value: COMBINED,
			}),
		});

		// Inert until there is a name to save.
		expect(
			(
				screen.getByRole("button", {
					name: 'Save as ""',
				}) as HTMLButtonElement
			).disabled,
		).toBe(true);

		fireEvent.change(screen.getByPlaceholderText(NAME_PLACEHOLDER), {
			target: { value: "Narrator" },
		});
		fireEvent.click(screen.getByRole("button", { name: 'Save as "Narrator"' }));

		expect(useVoiceLibraryStore.getState().voices[0]?.name).toBe("Narrator");
	});

	test("Escape abandons — and the blur that follows commits nothing", () => {
		renderField({
			live: clipVoice({
				clips: [part(PART_A, "part-a.wav", 8)],
				seconds: 8,
				value: COMBINED,
			}),
		});

		const input = screen.getByPlaceholderText(NAME_PLACEHOLDER);
		fireEvent.change(input, { target: { value: "Narrator" } });
		fireEvent.keyDown(input, { key: "Escape" });

		expect((input as HTMLInputElement).value).toBe("");

		fireEvent.blur(input);

		expect(useVoiceLibraryStore.getState().voices).toHaveLength(0);
	});

	test("an all-whitespace name is not a name", () => {
		renderField({
			live: clipVoice({
				clips: [part(PART_A, "part-a.wav", 8)],
				seconds: 8,
				value: COMBINED,
			}),
		});

		const input = screen.getByPlaceholderText(NAME_PLACEHOLDER);
		fireEvent.change(input, { target: { value: "   " } });
		fireEvent.keyDown(input, { key: "Enter" });
		fireEvent.blur(input);

		expect(useVoiceLibraryStore.getState().voices).toHaveLength(0);
	});

	test("the name box disappears once this audio is in the library", () => {
		// From then on the combobox owns the name; a second name box would offer to
		// fork the voice on every keystroke.
		useVoiceLibraryStore.setState({
			voices: [savedClip("1", "Narrator", COMBINED)],
		});
		renderField({
			live: clipVoice({
				clips: [part(PART_A, "part-a.wav", 8)],
				seconds: 8,
				value: COMBINED,
			}),
		});

		expect(screen.queryByPlaceholderText(NAME_PLACEHOLDER)).toBeNull();
	});

	test("the library's own create row stays hidden while there is nothing worth naming", () => {
		// An empty voice would save a row that restores nothing.
		renderField({ live: clipVoice() });

		typeAndOpen("Narrator");

		expect(screen.queryByText('Save as "Narrator"')).toBeNull();
	});

	test("naming through the combobox captures the same voice", () => {
		renderField({
			live: clipVoice({
				clips: [part(PART_A, "part-a.wav", 8)],
				seconds: 8,
				value: COMBINED,
			}),
		});

		typeAndOpen("Narrator");
		fireEvent.click(screen.getByText('Save as "Narrator"'));

		const saved = useVoiceLibraryStore.getState().voices;
		expect(saved).toHaveLength(1);
		expect(saved[0]?.value).toBe(COMBINED);
		expect(saved[0]?.clips).toHaveLength(1);
	});
});

describe("VoiceField — the library", () => {
	test("selecting an entry restores it, clips and all, into the live settings", () => {
		useVoiceLibraryStore.setState({
			voices: [
				savedClip("1", "Narrator", COMBINED, {
					clips: [part(PART_A, "part-a.wav", 8)],
					refText: "hello",
				}),
			],
		});
		const { onApply } = renderField({
			live: clipVoice({ value: "C:/clips/other.wav" }),
		});

		openPopup();
		fireEvent.click(screen.getByText("Narrator"));

		expect(onApply).toHaveBeenCalledTimes(1);
		expect(onApply.mock.calls[0]?.[0]).toEqual({
			clips: [part(PART_A, "part-a.wav", 8)],
			kind: "clip",
			maxSecs: 30,
			value: COMBINED,
			refText: "hello",
			seconds: 8,
		});
		expect(useVoiceLibraryStore.getState().activeVoiceId).toBe("1");
	});

	test("shows the applied entry, and marks it dirty once the live voice diverges", () => {
		useVoiceLibraryStore.setState({
			voices: [savedClip("1", "Narrator", COMBINED)],
			activeVoiceId: "1",
		});
		renderField({ live: clipVoice({ value: "C:/clips/edited.wav" }) });

		// The dirty row keeps the field populated (never blank) and exposes the
		// overwrite / revert actions.
		expect(
			(screen.getByPlaceholderText(PLACEHOLDER) as HTMLInputElement).value,
		).toBe("Narrator");
		openPopup();
		expect(
			screen.getByRole("button", { name: "Overwrite with the current voice" }),
		).toBeTruthy();
		expect(
			screen.getByRole("button", { name: "Revert to the saved voice" }),
		).toBeTruthy();
	});

	// The write itself is the CALLER's, not this field's: re-pointing a row strands
	// the combined clip it used to name, and that sweep has to happen in the same
	// breath as the write (see `overwriteSavedVoice`). So the field's contract is
	// "hand over the row id and the live voice, clips included" — asserted here —
	// and the store mutation plus the sweep are covered in the hook's own suite.
	test("overwriting a dirty entry hands over the live voice AND its clips", () => {
		useVoiceLibraryStore.setState({
			voices: [savedClip("1", "Narrator", COMBINED)],
			activeVoiceId: "1",
		});
		const { onOverwrite } = renderField({
			live: clipVoice({
				clips: [part(PART_B, "part-b.wav", 4)],
				refText: "hello",
				seconds: 4,
				value: "C:/clips/edited.wav",
			}),
		});

		openPopup();
		fireEvent.click(
			screen.getByRole("button", { name: "Overwrite with the current voice" }),
		);

		expect(onOverwrite).toHaveBeenCalledTimes(1);
		const [id, value] = onOverwrite.mock.calls[0] as [string, SavedVoiceValue];
		expect(id).toBe("1");
		expect(value.value).toBe("C:/clips/edited.wav");
		expect(value.refText).toBe("hello");
		expect(value.clips.map((clip) => clip.path)).toEqual([PART_B]);
	});

	test("deleting a voice asks first, then hands its files over to be unlinked", () => {
		const entry = savedClip("1", "Narrator", COMBINED, {
			clips: [part(PART_A, "part-a.wav", 8), part(PART_B, "part-b.wav", 4)],
		});
		useVoiceLibraryStore.setState({ voices: [entry] });
		const { onDiscard } = renderField({
			live: clipVoice({ value: COMBINED, seconds: 12 }),
		});

		openPopup();
		fireEvent.click(screen.getByRole("button", { name: "Delete voice" }));

		// The row is NOT gone yet — deleting destroys audio on disk, so it confirms.
		expect(useVoiceLibraryStore.getState().voices).toHaveLength(1);
		expect(onDiscard).not.toHaveBeenCalled();
		// Named in BOTH halves: "this voice" would ask the user to trust that the
		// click landed on the row they meant.
		expect(screen.getByText(DELETE_VOICE_TITLE)).toBeTruthy();
		expect(
			screen.getByText(
				'The audio clips behind "Narrator" are removed from disk. This cannot be undone.',
			),
		).toBeTruthy();

		confirmDestructive();

		expect(onDiscard.mock.calls[0]?.[0]).toEqual({
			entry,
			// Its parts AND the combined clip welded from them.
			paths: [PART_A, PART_B, COMBINED],
		});
	});

	test("deleting a voice-design row asks for no files to be unlinked", () => {
		// Its `value` is prose; handing that to a delete-clips call would ask the
		// backend to unlink a sentence.
		const entry = savedDesign("1", "Villain", "A low, gravelly whisper.");
		useVoiceLibraryStore.setState({ voices: [entry] });
		const { onDiscard } = renderField({
			clip: null,
			live: designVoice("A low, gravelly whisper."),
		});

		openPopup();
		fireEvent.click(screen.getByRole("button", { name: "Delete voice" }));
		confirmDestructive();

		expect(onDiscard.mock.calls[0]?.[0]).toEqual({ entry, paths: [] });
	});

	test("prev/next navigation appears only once there is somewhere to go", () => {
		useVoiceLibraryStore.setState({
			voices: [savedClip("1", "Narrator", "a.wav")],
		});
		renderField({ live: clipVoice({ value: "a.wav" }) });

		expect(screen.queryByRole("button", { name: "Next voice" })).toBeNull();
	});

	test("next applies the following entry", () => {
		useVoiceLibraryStore.setState({
			voices: [
				savedClip("1", "Narrator", "a.wav"),
				savedClip("2", "Villain", "b.wav"),
			],
		});
		const { onApply } = renderField({ live: clipVoice({ value: "a.wav" }) });

		fireEvent.click(screen.getByRole("button", { name: "Next voice" }));

		expect(onApply.mock.calls[0]?.[0]).toMatchObject({ value: "b.wav" });
		expect(useVoiceLibraryStore.getState().activeVoiceId).toBe("2");
	});

	test("hides entries the selected engine cannot consume", () => {
		// One flat library serves both engine families. Applying a clip while a
		// voice-design model is selected would put a `.wav` PATH in the field the
		// engine reads as the voice DESCRIPTION, and applying a prompt on a cloning
		// model writes prose into a field the engine opens as a file — the row would
		// look applied while the engine silently used its own voice.
		useVoiceLibraryStore.setState({
			voices: [
				savedClip("1", "Narrator", COMBINED),
				savedDesign("2", "Villain", "A low, gravelly menacing whisper."),
			],
		});
		renderField({ clip: null, live: designVoice("A bright narrator.") });

		openPopup();
		expect(screen.getByText("Villain")).toBeTruthy();
		expect(screen.queryByText("Narrator")).toBeNull();
		// …and with only one row of this kind, there is nowhere to step to.
		expect(screen.queryByRole("button", { name: "Next voice" })).toBeNull();
	});

	test("stepping never lands on an entry of the other kind", () => {
		useVoiceLibraryStore.setState({
			voices: [
				savedClip("1", "Narrator", "a.wav"),
				savedDesign("2", "Villain", "A low, gravelly menacing whisper."),
				savedClip("3", "Newsreader", "b.wav"),
			],
		});
		const { onApply } = renderField({ live: clipVoice({ value: "a.wav" }) });

		fireEvent.click(screen.getByRole("button", { name: "Next voice" }));

		expect(onApply.mock.calls[0]?.[0]).toMatchObject({
			kind: "clip",
			value: "b.wav",
		});
	});

	test("reports a persistence failure rather than pretending the voice was saved", () => {
		useVoiceLibraryStore.setState({ persistFailed: "save" });
		renderField({ live: clipVoice({ value: "a.wav" }) });

		expect(screen.getByText(PERSIST_FAILED)).toBeTruthy();
	});

	test("stays reachable with an empty library — that is when the first voice is named", () => {
		renderField({
			live: clipVoice({
				clips: [part(PART_A, "part-a.wav", 8)],
				seconds: 8,
				value: COMBINED,
			}),
		});

		expect(
			(screen.getByPlaceholderText(PLACEHOLDER) as HTMLInputElement).disabled,
		).toBe(false);
	});

	test("goes inert only when there is nothing to pick AND nothing to name", () => {
		renderField({ live: clipVoice() });

		expect(
			(screen.getByPlaceholderText(PLACEHOLDER) as HTMLInputElement).disabled,
		).toBe(true);
		expect(
			screen.getByText(
				"Choose a reference clip or write a voice description first, then name it to save it here.",
			),
		).toBeTruthy();
	});
});

describe("VoiceField — one selector for both kinds of voice", () => {
	const PRESETS = [
		{ id: "female", label: "Female" },
		{ id: "male", label: "Male" },
	];
	const BUILT_IN_HEADER = "Built-in";
	const SAVED_HEADER = "My voices";

	test("the model's own voices and the user's sit in one list, in marked sections", () => {
		useVoiceLibraryStore.setState({
			voices: [savedClip("1", "Narrator", COMBINED)],
		});
		renderField({ clip: { presets: PRESETS }, live: clipVoice() });

		openPopup();

		// Both populations are offered at once — the built-in dropdown that used to
		// live inside the card (and vanished the moment a clip existed) is gone.
		expect(screen.getByText("Female")).toBeTruthy();
		expect(screen.getByText("Narrator")).toBeTruthy();
		expect(screen.getByText(BUILT_IN_HEADER)).toBeTruthy();
		expect(screen.getByText(SAVED_HEADER)).toBeTruthy();
	});

	test("a built-in stays reachable after a clip exists", () => {
		// The regression this replaces: once a cloning engine had audio, its own
		// voice could not be selected again without deleting the voice.
		const { onPresetChange } = renderField({
			clip: { presets: PRESETS },
			live: clipVoice({
				clips: [part(PART_A, "part-a.wav", 8)],
				seconds: 8,
				value: COMBINED,
			}),
		});

		openPopup();
		fireEvent.click(screen.getByText("Male"));

		// Routed to the preset half, which is what drops the reference clip.
		expect(onPresetChange.mock.calls[0]?.[0]).toBe("male");
	});

	test("selecting a saved voice still applies it, not a preset", () => {
		useVoiceLibraryStore.setState({
			voices: [savedClip("1", "Narrator", COMBINED)],
		});
		const { onApply, onPresetChange } = renderField({
			clip: { presets: PRESETS },
			live: clipVoice(),
		});

		openPopup();
		fireEvent.click(screen.getByText("Narrator"));

		expect(onPresetChange).not.toHaveBeenCalled();
		expect(onApply.mock.calls[0]?.[0]).toMatchObject({ value: COMBINED });
	});

	test("with no clip the field shows the built-in that is actually speaking", () => {
		renderField({
			clip: { presets: PRESETS, presetVoice: "male" },
			live: clipVoice(),
		});

		expect(
			(screen.getByPlaceholderText(PLACEHOLDER) as HTMLInputElement).value,
		).toBe("Male");
	});

	test("an engine with no voice of its own offers no built-in section", () => {
		// Audio8's catalog row carries a sentinel entry that is not a voice —
		// selecting it is a synthesis error, so it must not be offered at all.
		useVoiceLibraryStore.setState({
			voices: [savedClip("1", "Narrator", COMBINED)],
		});
		renderField({
			clip: {
				presets: [
					{ id: "default", label: "Cloned voice (add a reference clip)" },
				],
				requiresClip: true,
			},
			live: clipVoice(),
		});

		openPopup();
		expect(screen.queryByText(BUILT_IN_HEADER)).toBeNull();
		expect(
			screen.queryByText("Cloned voice (add a reference clip)"),
		).toBeNull();
		expect(screen.getByText("Narrator")).toBeTruthy();
	});

	test("a built-in section does not make an empty voice nameable", () => {
		// Also the regression guard for a query that matches NOTHING while the list
		// is sectioned: every group filters away, and the popup has to fall back to
		// its empty state rather than wedging on a group collection with no groups
		// in it.
		renderField({ clip: { presets: PRESETS }, live: clipVoice() });

		typeAndOpen("Narrator");

		expect(screen.queryByText('Save as "Narrator"')).toBeNull();
		expect(
			screen.getByText("No saved voices yet — type a name to save this one."),
		).toBeTruthy();
	});
});

describe("resolveVoiceClips", () => {
	const reported = [part(PART_A, "part-a.wav", 8)];
	const restored = [part(PART_A, "part-a.wav", 8), part(PART_B, "b.wav", 4)];

	test("prefers the backend's report for this build — the only measured source", () => {
		const stored = savedClip("1", "Narrator", COMBINED, { clips: restored });
		expect(
			resolveVoiceClips(
				clipVoice({ clips: reported, value: COMBINED }),
				stored,
			),
		).toEqual(reported);
	});

	test("falls back to the library row holding the same combined clip", () => {
		// After a restart there is no report, and the row is the ONLY record of what
		// went into the combined file. Guessing a single part here would make a
		// six-clip voice look like a one-clip one.
		const stored = savedClip("1", "Narrator", COMBINED, { clips: restored });
		expect(resolveVoiceClips(clipVoice({ value: COMBINED }), stored)).toEqual(
			restored,
		);
	});

	test("lets the combined path stand in for itself when nothing else knows", () => {
		// A voice adopted before the library existed, or one never named: there IS
		// audio, so the card must say so and removal must stay reachable.
		expect(
			resolveVoiceClips(clipVoice({ seconds: 7, value: COMBINED }), null),
		).toEqual([{ name: "narrator-9f.wav", path: COMBINED, seconds: 7 }]);
	});

	test("a design prompt and an empty voice own no clips", () => {
		expect(resolveVoiceClips(designVoice("a warm narrator"), null)).toEqual([]);
		expect(resolveVoiceClips(clipVoice({ value: "   " }), null)).toEqual([]);
	});
});

describe("stepVoiceId", () => {
	// The arrows walk everything the popup offers, in the order it offers it —
	// which now spans both populations, so the ids arrive already merged.
	const ids = ["builtin:female", "1", "2"];

	test("wraps in both directions", () => {
		expect(stepVoiceId(ids, "2", 1)).toBe("builtin:female");
		expect(stepVoiceId(ids, "builtin:female", -1)).toBe("2");
	});

	test("steps from a built-in into the saved voices and back", () => {
		expect(stepVoiceId(ids, "builtin:female", 1)).toBe("1");
		expect(stepVoiceId(ids, "1", -1)).toBe("builtin:female");
	});

	test("starts at either end when nothing is shown", () => {
		expect(stepVoiceId(ids, "", 1)).toBe("builtin:female");
		expect(stepVoiceId(ids, "", -1)).toBe("2");
	});

	test("has nowhere to go with fewer than two entries", () => {
		expect(stepVoiceId(ids.slice(0, 1), "builtin:female", 1)).toBe("");
		expect(stepVoiceId([], "", 1)).toBe("");
	});
});
