import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { ipcClientMock } from "@test/mocks/ipc-client";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { LlmWarmupStatus } from "@/shared/api/ipc-client";

// This suite controls the two ipc-client exports the hook uses DIRECTLY:
//  - getLlmWarmupStatus(): the on-mount snapshot pull. We need to return a
//    rejecting promise to exercise the `.catch()` branch, which the real
//    `invokeOrDefault` would otherwise swallow into a `null` resolve.
//  - onLlmWarmupStatus(cb): the live broadcast subscription. We capture the
//    callback + return a spy unsubscriber to assert cleanup on unmount.
// We spread the complete faithful fake first so the leaked module stays
// semantically complete for sibling suites, then override only these two.
let snapshotImpl: () => Promise<LlmWarmupStatus | null> = async () => null;
let warmupCb: ((status: LlmWarmupStatus | null) => void) | null = null;
let unsubscribeCalls = 0;

const getLlmWarmupStatusSpy = (): Promise<LlmWarmupStatus | null> =>
	snapshotImpl();
const onLlmWarmupStatusSpy = (
	cb: (status: LlmWarmupStatus | null) => void,
): (() => void) => {
	warmupCb = cb;
	return () => {
		unsubscribeCalls += 1;
		warmupCb = null;
	};
};

mock.module("@/shared/api/ipc-client", () => ({
	...ipcClientMock(),
	getLlmWarmupStatus: getLlmWarmupStatusSpy,
	onLlmWarmupStatus: onLlmWarmupStatusSpy,
}));

const { useWarmupStatusStore } = await import("../model/warmup-status-store");
const { useWarmupStatusFeed } = await import("./use-warmup-status-feed");

const INITIAL_STATE = useWarmupStatusStore.getInitialState();

function makeStatus(overrides: Partial<LlmWarmupStatus> = {}): LlmWarmupStatus {
	return {
		endpoint: "http://127.0.0.1:11434",
		inProgress: false,
		models: [],
		ollamaInstalled: true,
		reachable: true,
		timestamp: 1_700_000_000_000,
		...overrides,
	};
}

beforeEach(() => {
	snapshotImpl = async () => null;
	warmupCb = null;
	unsubscribeCalls = 0;
	useWarmupStatusStore.setState({ status: INITIAL_STATE.status });
});

afterEach(() => {
	useWarmupStatusStore.setState({ status: INITIAL_STATE.status });
	warmupCb = null;
});

describe("useWarmupStatusFeed", () => {
	test("subscribes to the live warmup-status broadcast on mount", () => {
		renderHook(() => useWarmupStatusFeed());
		expect(warmupCb).not.toBeNull();
	});

	test("applies a non-null on-mount snapshot to the store", async () => {
		const snap = makeStatus({ endpoint: "http://mounted-snapshot" });
		snapshotImpl = async () => snap;
		renderHook(() => useWarmupStatusFeed());
		await waitFor(() => {
			expect(useWarmupStatusStore.getState().status?.endpoint).toBe(
				"http://mounted-snapshot",
			);
		});
	});

	test("clears stale store status when the on-mount snapshot resolves null", async () => {
		// A cleared backend snapshot means no Ollama feature is active. Apply
		// the null so a remounted settings window cannot keep an old banner.
		useWarmupStatusStore.setState({
			status: makeStatus({ endpoint: "stale-before-mount" }),
		});
		snapshotImpl = async () => null;
		renderHook(() => useWarmupStatusFeed());
		// Give the snapshot promise a chance to resolve.
		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
		});
		expect(useWarmupStatusStore.getState().status).toBeNull();
	});

	test("swallows a rejected snapshot pull without throwing or mutating the store", async () => {
		snapshotImpl = () => Promise.reject(new Error("ipc unavailable"));
		// Pre-seed a known value so we can assert the rejection path left it alone.
		const seeded = makeStatus({ endpoint: "pre-seeded" });
		useWarmupStatusStore.setState({ status: seeded });
		expect(() => renderHook(() => useWarmupStatusFeed())).not.toThrow();
		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
		});
		// The .catch(() => undefined) swallowed the error; the store is untouched.
		expect(useWarmupStatusStore.getState().status).toEqual(seeded);
	});

	test("live broadcasts flow into the store after mount", () => {
		renderHook(() => useWarmupStatusFeed());
		const broadcast = makeStatus({ inProgress: true, endpoint: "live" });
		act(() => warmupCb?.(broadcast));
		expect(useWarmupStatusStore.getState().status?.endpoint).toBe("live");
		expect(useWarmupStatusStore.getState().status?.inProgress).toBe(true);
	});

	test("a null live broadcast clears the store status", () => {
		useWarmupStatusStore.setState({ status: makeStatus() });
		renderHook(() => useWarmupStatusFeed());
		act(() => warmupCb?.(null));
		expect(useWarmupStatusStore.getState().status).toBeNull();
	});

	test("unsubscribes from the broadcast on unmount (no listener leak)", () => {
		const { unmount } = renderHook(() => useWarmupStatusFeed());
		expect(warmupCb).not.toBeNull();
		unmount();
		expect(unsubscribeCalls).toBe(1);
		expect(warmupCb).toBeNull();
	});

	test("the snapshot pull does not clobber a live broadcast that arrived first", async () => {
		// Snapshot resolves late; a live broadcast lands before it. The hook
		// should still apply the (later-resolving) snapshot since both call
		// setStatus — this documents the last-writer-wins ordering.
		let resolveSnap: (v: LlmWarmupStatus | null) => void = () => undefined;
		snapshotImpl = () =>
			new Promise<LlmWarmupStatus | null>((resolve) => {
				resolveSnap = resolve;
			});
		renderHook(() => useWarmupStatusFeed());
		act(() => warmupCb?.(makeStatus({ endpoint: "live-first" })));
		expect(useWarmupStatusStore.getState().status?.endpoint).toBe("live-first");
		await act(async () => {
			resolveSnap(makeStatus({ endpoint: "snapshot-late" }));
			await Promise.resolve();
		});
		expect(useWarmupStatusStore.getState().status?.endpoint).toBe(
			"snapshot-late",
		);
	});
});
