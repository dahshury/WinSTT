import { create } from "zustand";

export type SettingsHydrationStatus =
  | "idle"
  | "loading"
  | "ready"
  | "unavailable"
  | "error";

interface SettingsHydrationState {
  error: string | null;
  reset: () => void;
  setStatus: (status: SettingsHydrationStatus, error?: string | null) => void;
  status: SettingsHydrationStatus;
}

export const useSettingsHydrationStore = create<SettingsHydrationState>(
  (set) => ({
    error: null,
    reset: () => set({ error: null, status: "idle" }),
    setStatus: (status, error = null) => set({ error, status }),
    status: "idle",
  }),
);
