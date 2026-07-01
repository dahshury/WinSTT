import { useEffect } from "react";
import {
	fetchTranscriptionHistory,
	fetchTransformHistory,
	onTranscriptionHistoryAdded,
	onTranscriptionHistoryDeleted,
	onTransformHistoryAdded,
	onTransformHistoryDeleted,
} from "@/shared/api/ipc-client";
import { useTranscriptionHistoryStore } from "../model/history-store";

export function useTranscriptionHistorySync(): void {
	const setAll = useTranscriptionHistoryStore((s) => s.setAll);
	const addEntry = useTranscriptionHistoryStore((s) => s.addEntry);
	const removeEntry = useTranscriptionHistoryStore((s) => s.removeEntry);
	const setTransformAll = useTranscriptionHistoryStore(
		(s) => s.setTransformAll,
	);
	const addTransformEntry = useTranscriptionHistoryStore(
		(s) => s.addTransformEntry,
	);
	const removeTransformEntry = useTranscriptionHistoryStore(
		(s) => s.removeTransformEntry,
	);

	useEffect(() => {
		let cancelled = false;
		// Fetch ONCE per window. This hook is mounted at the settings-window root
		// (SettingsBootstrap), so it stays alive across tab switches and the live
		// added/deleted subscriptions below keep the store current. Re-fetching on
		// every History-tab remount was the root of the "stats rebuild slowly each
		// visit" lag: `setAll` swaps in a brand-new array, which busts every
		// reference-keyed stats cache and forces a full recompute. Guarding on the
		// already-hydrated flags keeps the array identity stable so revisits hit
		// the warm caches instead.
		const { isLoaded, transformsLoaded } =
			useTranscriptionHistoryStore.getState();
		if (!isLoaded) {
			fetchTranscriptionHistory().then((entries) => {
				if (!cancelled) {
					setAll(entries);
				}
			});
		}
		if (!transformsLoaded) {
			fetchTransformHistory().then((entries) => {
				if (!cancelled) {
					setTransformAll(entries);
				}
			});
		}
		const unsubAdded = onTranscriptionHistoryAdded((entry) => {
			addEntry(entry);
		});
		const unsubDeleted = onTranscriptionHistoryDeleted((payload) => {
			removeEntry(payload.id);
		});
		const unsubTransformAdded = onTransformHistoryAdded((entry) => {
			addTransformEntry(entry);
		});
		const unsubTransformDeleted = onTransformHistoryDeleted((payload) => {
			removeTransformEntry(payload.id);
		});
		return () => {
			cancelled = true;
			unsubAdded();
			unsubDeleted();
			unsubTransformAdded();
			unsubTransformDeleted();
		};
	}, [
		setAll,
		addEntry,
		removeEntry,
		setTransformAll,
		addTransformEntry,
		removeTransformEntry,
	]);
}
