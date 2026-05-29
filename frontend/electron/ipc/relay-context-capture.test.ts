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

	test("disabled capture with NO prior state is a pure no-op (no read, no cleared)", async () => {
		// Exercises the `!isEnabled() && pending === null` early-return arm:
		// neither read() nor onSnapshotCleared() should fire.
		let readCalls = 0;
		let cleared = 0;
		const cap = createContextCapture({
			isEnabled: () => false,
			getDenyList: NO_DENY,
			read: async () => {
				readCalls += 1;
				return SNAP;
			},
			onSnapshotCleared: () => {
				cleared += 1;
			},
		});
		cap.capture();
		await Promise.resolve();
		expect(readCalls).toBe(0);
		expect(cleared).toBe(0);
		expect(await cap.consume()).toBe("");
	});

	test("undefined onSnapshotReady is tolerated (optional callback no-op)", async () => {
		// No onSnapshotReady provided: the `?.` arm must not throw when the
		// read resolves. consume() still yields the formatted snapshot.
		const cap = createContextCapture({
			isEnabled: () => true,
			getDenyList: NO_DENY,
			read: async () => SNAP,
		});
		cap.capture();
		await Promise.resolve();
		await Promise.resolve();
		expect(await cap.consume()).toContain("Window: Editor");
	});

	test("a throwing onSnapshotReady consumer does NOT escape as an unhandled rejection", async () => {
		// Regression: the side channel (`myPending.then(success)`) is
		// fire-and-forget. A consumer that throws used to reject the chained
		// promise with nothing observing it → unhandled rejection. The fix
		// wraps the consumer in try/catch and routes the throw to
		// onConsumerError. We assert (a) capture() never throws synchronously,
		// (b) onConsumerError sees the thrown error, and (c) no unhandled
		// rejection is raised on the process during the microtask drain.
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown): void => {
			unhandled.push(reason);
		};
		process.on("unhandledRejection", onUnhandled);
		const seenErrors: unknown[] = [];
		const boom = new Error("downstream consumer blew up");
		try {
			const cap = createContextCapture({
				isEnabled: () => true,
				getDenyList: NO_DENY,
				read: async () => SNAP,
				onSnapshotReady: () => {
					throw boom;
				},
				onConsumerError: (err) => {
					seenErrors.push(err);
				},
			});
			expect(() => cap.capture()).not.toThrow();
			// Drain the .then() microtask chain.
			await Promise.resolve();
			await Promise.resolve();
			// Give the event loop a tick so any (incorrect) unhandled rejection
			// would have a chance to surface before we assert.
			await new Promise<void>((r) => setTimeout(r, 5));
			expect(seenErrors).toEqual([boom]);
			expect(unhandled).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	test("a throwing consumer with NO onConsumerError is swallowed (still no unhandled rejection)", async () => {
		// The onConsumerError?. falsy arm: a buggy consumer with no error hook
		// must still be swallowed — the capture lifecycle stays intact and the
		// next consume() returns the formatted snapshot normally.
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown): void => {
			unhandled.push(reason);
		};
		process.on("unhandledRejection", onUnhandled);
		try {
			const cap = createContextCapture({
				isEnabled: () => true,
				getDenyList: NO_DENY,
				read: async () => SNAP,
				onSnapshotReady: () => {
					throw new Error("consumer error, no hook");
				},
				// onConsumerError intentionally omitted.
			});
			expect(() => cap.capture()).not.toThrow();
			await Promise.resolve();
			await Promise.resolve();
			await new Promise<void>((r) => setTimeout(r, 5));
			expect(unhandled).toEqual([]);
			// consume() still works after the consumer threw.
			expect(await cap.consume()).toContain("Window: Editor");
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	test("onSnapshotReady fires unredacted when the app is NOT on the deny-list", async () => {
		// The non-denied arm of applyDenyList(): the snapshot passes through
		// untouched, so the optional Wispr-tier fields survive to the consumer.
		const seen: WindowContextSnapshot[] = [];
		const cap = createContextCapture({
			isEnabled: () => true,
			getDenyList: () => ["1password.exe"],
			read: async () => ({
				windowTitle: "Gmail",
				elementName: "Body",
				focusedText: "draft",
				appExe: "chrome.exe",
				textBefore: "Dear team,",
			}),
			onSnapshotReady: (s) => {
				seen.push(s);
			},
		});
		cap.capture();
		await Promise.resolve();
		await Promise.resolve();
		expect(seen).toHaveLength(1);
		expect(seen[0]?.appExe).toBe("chrome.exe");
		expect(seen[0]?.textBefore).toBe("Dear team,");
	});
});

describe("createContextCapture — consume-time deny-list & redaction", () => {
	test("deny-list edited live AFTER capture is honoured at consume-time", async () => {
		// The snapshot is captured while the app is allowed, then the user
		// adds it to the deny-list before consume(). consume() must apply the
		// (now-deny) list, stripping focusedText but keeping the window title.
		let denyList: readonly string[] = [];
		const cap = createContextCapture({
			isEnabled: () => true,
			getDenyList: () => denyList,
			read: async () => ({
				windowTitle: "Outlook",
				elementName: "Compose",
				focusedText: "private email body",
				appExe: "outlook.exe",
			}),
		});
		cap.capture();
		denyList = ["outlook.exe"]; // user edits the list mid-recording
		const out = await cap.consume();
		expect(out).toContain("Window: Outlook");
		expect(out).not.toContain("private email body");
		expect(out).not.toContain("App: outlook.exe");
	});

	test("consume() drops ocrText for a denied app (redaction whitelists only the triple)", async () => {
		const cap = createContextCapture({
			isEnabled: () => true,
			getDenyList: () => ["chrome.exe"],
			read: async () => ({
				windowTitle: "Secret Game",
				elementName: "Canvas",
				focusedText: "",
				appExe: "chrome.exe",
				ocrText: "TOP SECRET screen text",
			}),
		});
		cap.capture();
		const out = await cap.consume();
		expect(out).toContain("Window: Secret Game");
		expect(out).not.toContain("TOP SECRET screen text");
		expect(out).not.toContain("Screen text");
	});

	test("consume() after a rejected read still fires onSnapshotCleared exactly once", async () => {
		// The read rejects → EMPTY_CONTEXT. consume() of an empty snapshot
		// returns "" but MUST still drop the ASR-side bias (fireCleared).
		let cleared = 0;
		const cap = createContextCapture({
			isEnabled: () => true,
			getDenyList: NO_DENY,
			read: () => Promise.reject(new Error("helper crashed")),
			onSnapshotCleared: () => {
				cleared += 1;
			},
		});
		cap.capture();
		const out = await cap.consume();
		expect(out).toBe("");
		expect(cleared).toBe(1);
	});

	test("overwriting capture fires cleared exactly once per overwrite", async () => {
		// Two back-to-back captures while enabled: the second overwrites the
		// first and must fire onSnapshotCleared for the dropped lifecycle.
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
		cap.capture(); // overwrite → one cleared
		cap.capture(); // overwrite again → two cleared
		expect(cleared).toBe(2);
		// The surviving snapshot is still consumable (and clears a third time).
		expect(await cap.consume()).not.toBe("");
		expect(cleared).toBe(3);
	});

	test("undefined onSnapshotCleared is tolerated on overwrite (optional-chain no-op)", async () => {
		// fireCleared()'s `deps.onSnapshotCleared?.()` falsy arm: overwrite,
		// consume, and clear must all be safe no-ops without the callback.
		const cap = createContextCapture({
			isEnabled: () => true,
			getDenyList: NO_DENY,
			read: async () => SNAP,
			// onSnapshotCleared intentionally omitted.
		});
		cap.capture();
		cap.capture(); // overwrite → fireCleared with no callback, must not throw
		const out = await cap.consume(); // consume → fireCleared with no callback
		expect(out).toContain("Window: Editor");
		// clear() on the now-empty state is a no-op (no fireCleared).
		expect(() => cap.clear()).not.toThrow();
	});

	test("disabled overwrite with prior state + no onSnapshotCleared is a safe no-op", () => {
		// The disabled-capture branch that drops stale `pending` and calls
		// fireCleared() — but with the optional callback absent, so the
		// `?.()` falsy arm runs without throwing.
		let enabled = true;
		const cap = createContextCapture({
			isEnabled: () => enabled,
			getDenyList: NO_DENY,
			read: async () => SNAP,
			// onSnapshotCleared intentionally omitted.
		});
		cap.capture(); // arms pending
		enabled = false;
		expect(() => cap.capture()).not.toThrow(); // drops stale pending, fireCleared no-op
	});

	test("a rejecting read() routes through .catch (success arm), never the .then reject arm", async () => {
		// Locks the unreachable-reject-arm invariant. read() rejects, but it
		// is wrapped in `.catch(() => EMPTY_CONTEXT)` inside capture(), so
		// `myPending` RESOLVES to the empty context. The internal
		// `myPending.then(success, reject)` therefore runs its SUCCESS arm
		// (firing onSnapshotReady with the empty snapshot); the reject arm
		// (lines 116-119) is dead code that biome's noFloatingPromises forces
		// us to attach. This test proves onSnapshotReady still fires (success
		// arm) on a failed read — so the only way the reject arm could run is
		// removed by construction.
		const seen: WindowContextSnapshot[] = [];
		const cap = createContextCapture({
			isEnabled: () => true,
			getDenyList: NO_DENY,
			read: () => Promise.reject(new Error("UIA helper crashed")),
			onSnapshotReady: (s) => {
				seen.push(s);
			},
		});
		expect(() => cap.capture()).not.toThrow();
		await Promise.resolve();
		await Promise.resolve();
		// Success arm fired with the empty-context fallback (NOT the reject arm).
		expect(seen).toHaveLength(1);
		expect(seen[0]?.windowTitle).toBe("");
		expect(seen[0]?.elementName).toBe("");
		expect(seen[0]?.focusedText).toBe("");
		// consume() of the empty snapshot yields "".
		expect(await cap.consume()).toBe("");
	});

	test("onSnapshotReady fires the redacted branch of applyDenyList via the side channel", async () => {
		// applyDenyList()'s deny arm (complexity-2) exercised through the
		// onSnapshotReady side channel rather than consume(): a denied app's
		// sensitive fields are stripped before the callback sees them.
		const seen: WindowContextSnapshot[] = [];
		const cap = createContextCapture({
			isEnabled: () => true,
			getDenyList: () => ["secure.example.com"],
			read: async () => ({
				windowTitle: "Bank",
				elementName: "PIN",
				focusedText: "0000",
				appExe: "chrome.exe",
				url: "https://secure.example.com/account",
				axHtml: "<edit>0000</edit>",
			}),
			onSnapshotReady: (s) => {
				seen.push(s);
			},
		});
		cap.capture();
		await Promise.resolve();
		await Promise.resolve();
		expect(seen).toHaveLength(1);
		// Redacted: only the legacy triple survives, focusedText blanked.
		expect(seen[0]?.windowTitle).toBe("Bank");
		expect(seen[0]?.elementName).toBe("PIN");
		expect(seen[0]?.focusedText).toBe("");
		expect(seen[0]?.url).toBeUndefined();
		expect(seen[0]?.axHtml).toBeUndefined();
	});

	test("clear() after consume() is a no-op (pending already drained)", async () => {
		// clear()'s `pending === null` early-return arm: once consume() has
		// drained the snapshot, a follow-up clear() must not re-fire cleared.
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
		await cap.consume(); // fireCleared #1
		expect(cleared).toBe(1);
		cap.clear(); // pending === null → early return, no fireCleared
		expect(cleared).toBe(1);
	});
});
