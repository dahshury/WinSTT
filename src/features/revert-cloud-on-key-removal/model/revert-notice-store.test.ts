import { afterEach, describe, expect, test } from "bun:test";
import { useRevertNoticeStore } from "./revert-notice-store";

afterEach(() => {
	useRevertNoticeStore.setState({ notices: [] });
});

describe("useRevertNoticeStore", () => {
	test("push adds a notice; re-pushing the same provider replaces it", () => {
		const { push } = useRevertNoticeStore.getState();
		push("openrouter");
		push("openrouter");
		const { notices } = useRevertNoticeStore.getState();
		expect(notices).toHaveLength(1);
		expect(notices[0]?.provider).toBe("openrouter");
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
