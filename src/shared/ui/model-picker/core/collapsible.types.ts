import type { ReactNode } from "react";

export interface CollapsibleProps {
	children: ReactNode;
	className?: string;
	/**
	 * ``data-slot`` attribute for downstream styling / test hooks. Defaults
	 * to ``"collapsible"`` but callers can override (e.g. ``"providers-row"``
	 * for OpenRouter's hosting-provider grid).
	 */
	"data-slot"?: string;
	/** Whether the panel is currently expanded. */
	isOpen: boolean;
}
