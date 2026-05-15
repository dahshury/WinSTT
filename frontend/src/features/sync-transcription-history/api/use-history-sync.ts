"use client";

import { useEffect } from "react";
import { useTranscriptionHistoryStore } from "@/entities/transcription-history";
import { fetchTranscriptionHistory, onTranscriptionHistoryAdded } from "@/shared/api/ipc-client";

export function useTranscriptionHistorySync(): void {
	const setAll = useTranscriptionHistoryStore((s) => s.setAll);
	const addEntry = useTranscriptionHistoryStore((s) => s.addEntry);

	useEffect(() => {
		let cancelled = false;
		fetchTranscriptionHistory().then((entries) => {
			if (!cancelled) {
				setAll(entries);
			}
		});
		const unsub = onTranscriptionHistoryAdded((entry) => {
			addEntry(entry);
		});
		return () => {
			cancelled = true;
			unsub();
		};
	}, [setAll, addEntry]);
}
