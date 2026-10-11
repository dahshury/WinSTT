import { createContext, useContext } from "react";
import { useModelPickerWindowOpen } from "@/shared/api/model-picker-window-state";

export const ModelSelectorHoverDisabledContext = createContext(false);

export function useModelSelectorHoverDisabled(): boolean {
	const inlinePickerOpen = useContext(ModelSelectorHoverDisabledContext);
	const detachedPickerOpen = useModelPickerWindowOpen();
	return inlinePickerOpen || detachedPickerOpen;
}
