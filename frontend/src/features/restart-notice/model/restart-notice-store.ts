import { create } from "zustand";

/**
 * Transient notice shown when a startup-only setting changed but the STT
 * server is not Electron-managed (dev: user-run server), so Electron can't
 * auto-restart it. Without this the change silently never applies — and any
 * UI gating on the never-arriving restart looks like a hang. At most one
 * notice at a time; newer events overwrite older ones.
 */
export type RestartNoticeKind = "unmanaged" | "skew";

interface RestartNotice {
	kind: RestartNoticeKind;
	setting: string;
}

interface RestartNoticeState {
	clear: () => void;
	current: RestartNotice | null;
	show: (setting: string, kind: RestartNoticeKind) => void;
}

export const useRestartNotice = create<RestartNoticeState>((set) => ({
	current: null,
	show: (setting, kind) => set({ current: { setting, kind } }),
	clear: () => set({ current: null }),
}));
