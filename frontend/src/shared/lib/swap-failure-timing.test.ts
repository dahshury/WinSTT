import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	_resetSwapFailureTimingForTests,
	markSwapFailed,
	recentSwapFailedAt,
} from "./swap-failure-timing";

describe("swap-failure-timing", () => {
	const realNow = Date.now;

	beforeEach(() => {
		_resetSwapFailureTimingForTests();
	});

	afterEach(() => {
		Date.now = realNow;
		_resetSwapFailureTimingForTests();
	});

	test("starts at 0 — no recent failure before any swap fails", () => {
		expect(recentSwapFailedAt()).toBe(0);
	});

	test("markSwapFailed stamps the current Date.now()", () => {
		Date.now = () => 2_222_222;
		markSwapFailed();
		expect(recentSwapFailedAt()).toBe(2_222_222);
	});

	test("each failure overwrites the previous timestamp (latest wins)", () => {
		Date.now = () => 100;
		markSwapFailed();
		expect(recentSwapFailedAt()).toBe(100);

		Date.now = () => 900;
		markSwapFailed();
		expect(recentSwapFailedAt()).toBe(900);
	});

	test("recentSwapFailedAt is a pure read — does not mutate the stamp", () => {
		Date.now = () => 7;
		markSwapFailed();
		expect(recentSwapFailedAt()).toBe(7);
		expect(recentSwapFailedAt()).toBe(7);
	});

	test("guard window arithmetic: a rollback transition right after a failure is suppressible", () => {
		Date.now = () => 50_000;
		markSwapFailed();
		// Consumer logic suppresses the implicit beginSwap when the transition
		// arrives within the guard window of the last failure.
		Date.now = () => 50_200; // +200ms → rollback, suppress
		expect(Date.now() - recentSwapFailedAt()).toBeLessThan(500);
		Date.now = () => 51_000; // +1000ms → genuine cross-window user pick
		expect(Date.now() - recentSwapFailedAt()).toBeGreaterThanOrEqual(500);
	});

	test("_resetSwapFailureTimingForTests clears the stamp back to 0", () => {
		Date.now = () => 88_888;
		markSwapFailed();
		expect(recentSwapFailedAt()).toBe(88_888);
		_resetSwapFailureTimingForTests();
		expect(recentSwapFailedAt()).toBe(0);
	});

	test("the two timing modules keep independent module-level state", async () => {
		// Regression guard: swap-failure and ipc-load timestamps must not share
		// the same `let`, or one's mark would clobber the other's guard.
		const { markIpcLoadResolved, recentIpcLoadAt, _resetIpcLoadTimingForTests } = await import(
			"./ipc-load-timing"
		);
		_resetIpcLoadTimingForTests();
		Date.now = () => 1000;
		markSwapFailed();
		Date.now = () => 2000;
		markIpcLoadResolved();
		expect(recentSwapFailedAt()).toBe(1000);
		expect(recentIpcLoadAt()).toBe(2000);
		_resetIpcLoadTimingForTests();
	});
});
