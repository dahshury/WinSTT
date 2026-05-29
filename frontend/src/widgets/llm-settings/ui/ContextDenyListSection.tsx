import { Delete02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import { useTranslations } from "use-intl";
import { useSettingsStore } from "@/entities/setting";
import { Button } from "@/shared/ui/button";
import { FormControl } from "@/shared/ui/form-control";
import {
	Table,
	TableBody,
	TableCell,
	TableEmpty,
	TableHead,
	TableHeader,
	TableRow,
} from "@/shared/ui/table";
import { TextField } from "@/shared/ui/text-field";
import { Tooltip } from "@/shared/ui/tooltip";

/**
 * Editable deny-list for context capture.
 *
 * Two kinds of entries — both stored as plain strings; the matcher in
 * `electron/lib/context-snapshot.ts#isDeniedByList` distinguishes them
 * by the `.exe` suffix:
 *
 *  - `chrome.exe`, `1password.exe` — exe-name match against the
 *    foreground process basename.
 *  - `bankofamerica.com`, `chase.com` — URL host suffix match;
 *    automatically covers subdomains.
 *
 * The section is rendered alongside ContextAwarenessSection so the
 * privacy story stays in one place: enable context → see what gets
 * skipped. Empty / whitespace-only entries are rejected client-side;
 * the matcher also drops them, but trimming here keeps the persisted
 * store clean.
 */
export function ContextDenyListSection() {
	const general = useSettingsStore((s) => s.settings.general);
	const dictation = useSettingsStore((s) => s.settings.llm.dictation);
	const openrouterApiKey = useSettingsStore((s) => s.settings.llm.openrouterApiKey);
	const update = useSettingsStore((s) => s.updateGeneralSettings);
	const t = useTranslations("general");
	const denyList = general?.contextDenyList ?? [];
	const [draft, setDraft] = useState("");

	// Hidden in lockstep with ContextAwarenessSection — the deny-list only
	// gates the capture pipeline, which never runs when the dictation LLM
	// isn't configured. Same gate as relay.ts `isLlmConfigured()`.
	const hasDictationModel =
		dictation.provider === "openrouter" ? openrouterApiKey.length > 0 : dictation.model.length > 0;
	if (!(dictation.enabled && hasDictationModel)) {
		return null;
	}

	const trimmed = draft.trim().toLowerCase();
	const isDuplicate = denyList.some((entry) => entry.toLowerCase() === trimmed);
	const canAdd = trimmed.length > 0 && !isDuplicate;

	const handleAdd = (): void => {
		if (!canAdd) {
			return;
		}
		update({ contextDenyList: [...denyList, trimmed] });
		setDraft("");
	};

	const handleRemove = (entry: string): void => {
		update({ contextDenyList: denyList.filter((e) => e !== entry) });
	};

	return (
		<FormControl label={t("contextDenyList")} tooltip={t("contextDenyListTooltip")}>
			<div className="flex flex-col gap-3">
				<form
					className="flex items-end gap-2"
					onSubmit={(e) => {
						e.preventDefault();
						handleAdd();
					}}
				>
					<div className="flex-1">
						<TextField
							onChange={(e) => setDraft(e.target.value)}
							placeholder={t("contextDenyListPlaceholder")}
							value={draft}
						/>
					</div>
					<Button
						className="mb-0 h-8 rounded-md bg-accent px-3 font-medium text-black text-body transition-colors duration-150 hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
						disabled={!canAdd}
						type="submit"
					>
						{t("contextDenyListAdd")}
					</Button>
				</form>
				<Table containerClassName="rounded border border-border overflow-hidden">
					<TableHeader>
						<TableRow>
							<TableHead>{t("contextDenyListColumnEntry")}</TableHead>
							<TableHead className="w-10" />
						</TableRow>
					</TableHeader>
					<TableBody>
						{denyList.length === 0 ? (
							<TableEmpty colSpan={2}>{t("contextDenyListEmpty")}</TableEmpty>
						) : (
							denyList.map((entry, idx) => (
								<TableRow index={idx} key={entry}>
									<TableCell className="text-foreground">{entry}</TableCell>
									<TableCell className="w-10 text-right">
										<Tooltip content={t("contextDenyListRemove")}>
											<Button
												aria-label={`${t("contextDenyListRemove")} "${entry}"`}
												className="rounded bg-transparent p-1 text-error transition-colors duration-150 hover:bg-error-dim"
												onClick={() => handleRemove(entry)}
											>
												<HugeiconsIcon icon={Delete02Icon} size={14} />
											</Button>
										</Tooltip>
									</TableCell>
								</TableRow>
							))
						)}
					</TableBody>
				</Table>
			</div>
		</FormControl>
	);
}
