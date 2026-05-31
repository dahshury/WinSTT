import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	_resetIpcLoadTimingForTests,
	markIpcLoadResolved,
	recentIpcLoadAt,
} from "./ipc-load-timing";

describe("ipc-load-timing", () => {
	const realNow = Date.now;

	beforeEach(() => {
		_resetIpcLoadTimingForTests();
	});

	afterEach(() => {
		Date.now = realNow;
		_resetIpcLoadTimingForTests();
	});

	test("starts at 0 — no recent IPC load before any resolution", () => {
		expect(recentIpcLoadAt()).toBe(0);
	});

	test("markIpcLoadResolved stamps the current Date.now()", () => {
		Date.now = () => 1_234_567;
		markIpcLoadResolved();
		expect(recentIpcLoadAt()).toBe(1_234_567);
	});

	test("each mark overwrites the previous timestamp (latest wins)", () => {
		Date.now = () => 1000;
		markIpcLoadResolved();
		expect(recentIpcLoadAt()).toBe(1000);

		Date.now = () => 5000;
		markIpcLoadResolved();
		expect(recentIpcLoadAt()).toBe(5000);
	});

	test("recentIpcLoadAt is a pure read — repeated calls return the same value without advancing", () => {
		Date.now = () => 42;
		markIpcLoadResolved();
		expect(recentIpcLoadAt()).toBe(42);
		expect(recentIpcLoadAt()).toBe(42);
	});

	test("the 500ms guard window arithmetic: a read within 500ms of mark is 'recent'", () => {
		Date.now = () => 10_000;
		markIpcLoadResolved();
		// Consumer logic is `Date.now() - recentIpcLoadAt() < 500`.
		Date.now = () => 10_400; // +400ms → still inside guard
		expect(Date.now() - recentIpcLoadAt()).toBeLessThan(500);
		Date.now = () => 10_600; // +600ms → outside guard, real user pick
		expect(Date.now() - recentIpcLoadAt()).toBeGreaterThanOrEqual(500);
	});

	test("_resetIpcLoadTimingForTests clears the stamp back to 0", () => {
		Date.now = () => 99_999;
		markIpcLoadResolved();
		expect(recentIpcLoadAt()).toBe(99_999);
		_resetIpcLoadTimingForTests();
		expect(recentIpcLoadAt()).toBe(0);
	});
});
