import { describe, expect, mock, test } from "bun:test";
import { createSafeSender, isRecord } from "./ipc-helpers";

describe("isRecord", () => {
	test("returns true for plain objects", () => {
		expect(isRecord({})).toBe(true);
		expect(isRecord({ a: 1 })).toBe(true);
	});

	test("returns true for class instances and arrays (object-typed)", () => {
		expect(isRecord([])).toBe(true);
		expect(isRecord(new Date())).toBe(true);
	});

	test("returns false for null", () => {
		expect(isRecord(null)).toBe(false);
	});

	test("returns false for primitives", () => {
		expect(isRecord(undefined)).toBe(false);
		expect(isRecord(42)).toBe(false);
		expect(isRecord("x")).toBe(false);
		expect(isRecord(true)).toBe(false);
	});
});

interface MockBrowserWindow {
	isDestroyed: () => boolean;
	webContents: {
		send: ReturnType<typeof mock>;
	};
}

function makeWindow(opts: { destroyed: boolean } = { destroyed: false }): MockBrowserWindow {
	return {
		isDestroyed: () => opts.destroyed,
		webContents: { send: mock(() => undefined) },
	};
}

// MockBrowserWindow implements only the BrowserWindow surface createSafeSender
// reads (isDestroyed / webContents.send). The single boundary cast lives here
// instead of being repeated at every call site — the runtime object is unchanged.
const asWindow = (w: MockBrowserWindow) => w as unknown as Parameters<typeof createSafeSender>[0];

describe("createSafeSender", () => {
	test("forwards channel and args to webContents.send when window is alive", () => {
		const win = makeWindow();
		const send = createSafeSender(asWindow(win));
		send("ch", 1, "two", { a: 3 });
		expect(win.webContents.send).toHaveBeenCalledWith("ch", 1, "two", { a: 3 });
	});

	test("does not invoke send when window is destroyed", () => {
		const win = makeWindow({ destroyed: true });
		const send = createSafeSender(asWindow(win));
		send("ch", 1);
		expect(win.webContents.send).not.toHaveBeenCalled();
	});

	test("each call checks isDestroyed afresh", () => {
		const states = [false, false, true];
		let i = 0;
		const win: MockBrowserWindow = {
			isDestroyed: () => {
				const v = states[i] ?? true;
				i += 1;
				return v;
			},
			webContents: { send: mock(() => undefined) },
		};
		const send = createSafeSender(asWindow(win));
		send("a");
		send("b");
		send("c"); // window destroyed → should not send
		expect(win.webContents.send).toHaveBeenCalledTimes(2);
	});
});
