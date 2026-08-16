import { afterEach, describe, expect, mock, test } from "bun:test";
import { useTranslations } from "use-intl";
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
} from "@/shared/ui/model-picker/test/render-with-intl";
import {
	VoiceDesignField,
	type VoiceDesignFieldProps,
} from "./VoiceDesignField";

// The catalog cap for the one voice-design row today. Written here ONLY as the
// value the test feeds in as if it came from `voiceDesignMaxChars` — the
// component must never contain this number itself.
const CAP = 300;

const TEXTAREA_PLACEHOLDER =
	"e.g. a warm, low-pitched narrator with a slight British accent";
const GENERATOR_PLACEHOLDER = "Describe a character, e.g. a Batman-like voice";
const GENERATE_ACTION = "Write the voice description with AI";
const GENERATE_PENDING = "Writing the voice description…";
const TRIGGER_PLACEHOLDER = "Design voice";

/** The component takes `t` as a prop, so the harness supplies the real `tts`
 *  namespace — which also proves every key it reads exists in `messages/en.json`. */
function Harness(props: Omit<VoiceDesignFieldProps, "t">) {
	const t = useTranslations("tts");
	return <VoiceDesignField {...props} t={t} />;
}

interface Deferred<T> {
	promise: Promise<T>;
	reject: (reason?: unknown) => void;
	resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, reject, resolve };
}

function textarea(): HTMLTextAreaElement {
	return screen.getByPlaceholderText(
		TEXTAREA_PLACEHOLDER,
	) as HTMLTextAreaElement;
}

function usedCount(): string {
	return screen.getByTestId("voice-design-char-used").textContent ?? "";
}

/** The trigger button is labelled with the current prompt (truncated) when one
 *  is set, and with the placeholder otherwise. */
function openDialog(label: string = TRIGGER_PLACEHOLDER): void {
	fireEvent.click(screen.getAllByText(label)[0] as HTMLElement);
}

function renderField(
	overrides: Partial<Omit<VoiceDesignFieldProps, "t">> = {},
): { onPromptChange: ReturnType<typeof mock> } {
	const onPromptChange = mock((_next: string) => undefined);
	render(
		<Harness
			maxChars={CAP}
			onPromptChange={onPromptChange}
			prompt=""
			{...overrides}
		/>,
	);
	return { onPromptChange };
}

async function settle(): Promise<void> {
	await act(async () => {
		await Promise.resolve();
	});
}

afterEach(() => {
	cleanup();
});

describe("VoiceDesignField — character cap", () => {
	test("caps the textarea at the model's budget and counts consumed/remaining", () => {
		renderField();
		openDialog();

		expect(textarea().maxLength).toBe(CAP);
		expect(usedCount()).toBe("0");
		expect(screen.getByText(`/ ${CAP}`)).toBeTruthy();
		expect(screen.getByText(`${CAP} left`)).toBeTruthy();

		fireEvent.change(textarea(), { target: { value: "a".repeat(128) } });
		expect(usedCount()).toBe("128");
		expect(screen.getByText(`${CAP - 128} left`)).toBeTruthy();
	});

	test("clamps text that arrives past the cap instead of overflowing the counter", () => {
		renderField();
		openDialog();

		// `maxLength` stops typing/pasting, but a programmatic value (or a
		// pre-existing over-long prompt) bypasses the DOM entirely.
		fireEvent.change(textarea(), { target: { value: "b".repeat(CAP + 50) } });

		expect(textarea().value.length).toBe(CAP);
		expect(usedCount()).toBe(String(CAP));
		expect(screen.getByText("0 left")).toBeTruthy();
	});

	test("saves the clamped, trimmed prompt", () => {
		const { onPromptChange } = renderField();
		openDialog();

		fireEvent.change(textarea(), { target: { value: `  ${"c".repeat(400)}` } });
		fireEvent.click(screen.getByText("Save"));

		// Clamped to the budget first (the two leading spaces are part of it), then
		// trimmed — so the saved prompt is never longer than the cap.
		const saved = onPromptChange.mock.calls[0]?.[0] as string;
		expect(saved).toBe("c".repeat(CAP - 2));
	});

	test("a zero budget means 'no cap known' — no maxLength, no counter", () => {
		renderField({ maxChars: 0 });
		openDialog();

		// happy-dom reports an unset maxLength as -1; the important part is that a
		// 0 from an older server never becomes a zero-length textarea.
		expect(textarea().maxLength).not.toBe(0);
		expect(screen.queryByTestId("voice-design-char-used")).toBeNull();
	});

	test("seeds an over-long stored prompt clamped so the counter stays truthful", () => {
		renderField({ prompt: "d".repeat(CAP + 200) });
		// `truncatePrompt` labels the trigger with the first 47 chars + an ellipsis.
		openDialog(`${"d".repeat(47)}…`);

		expect(textarea().value.length).toBe(CAP);
		expect(usedCount()).toBe(String(CAP));
	});
});

