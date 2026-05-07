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
});
