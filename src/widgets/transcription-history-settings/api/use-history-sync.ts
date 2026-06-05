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
    fetchTranscriptionHistory().then((entries) => {
      if (!cancelled) {
        setAll(entries);
      }
    });
    fetchTransformHistory().then((entries) => {
      if (!cancelled) {
        setTransformAll(entries);
      }
    });
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
