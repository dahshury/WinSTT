import { describe, expect, mock, test } from "bun:test";
import { electronMock } from "@test/mocks/electron";

let dialogResult: { canceled: boolean; filePaths: string[] } = {
	canceled: true,
	filePaths: [],
};
// Captures the options passed into showOpenDialog so the tests can pin down
// the exact `properties`, `title`, and `filters` shape the production code
// builds (mutator-killer for the L22 ObjectLiteral / ArrayDeclaration / "openFile" string mutants).
let lastShowOpenDialogOptions: Electron.OpenDialogOptions | null = null;
// Helper to read the captured options without tripping tsgo's control-flow
// narrowing (which collapses the variable to `never` after `... = null`
// assignments that precede async mock invocations).
const captured = (): Electron.OpenDialogOptions =>
	lastShowOpenDialogOptions as Electron.OpenDialogOptions;

// Spread `electronMock()` so the process-global mock leak this installs
// is semantically complete — partial shims (only `ipcMain` + `dialog`)
// would make every later test importing `app` / `BrowserWindow` / etc.
// from `electron` throw "Export named X not found". The default ipcMain
// already exposes `_handlers` so we can read captured handlers from it.
const base = electronMock();
const handlers = base.ipcMain._handlers;

mock.module("electron", () => ({
	...base,
	dialog: {
		...base.dialog,
		showOpenDialog: async (options: Electron.OpenDialogOptions) => {
			lastShowOpenDialogOptions = options;
			return dialogResult;
		},
	},
}));

const { setupDialogHandlers } = await import("./dialog");
setupDialogHandlers();

