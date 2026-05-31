import { describe, expect, test } from "bun:test";
import { createSerialQueue } from "./serial-queue";

describe("createSerialQueue", () => {
	test("runs tasks in FIFO insertion order even when their durations vary", async () => {
		const log: string[] = [];
		const q = createSerialQueue();

		// Task A is slower than task B. Without serialization, B would finish
		// first; with serialization the queue waits for A before starting B.
		q.enqueue(async () => {
			await new Promise<void>((r) => setTimeout(r, 30));
			log.push("a");
		});
		q.enqueue(async () => {
			await new Promise<void>((r) => setTimeout(r, 5));
			log.push("b");
		});
		q.enqueue(async () => {
			log.push("c");
		});

		// Wait long enough for everything to drain
		await new Promise<void>((r) => setTimeout(r, 100));

		expect(log).toEqual(["a", "b", "c"]);
	});

	test("a thrown error in one task does not break subsequent tasks", async () => {
		const log: string[] = [];
		const q = createSerialQueue();

		q.enqueue(async () => {
			log.push("before");
		});
		q.enqueue(async () => {
			throw new Error("boom");
		});
		q.enqueue(async () => {
			log.push("after");
		});

		await new Promise<void>((r) => setTimeout(r, 50));
		expect(log).toEqual(["before", "after"]);
	});

	test("synchronous tasks run in order without leaking through to next tick", async () => {
		const log: string[] = [];
		const q = createSerialQueue();
		q.enqueue(() => {
			log.push("a");
		});
		q.enqueue(() => {
			log.push("b");
		});
		q.enqueue(() => {
			log.push("c");
		});
		await new Promise<void>((r) => setTimeout(r, 0));
		expect(log).toEqual(["a", "b", "c"]);
	});

	test("depth() reflects queued + running tasks", async () => {
		const q = createSerialQueue();
		expect(q.depth()).toBe(0);
		const release: Array<() => void> = [];
		q.enqueue(() => new Promise<void>((r) => release.push(r)));
		q.enqueue(() => new Promise<void>((r) => release.push(r)));
		q.enqueue(() => new Promise<void>((r) => release.push(r)));
		// Increment is synchronous on enqueue.
		expect(q.depth()).toBe(3);

		// Wait for the first task to actually start running so its resolver
		// is in `release[0]`. The others are still chained behind.
		await new Promise<void>((r) => setTimeout(r, 5));
		expect(release.length).toBe(1);
		release[0]?.();

		// Drain past the first task into the second.
		await new Promise<void>((r) => setTimeout(r, 5));
		expect(q.depth()).toBe(2);
		expect(release.length).toBe(2);

		release[1]?.();
		await new Promise<void>((r) => setTimeout(r, 5));
		expect(q.depth()).toBe(1);

		release[2]?.();
		await new Promise<void>((r) => setTimeout(r, 5));
		expect(q.depth()).toBe(0);
	});

	test("rapid enqueue with mixed sync/async still preserves order", async () => {
		const log: string[] = [];
		const q = createSerialQueue();
		// 10 alternating sync/async — simulates rapid PTT where some
		// utterances hit a fast LLM (or no LLM) and some hit a slow one.
		for (let i = 0; i < 10; i++) {
			const value = `n${i}`;
			if (i % 2 === 0) {
				q.enqueue(async () => {
					await new Promise<void>((r) => setTimeout(r, 5));
					log.push(value);
				});
			} else {
				q.enqueue(() => {
					log.push(value);
				});
			}
		}
		await new Promise<void>((r) => setTimeout(r, 200));
		expect(log).toEqual(["n0", "n1", "n2", "n3", "n4", "n5", "n6", "n7", "n8", "n9"]);
	});
});
