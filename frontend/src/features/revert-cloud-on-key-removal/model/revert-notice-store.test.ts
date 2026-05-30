import { afterEach, describe, expect, test } from "bun:test";
import { useRevertNoticeStore } from "./revert-notice-store";

afterEach(() => {
	useRevertNoticeStore.setState({ notices: [] });
});

describe("useRevertNoticeStore", () => {
	test("push adds a notice; re-pushing the same provider replaces it", () => {
		const { push } = useRevertNoticeStore.getState();
		push("openai");
		push("openai");
		const { notices } = useRevertNoticeStore.getState();
		expect(notices).toHaveLength(1);
		expect(notices[0]?.provider).toBe("openai");
	});

	test("dismiss removes the matching notice", () => {
		const { push, dismiss } = useRevertNoticeStore.getState();
		push("elevenlabs");
		const first = useRevertNoticeStore.getState().notices[0];
		expect(first).toBeDefined();
		dismiss(first?.id ?? -1);
		expect(useRevertNoticeStore.getState().notices).toHaveLength(0);
	});
});
