import { describe, expect, test } from "bun:test";
import { isBenignWebviewErrorMessage } from "./winstt-diag";

describe("isBenignWebviewErrorMessage", () => {
	test("ignores WebView ResizeObserver loop notifications", () => {
		expect(
			isBenignWebviewErrorMessage(
				"ResizeObserver loop completed with undelivered notifications.",
			),
		).toBe(true);
		expect(
			isBenignWebviewErrorMessage("ResizeObserver loop limit exceeded"),
		).toBe(true);
	});

	test("recognizes the bridged onerror format with a source location", () => {
		expect(
			isBenignWebviewErrorMessage(
				"onerror: ResizeObserver loop completed with undelivered notifications. @ http://127.0.0.1:1420/windows/model-picker.html:0:0",
			),
		).toBe(true);
	});

	test("does not suppress real renderer failures", () => {
		expect(isBenignWebviewErrorMessage("Cannot read properties of null")).toBe(
			false,
		);
		expect(
			isBenignWebviewErrorMessage(
				"onerror: Cannot read properties of null @ http://127.0.0.1:1420/windows/model-picker.html:10:20",
			),
		).toBe(false);
	});
});
