import { createContext, useContext } from "react";
import { useStore } from "zustand";
import {
	useVisualizerStore,
	type VisualizerState,
	type VisualizerStoreApi,
} from "./visualizer-store";

/**
 * Optional store override for the visualizer hooks. When absent (the normal
 * case — overlay, main window, pill), every hook reads the app-wide
 * `useVisualizerStore` fed by IPC. The settings visualizer-style previews
 * provide a sandboxed instance here so the REAL components can be driven with
 * synthetic audio without animating every other mounted visualizer.
 */
const VisualizerStoreContext = createContext<VisualizerStoreApi | null>(null);

export const VisualizerStoreProvider = VisualizerStoreContext.Provider;

/** Resolves the store powering visualizer hooks: sandbox if provided, else global. */
export function useVisualizerStoreApi(): VisualizerStoreApi {
	// react-doctor-disable-next-line react-hooks-js/hooks -- `useVisualizerStore` is the app-wide zustand StoreApi object used here as the fallback store value (it is later passed to `useStore(api, selector)` by `useVisualizerState`), not invoked as a hook. Its `use` prefix makes the rule read the `??` fallback as a conditionally-called hook; the only real hook call on this line, `useContext`, is unconditional and correct.
	return useContext(VisualizerStoreContext) ?? useVisualizerStore;
}

/** Context-aware replacement for `useVisualizerStore(selector)`. */
export function useVisualizerState<U>(selector: (s: VisualizerState) => U): U {
	return useStore(useVisualizerStoreApi(), selector);
}
