import { afterEach, describe, expect, mock, test } from "bun:test";
import { fireAndForget } from "./fire-and-forget";

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("fireAndForget", () => {
	afterEach(() => {
		mock.restore();
	});

	test("returns void synchronously", () => {
		const result = fireAndForget(Promise.resolve());
		expect(result).toBeUndefined();
	});

	test("swallows a rejection (no unhandled rejection escapes)", async () => {
		// A bare `await Promise.reject(...)` here would fail the test; routing it
		// through `fireAndForget` must absorb the rejection so nothing throws and
		// the microtask queue drains cleanly.
		fireAndForget(Promise.reject(new Error("boom")));
		fireAndForget(Promise.reject(new Error("boom")), "labelled");
		await flush();
		expect(true).toBe(true);
	});

	test("does not disturb a resolving promise's own continuation", async () => {
		let observed = 0;
		const p = Promise.resolve(42).then((v) => {
			observed = v;
		});
		fireAndForget(p);
		await flush();
		expect(observed).toBe(42);
	});

	test("never logs in production builds (DEV is falsy)", async () => {
		// `import.meta.env.DEV` is not true in the bun:test environment, so the
		// dev-only diagnostic branch stays silent — mirroring a production build.
		const warn = mock(() => undefined);
		const originalWarn = console.warn;
		console.warn = warn;
		try {
			fireAndForget(Promise.reject(new Error("silent")), "ctx");
			await flush();
			expect(warn).not.toHaveBeenCalled();
		} finally {
			console.warn = originalWarn;
		}
	});
});
