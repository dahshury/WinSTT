import { describe, expect, test } from "bun:test";
import type { WindowContextSnapshot } from "../lib/context-snapshot";
import { createContextCapture } from "./relay-context-capture";

const SNAP: WindowContextSnapshot = {
	windowTitle: "Editor",
	elementName: "Body",
	focusedText: "Dear Dr. Aljarbou,",
};

const NO_DENY: () => readonly string[] = () => [];

describe("createContextCapture", () => {
	test("consume returns '' when feature is disabled (no read performed)", async () => {
		let readCalls = 0;
		const cap = createContextCapture({
			isEnabled: () => false,
			getDenyList: NO_DENY,
			read: async () => {
				readCalls += 1;
				return SNAP;
			},
		});
		cap.capture();
		const out = await cap.consume();
		expect(out).toBe("");
		expect(readCalls).toBe(0);
	});

	test("consume returns formatted context after capture when enabled", async () => {
		const cap = createContextCapture({
			isEnabled: () => true,
			getDenyList: NO_DENY,
			read: async () => SNAP,
		});
		cap.capture();
		const out = await cap.consume();
		expect(out).toContain("Window: Editor");
		expect(out).toContain("Focused field: Body");
		expect(out).toContain("Dear Dr. Aljarbou,");
	});

	test("consume returns '' when capture was never called", async () => {
		const cap = createContextCapture({
			isEnabled: () => true,
			getDenyList: NO_DENY,
			read: async () => SNAP,
		});
		const out = await cap.consume();
		expect(out).toBe("");
	});

	test("consume drains state — subsequent consume returns ''", async () => {
		const cap = createContextCapture({
			isEnabled: () => true,
			getDenyList: NO_DENY,
			read: async () => SNAP,
		});
		cap.capture();
		expect(await cap.consume()).not.toBe("");
		expect(await cap.consume()).toBe("");
	});

	test("a second capture overwrites the first", async () => {
		const readouts = [
			{ windowTitle: "First", elementName: "", focusedText: "" },
			{ windowTitle: "Second", elementName: "", focusedText: "" },
		];
		let idx = 0;
		const cap = createContextCapture({
			isEnabled: () => true,
			getDenyList: NO_DENY,
			read: async () => readouts[idx++] as WindowContextSnapshot,
		});
		cap.capture();
		cap.capture();
		const out = await cap.consume();
		expect(out).toContain("Window: Second");
	});

	test("clear discards a pending snapshot", async () => {
		const cap = createContextCapture({
			isEnabled: () => true,
			getDenyList: NO_DENY,
			read: async () => SNAP,
		});
		cap.capture();
		cap.clear();
		expect(await cap.consume()).toBe("");
	});

	test("a rejected read resolves to empty context (never throws)", async () => {
		const cap = createContextCapture({
			isEnabled: () => true,
			getDenyList: NO_DENY,
			read: () => Promise.reject(new Error("UIA died")),
		});
		cap.capture();
		expect(await cap.consume()).toBe("");
	});

	test("deny-list strips axHtml/url/focusedText but keeps window title", async () => {
		const richSnap: WindowContextSnapshot = {
			windowTitle: "1Password — Vault",
			elementName: "Master password",
			focusedText: "supersecret",
			appExe: "1password.exe",
			axHtml: "<window><edit>supersecret</edit></window>",
			url: "",
		};
		const cap = createContextCapture({
			isEnabled: () => true,
			getDenyList: () => ["1password.exe"],
			read: async () => richSnap,
		});
		cap.capture();
		const out = await cap.consume();
		expect(out).toContain("Window: 1Password — Vault");
		expect(out).not.toContain("supersecret");
		expect(out).not.toContain("<edit>");
		expect(out).not.toContain("App: 1password.exe");
	});

	test("deny-list passes through when app is not listed", async () => {
		const richSnap: WindowContextSnapshot = {
			windowTitle: "Gmail — Inbox",
			elementName: "Reply body",
			focusedText: "",
			appExe: "chrome.exe",
			url: "mail.google.com",
		};
		const cap = createContextCapture({
			isEnabled: () => true,
			getDenyList: () => ["1password.exe", "bankofamerica.com"],
			read: async () => richSnap,
		});
		cap.capture();
		const out = await cap.consume();
		expect(out).toContain("App: chrome.exe");
		expect(out).toContain("URL: mail.google.com");
	});

	test("deny-list URL host-suffix match strips sensitive fields", async () => {
		const richSnap: WindowContextSnapshot = {
			windowTitle: "Bank of America",
			elementName: "Account number",
			focusedText: "1234-5678-9012",
			appExe: "chrome.exe",
			url: "secure.bankofamerica.com/login",
			axHtml: "<edit>1234-5678-9012</edit>",
		};
		const cap = createContextCapture({
			isEnabled: () => true,
			getDenyList: () => ["bankofamerica.com"],
			read: async () => richSnap,
		});
		cap.capture();
		const out = await cap.consume();
		expect(out).not.toContain("1234-5678-9012");
		expect(out).not.toContain("URL: secure.bankofamerica.com");
	});
});

