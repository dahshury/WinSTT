import { useRef, useState } from "react";
import { useTranslations } from "use-intl";
import { commands } from "@/bindings";
import { useSettingsStore } from "@/entities/setting";
import { generateId } from "@/shared/lib/generate-id";
import { Button } from "@/shared/ui/button";
import {
	MAX_VOCABULARY_FILE_BYTES,
	parseVocabularyFile,
	planVocabularyMerge,
	type VocabularyKind,
} from "../lib/vocabulary-file";

export function VocabularyTransfer({ kind }: { kind: VocabularyKind }) {
	const t = useTranslations("vocabularyTransfer");
	const input = useRef<HTMLInputElement>(null);
	const [busy, setBusy] = useState(false);
	const [status, setStatus] = useState<string>();
	const [error, setError] = useState(false);
	const importFile = async (file: File) => {
		setBusy(true);
		setStatus(undefined);
		setError(false);
		try {
			if (file.size > MAX_VOCABULARY_FILE_BYTES) {
				throw new Error("limit");
			}
			const rows = parseVocabularyFile(await file.text(), kind);
			// Read after file IO: edits or saves in another window may have arrived while reading.
			const store = useSettingsStore.getState();
			const keys =
				kind === "dictionary"
					? store.settings.dictionary.map((entry) => entry.term)
					: store.settings.snippets.map((entry) => entry.trigger);
			const plan = planVocabularyMerge(keys, rows, kind);
			if (plan.added.length > 0) {
				if (kind === "dictionary") {
					store.updateDictionary([
						...store.settings.dictionary,
						...plan.added.map((row) => ({
							id: generateId(),
							term: row.key,
							replacement: row.value,
							autoAdded: row.autoAdded,
						})),
					]);
				} else {
					store.updateSnippets([
						...store.settings.snippets,
						...plan.added.map((row) => ({
							id: generateId(),
							trigger: row.key,
							expansion: row.value as string,
						})),
					]);
				}
			}
			setStatus(
				t("imported", { count: plan.added.length, skipped: plan.skipped }),
			);
		} catch (cause) {
			setError(true);
			setStatus(
				t(
					cause instanceof Error && cause.message === "limit"
						? "limitError"
						: "importError",
				),
			);
		} finally {
			setBusy(false);
		}
	};
	const exportFile = async () => {
		setBusy(true);
		setStatus(undefined);
		setError(false);
		try {
			const result = await commands.settingsExportVocabulary(
				kind,
				JSON.stringify(useSettingsStore.getState().settings[kind]),
			);
			if (
				result.status === "error" ||
				!(result.data.ok || result.data.cancelled)
			) {
				throw new Error("export");
			}
		} catch {
			setError(true);
			setStatus(t("exportError"));
		} finally {
			setBusy(false);
		}
	};
	return (
		<div className="flex flex-col gap-2">
			<div className="flex gap-3">
				<Button
					className="rounded px-2 py-1 text-sm"
					disabled={busy}
					onClick={() => input.current?.click()}
				>
					{t("import")}
				</Button>
				<Button
					className="rounded px-2 py-1 text-sm"
					disabled={busy}
					onClick={() => void exportFile()}
				>
					{t("export")}
				</Button>
				<input
					accept=".json,.csv,.txt"
					aria-label={t("import")}
					className="hidden"
					disabled={busy}
					ref={input}
					type="file"
					onChange={(event) => {
						const file = event.currentTarget.files?.[0];
						event.currentTarget.value = "";
						if (file) {
							void importFile(file);
						}
					}}
				/>
			</div>
			<p className="text-muted text-xs">
				{t(kind === "dictionary" ? "hint" : "hintSnippets")}
			</p>
			{status && (
				<p className="text-xs" role={error ? "alert" : "status"}>
					{status}
				</p>
			)}
		</div>
	);
}
