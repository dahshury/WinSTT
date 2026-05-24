import { describe, expect, test } from "bun:test";
import {
	EMPTY_CONTEXT,
	formatContextForPrompt,
	type WindowContextSnapshot,
} from "./context-snapshot";

describe("EMPTY_CONTEXT", () => {
	test("exposes empty strings for every snapshot field", () => {
		expect(EMPTY_CONTEXT).toEqual({
			windowTitle: "",
			elementName: "",
			focusedText: "",
		});
	});
});

describe("formatContextForPrompt", () => {
	test("returns empty string when every field is blank", () => {
		expect(formatContextForPrompt(EMPTY_CONTEXT)).toBe("");
	});

	test("returns empty string when fields contain only whitespace", () => {
		const snapshot: WindowContextSnapshot = {
			windowTitle: "   ",
			elementName: "\t\n",
			focusedText: "   \n\n   ",
		};
		expect(formatContextForPrompt(snapshot)).toBe("");
	});

	test("emits only the window title when it is the only populated field", () => {
		const result = formatContextForPrompt({
			windowTitle: "Slack",
			elementName: "",
			focusedText: "",
		});
		expect(result).toBe("Window: Slack");
	});

	test("emits only the focused element when it is the only populated field", () => {
		const result = formatContextForPrompt({
			windowTitle: "",
			elementName: "Subject",
			focusedText: "",
		});
		expect(result).toBe("Focused field: Subject");
	});

	test("emits only the visible content when it is the only populated field", () => {
		const result = formatContextForPrompt({
			windowTitle: "",
			elementName: "",
			focusedText: "hello",
		});
		expect(result).toBe("Visible content:\nhello");
	});

	test("trims leading/trailing whitespace from each field", () => {
		const result = formatContextForPrompt({
			windowTitle: "  Mail  ",
			elementName: "\tSubject\n",
			focusedText: "  Project Nighthawk  ",
		});
		expect(result).toBe(
			"Window: Mail\nFocused field: Subject\nVisible content:\nProject Nighthawk"
		);
	});

	test("collapses runs of two or more blank lines in focused text to a single newline", () => {
		const result = formatContextForPrompt({
			windowTitle: "",
			elementName: "",
			focusedText: "alpha\n\n\n\nbeta",
		});
		expect(result).toBe("Visible content:\nalpha\nbeta");
	});

	test("preserves single newlines inside the focused text untouched", () => {
		const result = formatContextForPrompt({
			windowTitle: "",
			elementName: "",
			focusedText: "alpha\nbeta",
		});
		expect(result).toBe("Visible content:\nalpha\nbeta");
	});

	test("emits all three sections, in canonical order, when all fields are populated", () => {
		const result = formatContextForPrompt({
			windowTitle: "Mail",
			elementName: "Subject",
			focusedText: "Project Nighthawk",
		});
		expect(result).toBe(
			"Window: Mail\nFocused field: Subject\nVisible content:\nProject Nighthawk"
		);
	});

	test("skips blank windowTitle while still emitting element + content", () => {
		const result = formatContextForPrompt({
			windowTitle: "",
			elementName: "Subject",
			focusedText: "body",
		});
		expect(result).toBe("Focused field: Subject\nVisible content:\nbody");
	});

	test("skips blank elementName while still emitting title + content", () => {
		const result = formatContextForPrompt({
			windowTitle: "Mail",
			elementName: "",
			focusedText: "body",
		});
		expect(result).toBe("Window: Mail\nVisible content:\nbody");
	});

	test("skips blank focusedText while still emitting title + element", () => {
		const result = formatContextForPrompt({
			windowTitle: "Mail",
			elementName: "Subject",
			focusedText: "",
		});
		expect(result).toBe("Window: Mail\nFocused field: Subject");
	});

	test("does not mutate the input snapshot", () => {
		const snapshot: WindowContextSnapshot = {
			windowTitle: "  Mail  ",
			elementName: "  Subject  ",
			focusedText: "alpha\n\n\nbeta",
		};
		const before = { ...snapshot };
		formatContextForPrompt(snapshot);
		expect(snapshot).toEqual(before);
	});
});

describe("formatContextForPrompt — caret-split mode", () => {
	test("emits before/after caret sections and suppresses Visible content", () => {
		const result = formatContextForPrompt({
			windowTitle: "VS Code",
			elementName: "Editor",
			focusedText: "should be ignored in caret mode",
			textBefore: "The meeting is",
			textAfter: " at noon.",
		});
		expect(result).toContain("Window: VS Code");
		expect(result).toContain("Focused field: Editor");
		expect(result).toContain("before the caret");
		expect(result).toContain("The meeting is");
		expect(result).toContain("after the caret");
		expect(result).toContain("at noon.");
		// focusedText must NOT leak in (it would duplicate the split text).
		expect(result).not.toContain("Visible content");
		expect(result).not.toContain("should be ignored");
	});

	test("emits only the before section when after is empty", () => {
		const result = formatContextForPrompt({
			windowTitle: "",
			elementName: "",
			focusedText: "",
			textBefore: "continue this thought",
			textAfter: "",
		});
		expect(result).toContain("before the caret");
		expect(result).toContain("continue this thought");
		expect(result).not.toContain("after the caret");
	});

	test("falls back to legacy layout when both caret fields are blank", () => {
		const result = formatContextForPrompt({
			windowTitle: "Mail",
			elementName: "Subject",
			focusedText: "body",
			textBefore: "   ",
			textAfter: "",
		});
		expect(result).toBe("Window: Mail\nFocused field: Subject\nVisible content:\nbody");
	});

	test("collapses blank-line runs inside caret text", () => {
		const result = formatContextForPrompt({
			windowTitle: "",
			elementName: "",
			focusedText: "",
			textBefore: "alpha\n\n\n\nbeta",
			textAfter: "",
		});
		expect(result).toContain("alpha\nbeta");
		expect(result).not.toContain("alpha\n\n");
	});

	test("does not mutate a caret-mode input snapshot", () => {
		const snapshot: WindowContextSnapshot = {
			windowTitle: "X",
			elementName: "Y",
			focusedText: "",
			textBefore: "a\n\n\nb",
			textAfter: "c",
		};
		const before = { ...snapshot };
		formatContextForPrompt(snapshot);
		expect(snapshot).toEqual(before);
	});
});
