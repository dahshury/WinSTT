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
