import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
// Capture the factory's initial state at module-load time, BEFORE any test
// runs setState(), so the snapshot reflects the source literals.
import { useTransformNotifications } from "./transform-notifications-store";

const INITIAL_STATE = useTransformNotifications.getInitialState();

beforeEach(() => {
	useTransformNotifications.setState({ current: null });
});

afterEach(() => {
	// Restore Date.now if a test spied on it.
	(Date.now as { mockRestore?: () => void }).mockRestore?.();
});

describe("useTransformNotifications", () => {
	test("initial state has no current notification", () => {
		expect(useTransformNotifications.getState().current).toBeNull();
	});

	test("factory initial-state literal is null (mutation guard)", () => {
		// Transient store; holds at most one entry. Cold start shows nothing.
		expect(INITIAL_STATE.current).toBeNull();
	});

	test("show stamps createdAt + a generated id and preserves the passed fields", () => {
		spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
		useTransformNotifications.getState().show({
			kind: "applied",
			before: "hello",
			after: "Hello.",
		});
		const current = useTransformNotifications.getState().current;
		expect(current).not.toBeNull();
		expect(current?.kind).toBe("applied");
		expect(current?.before).toBe("hello");
		expect(current?.after).toBe("Hello.");
		expect(current?.createdAt).toBe(1_700_000_000_000);
		// id is `${Date.now()}-${++nextId}`: starts with the timestamp.
		expect(current?.id).toMatch(/^1700000000000-\d+$/);
	});

	test("show generates a monotonically increasing, unique id per call", () => {
		spyOn(Date, "now").mockReturnValue(42);
		useTransformNotifications.getState().show({ kind: "failed", reason: "boom" });
		const first = useTransformNotifications.getState().current?.id;
		useTransformNotifications.getState().show({ kind: "failed", reason: "boom2" });
		const second = useTransformNotifications.getState().current?.id;
		expect(first).toBeDefined();
		expect(second).toBeDefined();
		expect(first).not.toBe(second);
		// Both share the (mocked) timestamp prefix but differ in the counter
		// suffix, so even two notifications in the same millisecond are unique.
		const firstCounter = Number(first?.split("-")[1]);
		const secondCounter = Number(second?.split("-")[1]);
		expect(secondCounter).toBe(firstCounter + 1);
	});

	test("show supports the 'no-selection' kind with no before/after/reason", () => {
		useTransformNotifications.getState().show({ kind: "no-selection" });
		const current = useTransformNotifications.getState().current;
		expect(current?.kind).toBe("no-selection");
		expect(current?.before).toBeUndefined();
		expect(current?.after).toBeUndefined();
		expect(current?.reason).toBeUndefined();
	});

	test("newer show overwrites the older notification (single-slot)", () => {
		useTransformNotifications.getState().show({ kind: "applied", before: "a" });
		useTransformNotifications.getState().show({ kind: "failed", reason: "later" });
		const current = useTransformNotifications.getState().current;
		expect(current?.kind).toBe("failed");
		expect(current?.reason).toBe("later");
		expect(current?.before).toBeUndefined();
	});

	test("clear resets current back to null", () => {
		useTransformNotifications.getState().show({ kind: "applied" });
		useTransformNotifications.getState().clear();
		expect(useTransformNotifications.getState().current).toBeNull();
	});
});
