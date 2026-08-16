import { afterEach, describe, expect, mock, test } from "bun:test";
import { useTranslations } from "use-intl";
import {
	cleanup,
	fireEvent,
	render,
	screen,
} from "@/shared/ui/model-picker/test/render-with-intl";
import { InlineTagsField, type InlineTagsFieldProps } from "./InlineTagsField";

const LABEL = "Inline tags";
// The two shipped vocabularies as the CATALOG renders them (via
// `formatInlineTagList`) and hands them to this component. They appear here as
// fixtures, never as something the component is expected to assemble.
const ORPHEUS_TAGS = "<laugh> <sigh> <gasp>";
const TURBO_TAGS = "[laugh] [cough]";

/** `t` is a prop, so the harness supplies the REAL `tts` namespace — which also
 *  proves every key this row reads exists in `messages/en.json`. */
function Harness(props: Omit<InlineTagsFieldProps, "t">) {
	const t = useTranslations("tts");
	return <InlineTagsField {...props} t={t} />;
}

function renderField(
	overrides: Partial<Omit<InlineTagsFieldProps, "t">> = {},
): { onChange: ReturnType<typeof mock> } {
	const onChange = mock((_next: boolean) => undefined);
	render(
		<Harness
			blockedBy={null}
			enabled={false}
			onChange={onChange}
			tagList={ORPHEUS_TAGS}
			{...overrides}
		/>,
	);
	return { onChange };
}

function toggle(): HTMLElement {
	return screen.getByRole("switch", { name: LABEL });
}

afterEach(() => {
	cleanup();
});

describe("InlineTagsField", () => {
	test("persists the flip through onChange", () => {
		const { onChange } = renderField();
		expect(toggle().getAttribute("aria-checked")).toBe("false");

		fireEvent.click(toggle());
		expect(onChange).toHaveBeenCalledWith(true);
	});

	test("shows the selected engine's OWN vocabulary, not one fixed syntax", () => {
		renderField();
		expect(document.body.textContent).toContain(ORPHEUS_TAGS);
		cleanup();

		// Square brackets for Chatterbox Turbo, from the very same component —
		// the delimiters ride in from the catalog rather than living here. A
		// hardcoded syntax would make one of these two assertions impossible.
		renderField({ tagList: TURBO_TAGS });
		expect(document.body.textContent).toContain(TURBO_TAGS);
		expect(document.body.textContent).not.toContain("<laugh>");
	});

	test("blocked: the switch is inert and the reason is visible on the row", () => {
		const { onChange } = renderField({ blockedBy: "post-processing" });

		// Base UI's Switch.Root is a <span>, so "disabled" is `aria-disabled` —
		// which is also the bit assistive tech reads.
		expect(toggle().getAttribute("aria-disabled")).toBe("true");
		fireEvent.click(toggle());
		expect(onChange).not.toHaveBeenCalled();
		// Plain visible caption, not a hover-only tooltip: the one sentence that
		// says how to unblock the row must be readable without discovering it.
		expect(document.body.textContent).toContain(
			"Turn on AI post-processing and choose a model first",
		);
	});

	test("blocked keeps showing the persisted choice instead of faking it off", () => {
		// The user's intent must survive post-processing being switched off and
		// back on; the inert switch + caption carry "not running right now".
		renderField({ blockedBy: "post-processing", enabled: true });
		expect(toggle().getAttribute("aria-checked")).toBe("true");
	});
});
