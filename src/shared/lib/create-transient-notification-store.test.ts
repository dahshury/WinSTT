import { describe, expect, test } from "bun:test";
import {
	createTransientNotificationStore,
	type TransientNotificationMeta,
} from "./create-transient-notification-store";

interface DemoNotification extends TransientNotificationMeta {
	kind: "a" | "b";
	reason?: string;
}

describe("createTransientNotificationStore", () => {
	test("starts with no current notification", () => {
		const store = createTransientNotificationStore<DemoNotification>();
		expect(store.getState().current).toBeNull();
		expect(store.getInitialState().current).toBeNull();
	});

	test("show stamps id + createdAt and preserves the payload", () => {
		const store = createTransientNotificationStore<DemoNotification>();
		store.getState().show({ kind: "a", reason: "boom" });
		const current = store.getState().current;
		expect(current?.kind).toBe("a");
		expect(current?.reason).toBe("boom");
		expect(typeof current?.id).toBe("string");
		expect(typeof current?.createdAt).toBe("number");
		expect(current?.id).toMatch(/^\d+-\d+$/);
	});

	test("ids are unique and monotonically increasing within a store", () => {
		const store = createTransientNotificationStore<DemoNotification>();
		store.getState().show({ kind: "a" });
		const first = store.getState().current?.id;
		store.getState().show({ kind: "b" });
		const second = store.getState().current?.id;
		expect(first).not.toBe(second);
		expect(Number(second?.split("-")[1])).toBe(
			Number(first?.split("-")[1]) + 1,
		);
	});

	test("each factory call has an independent counter", () => {
		const a = createTransientNotificationStore<DemoNotification>();
		const b = createTransientNotificationStore<DemoNotification>();
		a.getState().show({ kind: "a" });
		b.getState().show({ kind: "b" });
		expect(a.getState().current?.id.split("-")[1]).toBe("1");
		expect(b.getState().current?.id.split("-")[1]).toBe("1");
	});

	test("newer show overwrites the older entry (single-slot)", () => {
		const store = createTransientNotificationStore<DemoNotification>();
		store.getState().show({ kind: "a", reason: "first" });
		store.getState().show({ kind: "b", reason: "second" });
		expect(store.getState().current?.reason).toBe("second");
	});

	test("clear resets current to null", () => {
		const store = createTransientNotificationStore<DemoNotification>();
		store.getState().show({ kind: "a" });
		store.getState().clear();
		expect(store.getState().current).toBeNull();
	});
});
