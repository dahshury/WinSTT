import { useEffect } from "react";
import { useSettingsStore } from "@/entities/setting";
import {
	fetchTranscriptionHistory,
	fetchTransformHistory,
	fetchTtsHistory,
	onTranscriptionHistoryAdded,
	onTranscriptionHistoryDeleted,
	onTransformHistoryAdded,
	onTransformHistoryDeleted,
	onTtsHistoryAdded,
	onTtsHistoryDeleted,
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
	const setTtsAll = useTranscriptionHistoryStore((s) => s.setTtsAll);
	const addTtsEntry = useTranscriptionHistoryStore((s) => s.addTtsEntry);
	const removeTtsEntry = useTranscriptionHistoryStore((s) => s.removeTtsEntry);
	const historyEnabled = useSettingsStore(
		(s) => s.settings.general?.historyEnabled ?? true,
	);

	useEffect(() => {
		// History master switch off: drop the in-memory copies (no data exposure
		// in the renderer) and skip fetch + live subscriptions entirely. Loaded
		// flags reset to false so flipping the switch back on re-hydrates below.
		if (!historyEnabled) {
			useTranscriptionHistoryStore.setState({
				entries: [],
				isLoaded: false,
				transformEntries: [],
				transformsLoaded: false,
				ttsEntries: [],
				ttsLoaded: false,
			});
			return;
		}
		let cancelled = false;
		// Fetch ONCE per window. This hook is mounted at the settings-window root
		// (SettingsBootstrap), so it stays alive across tab switches and the live
		// added/deleted subscriptions below keep the store current. Re-fetching on
		// every History-tab remount was the root of the "stats rebuild slowly each
		// visit" lag: `setAll` swaps in a brand-new array, which busts every
		// reference-keyed stats cache and forces a full recompute. Guarding on the
		// already-hydrated flags keeps the array identity stable so revisits hit
		// the warm caches instead.
		const { isLoaded, transformsLoaded, ttsLoaded } =
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
		if (!ttsLoaded) {
			fetchTtsHistory().then((entries) => {
				if (!cancelled) {
					setTtsAll(entries);
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
		const unsubTtsAdded = onTtsHistoryAdded((entry) => {
			addTtsEntry(entry);
		});
		const unsubTtsDeleted = onTtsHistoryDeleted((payload) => {
			removeTtsEntry(payload.id);
		});
		return () => {
			cancelled = true;
			unsubAdded();
			unsubDeleted();
			unsubTransformAdded();
			unsubTransformDeleted();
			unsubTtsAdded();
			unsubTtsDeleted();
		};
	}, [
		historyEnabled,
		setAll,
		addEntry,
		removeEntry,
		setTransformAll,
		addTransformEntry,
		removeTransformEntry,
		setTtsAll,
		addTtsEntry,
		removeTtsEntry,
	]);
}