describe("createContextCapture — onSnapshotReady / onSnapshotCleared", () => {
	test("onSnapshotReady fires once with the post-filter snapshot after capture resolves", async () => {
		const seen: WindowContextSnapshot[] = [];
		const cap = createContextCapture({
			isEnabled: () => true,
			getDenyList: NO_DENY,
			read: async () => ({ ...SNAP, textBefore: "Hi Bob," }),
			onSnapshotReady: (s) => {
				seen.push(s);
			},
		});
		cap.capture();
		// Wait one microtask cycle for the .then() chain to run.
		await Promise.resolve();
		await Promise.resolve();
		expect(seen).toHaveLength(1);
		expect(seen[0]?.textBefore).toBe("Hi Bob,");
	});

	test("onSnapshotReady receives the redacted snapshot when the app is denied", async () => {
		const seen: WindowContextSnapshot[] = [];
		const cap = createContextCapture({
			isEnabled: () => true,
			getDenyList: () => ["1password.exe"],
			read: async () => ({
				windowTitle: "1Password",
				elementName: "Master",
				focusedText: "supersecret",
				appExe: "1password.exe",
				textBefore: "supersecret",
			}),
			onSnapshotReady: (s) => {
				seen.push(s);
			},
		});
		cap.capture();
		await Promise.resolve();
		await Promise.resolve();
		expect(seen).toHaveLength(1);
		expect(seen[0]?.textBefore).toBeUndefined();
		expect(seen[0]?.focusedText).toBe("");
	});

	test("consume() fires onSnapshotCleared so ASR-side bias is dropped", async () => {
		let cleared = 0;
		const cap = createContextCapture({
			isEnabled: () => true,
			getDenyList: NO_DENY,
			read: async () => SNAP,
			onSnapshotCleared: () => {
				cleared += 1;
			},
		});
		cap.capture();
		await cap.consume();
		expect(cleared).toBe(1);
	});

	test("clear() fires onSnapshotCleared when there's pending state", async () => {
		let cleared = 0;
		const cap = createContextCapture({
			isEnabled: () => true,
			getDenyList: NO_DENY,
			read: async () => SNAP,
			onSnapshotCleared: () => {
				cleared += 1;
			},
		});
		cap.capture();
		cap.clear();
		expect(cleared).toBe(1);
	});

	test("clear() with no pending state does NOT fire onSnapshotCleared", () => {
		let cleared = 0;
		const cap = createContextCapture({
			isEnabled: () => true,
			getDenyList: NO_DENY,
			read: async () => SNAP,
			onSnapshotCleared: () => {
				cleared += 1;
			},
		});
		cap.clear();
		expect(cleared).toBe(0);
	});

	test("disabled capture clears stale state and fires onSnapshotCleared once", async () => {
		let cleared = 0;
		let enabled = true;
		const cap = createContextCapture({
			isEnabled: () => enabled,
			getDenyList: NO_DENY,
			read: async () => SNAP,
			onSnapshotCleared: () => {
				cleared += 1;
			},
		});
		cap.capture();
		enabled = false;
		cap.capture(); // setting flipped → should drop state
		expect(cleared).toBe(1);
	});

	test("stale onSnapshotReady firings (race lost to a second capture) are suppressed", async () => {
		// Two reads in flight: the first resolves AFTER the second is already
		// the live snapshot. The first's onSnapshotReady must not fire.
		let resolveFirst: (snap: WindowContextSnapshot) => void = () => {
			// no-op; set inside the first read's executor
		};
		const firstRead = new Promise<WindowContextSnapshot>((resolve) => {
			resolveFirst = resolve;
		});
		const reads: Array<() => Promise<WindowContextSnapshot>> = [
			() => firstRead,
			async () => ({ ...SNAP, textBefore: "winner" }),
		];
		const seen: WindowContextSnapshot[] = [];
		const cap = createContextCapture({
			isEnabled: () => true,
			getDenyList: NO_DENY,
			read: () => (reads.shift() ?? (() => Promise.resolve(SNAP)))(),
			onSnapshotReady: (s) => {
				seen.push(s);
			},
		});
		cap.capture(); // kicks off firstRead — stays pending
		cap.capture(); // kicks off the second; replaces `pending`
		// Let the second read resolve.
		await Promise.resolve();
		await Promise.resolve();
		expect(seen.map((s) => s.textBefore)).toEqual(["winner"]);
		// Now let the first resolve — its handler should see the identity
		// check fail and drop the snapshot.
		resolveFirst({ ...SNAP, textBefore: "loser" });
		await Promise.resolve();
		await Promise.resolve();
		expect(seen.map((s) => s.textBefore)).toEqual(["winner"]);
	});

	test("onSnapshotReady does NOT fire when isEnabled() is false", async () => {
		let fired = 0;
		const cap = createContextCapture({
			isEnabled: () => false,
			getDenyList: NO_DENY,
			read: async () => SNAP,
			onSnapshotReady: () => {
				fired += 1;
			},
		});
		cap.capture();
		await Promise.resolve();
		await Promise.resolve();
		expect(fired).toBe(0);
	});
});
