import { describe, expect, test } from "bun:test";
import { useSwapNotifications } from "./swap-notifications-store";

function resetStore(): void {
	useSwapNotifications.setState({ current: null });
}

describe("useSwapNotifications.show", () => {
	test("populates current with an id + createdAt and preserves the payload", () => {
		resetStore();
		useSwapNotifications.getState().show({
			kind: "main",
			modelName: "onnx-community/whisper-base",
			reason: "Couldn't reach the model server.",
			category: "network",
			detail: "ConnectionError: dns lookup failed",
		});
		const current = useSwapNotifications.getState().current;
		expect(current).not.toBeNull();
		expect(current?.kind).toBe("main");
		expect(current?.modelName).toBe("onnx-community/whisper-base");
		expect(current?.category).toBe("network");
		expect(current?.reason).toContain("Couldn't reach");
		expect(current?.detail).toContain("ConnectionError");
		// id + createdAt are stamped on by the store.
		expect(typeof current?.id).toBe("string");
		expect(typeof current?.createdAt).toBe("number");
	});

	test("newer events overwrite older ones (no queueing)", () => {
		resetStore();
		const s = useSwapNotifications.getState();
		s.show({
			kind: "main",
			modelName: "whisper-base",
			reason: "first",
			category: "network",
			detail: "",
		});
		const firstId = useSwapNotifications.getState().current?.id;
		s.show({
			kind: "realtime",
			modelName: "whisper-tiny",
			reason: "second",
			category: "model_not_found",
			detail: "",
		});
		const c = useSwapNotifications.getState().current;
		expect(c?.kind).toBe("realtime");
		expect(c?.reason).toBe("second");
		// Different stamped id confirms it's a fresh entry, not a merge.
		expect(c?.id).not.toBe(firstId);
	});
});

describe("useSwapNotifications.clear", () => {
	test("clears current to null", () => {
		resetStore();
		useSwapNotifications.getState().show({
			kind: "main",
			modelName: "whisper-base",
			reason: "boom",
			category: "unknown",
			detail: "",
		});
		expect(useSwapNotifications.getState().current).not.toBeNull();
		useSwapNotifications.getState().clear();
		expect(useSwapNotifications.getState().current).toBeNull();
	});
});
