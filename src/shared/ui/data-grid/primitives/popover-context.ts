import { createContext } from "react";

export interface AnchorContextValue {
	anchorRef: { current: HTMLElement | null };
	hasAnchor: boolean;
	setHasAnchor: (value: boolean) => void;
}

export const AnchorContext = createContext<AnchorContextValue | null>(null);
