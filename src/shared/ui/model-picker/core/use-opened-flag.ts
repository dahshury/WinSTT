import { useState } from "react";

/**
 * Latch that flips ``true`` the first time the panel opens and stays
 * ``true`` thereafter. Used to gate the initial mount of expensive
 * subtrees without re-mounting on every close/re-open cycle.
 */
export function useOpenedFlag(isOpen: boolean): boolean {
	const [hasOpened, setHasOpened] = useState(isOpen);
	if (isOpen && !hasOpened) {
		setHasOpened(true);
	}
	return hasOpened;
}
