import { useEffect } from "react";
import {
	fetchTranscriptionHistory,
	onTranscriptionHistoryAdded,
	onTranscriptionHistoryDeleted,
} from "@/shared/api/ipc-client";
import { useTranscriptionHistoryStore } from "../model/history-store";

export function useTranscriptionHistorySync(): void {
	const setAll = useTranscriptionHistoryStore((s) => s.setAll);
	const addEntry = useTranscriptionHistoryStore((s) => s.addEntry);
	const removeEntry = useTranscriptionHistoryStore((s) => s.removeEntry);

	useEffect(() => {
		let cancelled = false;
		fetchTranscriptionHistory().then((entries) => {
			if (!cancelled) {
				setAll(entries);
			}
		});
		const unsubAdded = onTranscriptionHistoryAdded((entry) => {
			addEntry(entry);
		});
		const unsubDeleted = onTranscriptionHistoryDeleted((payload) => {
			removeEntry(payload.id);
		});
		return () => {
			cancelled = true;
			unsubAdded();
			unsubDeleted();
		};
	}, [setAll, addEntry, removeEntry]);
}
