import { describe, expect, test } from "bun:test";
import { createUpdaterStatusHistory, type UpdaterStatusEntryInput } from "./updater-status-history";

describe("createUpdaterStatusHistory", () => {
	test("tracks status events with timestamps and keeps insertion order", () => {
		const history = createUpdaterStatusHistory({ maxEntries: 3, now: () => 1000 });
		history.record({ status: "checking" });
		history.record({ status: "available", version: "1.2.3" });

		expect(history.getHistory()).toEqual([
			{ status: "checking", timestamp: 1000 },
			{ status: "available", timestamp: 1000, version: "1.2.3" },
		]);
	});

	test("drops oldest entries when max capacity is reached", () => {
		let now = 1000;
		const history = createUpdaterStatusHistory({
			maxEntries: 2,
			now: () => {
				now += 1;
				return now;
			},
		});
		const entries: UpdaterStatusEntryInput[] = [
			{ status: "checking" },
			{ status: "not-available" },
			{ status: "downloaded", version: "2.0.0" },
		];

		for (const entry of entries) {
			history.record(entry);
		}

		expect(history.getHistory()).toEqual([
			{ status: "not-available", timestamp: 1002 },
			{ status: "downloaded", timestamp: 1003, version: "2.0.0" },
		]);
	});

	test("clear removes all entries", () => {
		const history = createUpdaterStatusHistory({ maxEntries: 5, now: () => 1 });
		history.record({ status: "checking" });
		history.clear();
		expect(history.getHistory()).toEqual([]);
	});

	test("includes the message field in the recorded entry when provided", () => {
		// Locks down the conditional spread `...(entry.message ? { message } : {})`.
		// Mutating `{ message: entry.message }` to `{}` would drop the field
		// silently — assert that getHistory()[0].message is exactly the input.
		const history = createUpdaterStatusHistory({ maxEntries: 3, now: () => 100 });
		const recorded = history.record({ status: "error", message: "boom" });
		expect(recorded.message).toBe("boom");
		const stored = history.getHistory()[0];
		expect(stored?.message).toBe("boom");
	});

	test("does not include a message field when message is omitted", () => {
		// Inverse direction — locks down that the conditional spread isn't
		// just unconditionally adding `message: undefined`.
		const history = createUpdaterStatusHistory({ maxEntries: 3, now: () => 200 });
		const recorded = history.record({ status: "checking" });
		expect(recorded.message).toBeUndefined();
		expect(Object.hasOwn(recorded, "message")).toBe(false);
	});

	test("preserves the only entry when capacity is not yet exceeded", () => {
		// Kills `if (entries.length > maxEntries)` -> `if (true)`. With a
		// single record + maxEntries=5, the splice block must NOT run, so the
		// just-pushed entry stays.
		const history = createUpdaterStatusHistory({ maxEntries: 5, now: () => 1 });
		history.record({ status: "checking" });
		const stored = history.getHistory();
		expect(stored).toHaveLength(1);
		expect(stored[0]?.status).toBe("checking");
	});

	test("includes both message and version fields when both are provided", () => {
		// Exercises the buildEntry helper through both conditional spreads in a
		// single call, locking down the case where both optional fields are
		// present together (and not just one or the other).
		const history = createUpdaterStatusHistory({ maxEntries: 3, now: () => 42 });
		const recorded = history.record({
			status: "error",
			message: "update failed",
			version: "9.9.9",
		});
		expect(recorded).toEqual({
			status: "error",
			timestamp: 42,
			version: "9.9.9",
			message: "update failed",
		});
	});

	test("preserves all entries when count is exactly equal to maxEntries (boundary)", () => {
		// Kills the EqualityOperator mutation `>` -> `>=`. With exactly
		// maxEntries records, `entries.length > maxEntries` is false (no
		// splice), but the mutant `entries.length >= maxEntries` would splice
		// — dropping the oldest. Asserting all 3 statuses are present catches
		// the off-by-one.
		const history = createUpdaterStatusHistory({ maxEntries: 3, now: () => 1 });
		history.record({ status: "checking" });
		history.record({ status: "available" });
		history.record({ status: "downloaded" });
		const stored = history.getHistory();
		expect(stored).toHaveLength(3);
		expect(stored.map((e) => e.status)).toEqual(["checking", "available", "downloaded"]);
	});
});