describe("setupDialogHandlers", () => {
	test("returns null when the user cancels", async () => {
		dialogResult = { canceled: true, filePaths: [] };
		const handler = handlers.get("dialog:open-file");
		expect(handler).toBeDefined();
		expect(await handler!(undefined, {})).toBeNull();
	});

	test("returns null when the file list is empty even if not canceled", async () => {
		dialogResult = { canceled: false, filePaths: [] };
		expect(await handlers.get("dialog:open-file")!(undefined, {})).toBeNull();
	});

	test("returns the first file path when the dialog returns one or more", async () => {
		dialogResult = { canceled: false, filePaths: ["C:\\foo.wav"] };
		expect(await handlers.get("dialog:open-file")!(undefined, {})).toBe("C:\\foo.wav");
	});

	test("accepts non-object options gracefully (defaults to safe values)", async () => {
		dialogResult = { canceled: false, filePaths: ["x.wav"] };
		expect(await handlers.get("dialog:open-file")!(undefined, null)).toBe("x.wav");
	});

	// ── Boundary-killers for the canceled branch and the `?? null` fallback ─
	// `if (result.canceled) return null;` then `return result.filePaths[0] ?? null;`.
	// We need three distinct shapes to demonstrate value:
	//   1. canceled=true (regardless of filePaths) → null (locks the if branch)
	//   2. canceled=false + filePaths=[] → null   (locks the `?? null` left side)
	//   3. canceled=false + filePaths=[x] → x     (locks the happy path)
	test("canceled=true with non-empty filePaths still returns null (canceled wins)", async () => {
		dialogResult = { canceled: true, filePaths: ["C:\\should-be-ignored.wav"] };
		expect(await handlers.get("dialog:open-file")!(undefined, {})).toBeNull();
	});

	test("canceled=false with non-empty filePaths returns the first path", async () => {
		dialogResult = { canceled: false, filePaths: ["primary.wav", "ignored.wav"] };
		expect(await handlers.get("dialog:open-file")!(undefined, {})).toBe("primary.wav");
	});

	// Specifically pins the `result.filePaths[0] ?? null` nullish-coalescing
	// fallback: when the dialog returns `canceled=false` but an empty array
	// (Electron does this on some platforms), the handler must coerce the
	// `undefined` at index 0 to `null` before crossing the IPC boundary.
	test("canceled=false with empty filePaths returns null via the ?? null fallback", async () => {
		dialogResult = { canceled: false, filePaths: [] };
		expect(await handlers.get("dialog:open-file")!(undefined, {})).toBeNull();
	});

	// ── Mutator-killers for the L22 properties array / object literal ────
	// `dialog.showOpenDialog({ title, filters, properties: ["openFile"] })`.
	// The L22 ArrayDeclaration mutant turns `["openFile"]` into `[]`,
	// the StringLiteral mutant turns `"openFile"` into `""`, and the
	// ObjectLiteral mutant turns the entire options object into `{}`.
	test("passes properties: ['openFile'] to showOpenDialog (locks in L22 array + 'openFile' literal)", async () => {
		dialogResult = { canceled: false, filePaths: ["x.wav"] };
		lastShowOpenDialogOptions = null;
		await handlers.get("dialog:open-file")!(undefined, {});
		expect(lastShowOpenDialogOptions).not.toBeNull();
		expect(captured().properties).toEqual(["openFile"]);
	});

	// ── Mutator-killers for the L15 default title literal ────────────────
	// `title: typeof safe.title === "string" ? safe.title : "Select File"`.
	// If the title literal is mutated to "" the production behavior breaks.
	test("uses 'Select File' as the default title when none provided (locks in L15 literal)", async () => {
		dialogResult = { canceled: false, filePaths: ["x.wav"] };
		lastShowOpenDialogOptions = null;
		await handlers.get("dialog:open-file")!(undefined, {});
		expect(captured().title).toBe("Select File");
	});

	test("uses provided title when it is a string (locks in the typeof === 'string' equality branch)", async () => {
		dialogResult = { canceled: false, filePaths: ["x.wav"] };
		lastShowOpenDialogOptions = null;
		await handlers.get("dialog:open-file")!(undefined, { title: "Pick an audio file" });
		expect(captured().title).toBe("Pick an audio file");
	});

	test("falls back to 'Select File' when title is a non-string (number)", async () => {
		dialogResult = { canceled: false, filePaths: ["x.wav"] };
		lastShowOpenDialogOptions = null;
		await handlers.get("dialog:open-file")!(undefined, { title: 42 });
		expect(captured().title).toBe("Select File");
	});

	// ── Mutator-killers for the L9 toSafeOptions function ────────────────
	// `options !== null && typeof options === "object" ? (options as ...) : {}`.
	// Pin down all three independent mutants: the `!== null` guard, the
	// `typeof === "object"` check, and the `"object"` literal.
	test("null options → empty safe object (no title, no filters; locks in the !== null guard)", async () => {
		dialogResult = { canceled: false, filePaths: ["x.wav"] };
		lastShowOpenDialogOptions = null;
		await handlers.get("dialog:open-file")!(undefined, null);
		expect(captured().title).toBe("Select File");
		expect(captured().filters).toBeUndefined();
	});

	test("string options → empty safe object (typeof === 'object' rejects strings)", async () => {
		dialogResult = { canceled: false, filePaths: ["x.wav"] };
		lastShowOpenDialogOptions = null;
		await handlers.get("dialog:open-file")!(undefined, "some-string");
		expect(captured().title).toBe("Select File");
		expect(captured().filters).toBeUndefined();
	});

	test("undefined options → empty safe object (typeof undefined !== 'object')", async () => {
		dialogResult = { canceled: false, filePaths: ["x.wav"] };
		lastShowOpenDialogOptions = null;
		await handlers.get("dialog:open-file")!(undefined, undefined);
		expect(captured().title).toBe("Select File");
		expect(captured().filters).toBeUndefined();
	});

	// ── Mutator-killers for the L15-16 filters branch ────────────────────
	// `filters: Array.isArray(safe.filters) ? safe.filters : undefined`.
	// Pass an array of filter specs and verify they round-trip; pass a
	// non-array (e.g. a string or object) and verify it becomes undefined.
	test("forwards a valid filters array verbatim (locks in Array.isArray happy path)", async () => {
		dialogResult = { canceled: false, filePaths: ["x.wav"] };
		lastShowOpenDialogOptions = null;
		const filters: Electron.FileFilter[] = [{ name: "Audio", extensions: ["wav", "mp3"] }];
		await handlers.get("dialog:open-file")!(undefined, { filters });
		expect(captured().filters).toEqual(filters);
	});

	test("non-array filters → undefined (locks in Array.isArray sad path)", async () => {
		dialogResult = { canceled: false, filePaths: ["x.wav"] };
		lastShowOpenDialogOptions = null;
		await handlers.get("dialog:open-file")!(undefined, { filters: "not-an-array" });
		expect(captured().filters).toBeUndefined();
	});

	test("missing filters key → undefined", async () => {
		dialogResult = { canceled: false, filePaths: ["x.wav"] };
		lastShowOpenDialogOptions = null;
		await handlers.get("dialog:open-file")!(undefined, { title: "Hello" });
		expect(captured().filters).toBeUndefined();
	});

	// ── Coverage for filePaths[0] explicit return ────────────────────────
	test("returns exactly the FIRST file path (not the second)", async () => {
		dialogResult = { canceled: false, filePaths: ["a.wav", "b.wav", "c.wav"] };
		expect(await handlers.get("dialog:open-file")!(undefined, {})).toBe("a.wav");
	});
});