describe("VoiceDesignField — AI generation", () => {
	test("renders nothing when post-processing is unavailable", () => {
		renderField();
		openDialog();

		expect(screen.queryByPlaceholderText(GENERATOR_PLACEHOLDER)).toBeNull();
		expect(screen.queryByRole("button", { name: GENERATE_ACTION })).toBeNull();
	});

	test("fills the textarea with the generated prompt", async () => {
		const onGeneratePrompt = mock(async (_description: string) =>
			Promise.resolve("A deep, gravelly middle-aged American man."),
		);
		renderField({ onGeneratePrompt });
		openDialog();

		fireEvent.change(screen.getByPlaceholderText(GENERATOR_PLACEHOLDER), {
			target: { value: "a Batman-like voice" },
		});
		fireEvent.click(screen.getByRole("button", { name: GENERATE_ACTION }));
		await settle();

		expect(onGeneratePrompt).toHaveBeenCalledWith("a Batman-like voice");
		expect(textarea().value).toBe("A deep, gravelly middle-aged American man.");
	});

	test("clips a generated prompt that somehow arrives longer than the cap", async () => {
		const onGeneratePrompt = mock(async (_description: string) =>
			Promise.resolve("e".repeat(CAP + 120)),
		);
		renderField({ onGeneratePrompt });
		openDialog();

		fireEvent.change(screen.getByPlaceholderText(GENERATOR_PLACEHOLDER), {
			target: { value: "a Batman-like voice" },
		});
		fireEvent.click(screen.getByRole("button", { name: GENERATE_ACTION }));
		await settle();

		expect(textarea().value.length).toBe(CAP);
		expect(usedCount()).toBe(String(CAP));
	});

	test("shows a pending state while the model is answering", async () => {
		const pending = deferred<string>();
		renderField({ onGeneratePrompt: () => pending.promise });
		openDialog();

		fireEvent.change(screen.getByPlaceholderText(GENERATOR_PLACEHOLDER), {
			target: { value: "a Batman-like voice" },
		});
		fireEvent.click(screen.getByRole("button", { name: GENERATE_ACTION }));

		const busy = screen.getByRole("button", { name: GENERATE_PENDING });
		expect(busy.getAttribute("aria-busy")).toBe("true");
		expect(busy.hasAttribute("disabled")).toBe(true);

		await act(async () => {
			pending.resolve("A calm narrator.");
			await pending.promise;
		});
		expect(textarea().value).toBe("A calm narrator.");
		expect(screen.getByRole("button", { name: GENERATE_ACTION })).toBeTruthy();
	});

	test("surfaces the backend's refusal and leaves the draft untouched", async () => {
		renderField({
			onGeneratePrompt: () =>
				Promise.reject(new Error("No post-processing model is configured")),
		});
		openDialog();

		fireEvent.change(textarea(), { target: { value: "hand-written" } });
		fireEvent.change(screen.getByPlaceholderText(GENERATOR_PLACEHOLDER), {
			target: { value: "a Batman-like voice" },
		});
		fireEvent.click(screen.getByRole("button", { name: GENERATE_ACTION }));
		await settle();

		expect(
			screen.getByText("No post-processing model is configured"),
		).toBeTruthy();
		expect(textarea().value).toBe("hand-written");
	});

	test("does not call the model for an empty description", () => {
		const onGeneratePrompt = mock(async (_description: string) =>
			Promise.resolve("unused"),
		);
		renderField({ onGeneratePrompt });
		openDialog();

		fireEvent.change(screen.getByPlaceholderText(GENERATOR_PLACEHOLDER), {
			target: { value: "   " },
		});
		fireEvent.click(screen.getByRole("button", { name: GENERATE_ACTION }));

		expect(onGeneratePrompt).not.toHaveBeenCalled();
	});
});
