import { useState } from "react";
import type { TranslateFn } from "./types";

export type Tab = "installed" | "recommended";

export interface DialogState {
	deletingName: string | null;
	pendingDelete: string | null;
	query: string;
	tab: Tab;
}

export interface DialogActions {
	setDeletingName: (n: string | null) => void;
	setPendingDelete: (n: string | null) => void;
	setQuery: (q: string) => void;
	setTab: (t: Tab) => void;
}

export function useDialogState(): [DialogState, DialogActions] {
	const [tab, setTab] = useState<Tab>("installed");
	const [query, setQuery] = useState("");
	const [deletingName, setDeletingName] = useState<string | null>(null);
	const [pendingDelete, setPendingDelete] = useState<string | null>(null);
	return [
		{ tab, query, deletingName, pendingDelete },
		{ setTab, setQuery, setDeletingName, setPendingDelete },
	];
}

export type { TranslateFn };
export { DialogFooter } from "./DialogFooter";
export { DialogHeader, type DialogHeaderProps } from "./DialogHeader";
export { DialogSearch } from "./DialogSearch";
