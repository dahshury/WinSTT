import { create } from "zustand";
import type { ClearableProvider } from "./cloud-revert-decision";

/** A transient "we reverted you to local" notice for one cleared provider. */
interface RevertNotice {
	id: number;
	provider: ClearableProvider;
}

interface RevertNoticeState {
	dismiss: (id: number) => void;
	notices: RevertNotice[];
	/** Surface a notice for `provider`, replacing any prior one for it so a
	 *  repeated removal can't stack duplicates. */
	push: (provider: ClearableProvider) => void;
}

const nextNoticeId = (() => {
	let n = 0;
	return () => ++n;
})();

/**
 * Decoupled from the toast component because the auto-revert hook
 * (`useCloudKeyAutoRevert`, mounted in the main window's `IpcProvider`) and the
 * `CloudKeyRevertNotice` toast (mounted in `RootLayout`) live in different
 * subtrees. The hook `push`es; the toast subscribes + `dismiss`es.
 */
export const useRevertNoticeStore = create<RevertNoticeState>()((set) => ({
	notices: [],
	push: (provider) =>
		set((state) => ({
			notices: [
				...state.notices.filter((n) => n.provider !== provider),
				{ id: nextNoticeId(), provider },
			],
		})),
	dismiss: (id) => set((state) => ({ notices: state.notices.filter((n) => n.id !== id) })),
}));
