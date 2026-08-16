import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { claimDefaultShortcutBinding } from "./reset-shortcut";

type TauriInternals = {
	invoke: (cmd: string, args?: unknown, options?: unknown) => Promise<unknown>;
};

const internals = () =>
	(window as unknown as { __TAURI_INTERNALS__: TauriInternals })
		.__TAURI_INTERNALS__;

let savedInvoke: TauriInternals["invoke"];

beforeEach(() => {
	savedInvoke = internals().invoke;
});

afterEach(() => {
	internals().invoke = savedInvoke;
});

describe("claimDefaultShortcutBinding", () => {
	test("claims the default through the native reset command", async () => {
		const calls: Array<{ args?: unknown; cmd: string }> = [];
		internals().invoke = (cmd, args) => {
			calls.push({ cmd, args });
			return Promise.resolve({ success: true, binding: null, error: null });
		};

		await claimDefaultShortcutBinding("repaste");

		expect(calls).toEqual([{ cmd: "reset_binding", args: { id: "repaste" } }]);
	});

	test("rejects when the native registry cannot claim the default", async () => {
		internals().invoke = () =>
			Promise.resolve({
				success: false,
				binding: null,
				error: "Default shortcut is already registered",
			});

		await expect(claimDefaultShortcutBinding("transcribe")).rejects.toThrow(
			"Default shortcut is already registered",
		);
	});

	test("rejects command-level failures", async () => {
		internals().invoke = () => Promise.reject("shortcut service unavailable");

		await expect(claimDefaultShortcutBinding("transforms")).rejects.toThrow(
			"shortcut service unavailable",
		);
	});
});
