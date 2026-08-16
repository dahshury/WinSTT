import {
	FileEditIcon,
	LeftToRightListBulletIcon,
	Note01Icon,
	QuestionIcon,
	QuoteDownIcon,
	StickyNote01Icon,
	Task01Icon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { type ReactNode, useState } from "react";
import { useTranslations } from "use-intl";
import { useSettingsStore } from "@/entities/setting";
import { useSurface } from "@/shared/lib/surface";
import { AutoTextarea } from "@/shared/ui/auto-textarea";
import {
	DialogActionButton,
	DialogBody,
	DialogFooter,
	DialogHeader,
} from "@/shared/ui/dialog";
import { FormControl } from "@/shared/ui/form-control";
import { Modal } from "@/shared/ui/modal";
import { Select, type SelectOption } from "@/shared/ui/select";
import { Spinner } from "@/shared/ui/spinner";
import { postProcessHistoryEntry } from "../api/post-process";
import {
	CUSTOM_PRESET_ID,
	LISTEN_POST_PROCESS_PRESETS,
	resolveInstructions,
} from "../lib/presets";

/** Resting height of the custom-instructions editor, in rows. Five lines
 *  reproduces the 120px floor it used to be pinned to; longer instructions now
 *  grow the box instead of hiding behind a resize grip. */
const INSTRUCTIONS_MIN_ROWS = 5;

const PRESET_ICONS: Record<string, IconSvgElement> = {
	actionItems: Task01Icon,
	keyQuotes: QuoteDownIcon,
	meetingNotes: Note01Icon,
	qa: QuestionIcon,
	studyNotes: StickyNote01Icon,
	summary: LeftToRightListBulletIcon,
};

export interface ListenPostProcessDialogProps {
	/** History entry id (settings-table string id, numeric row id inside). */
	entryId: string;
	isOpen: boolean;
	onClose: () => void;
}

/**
 * Preset picker + custom-instructions dialog for post-processing a listening
 * session's transcript (meeting notes, summary, …). Runs the configured
 * post-processing LLM over the RAW session transcript; the result replaces
 * any previous processed text and the row's original/processed swap toggles
 * between the two. Requires AI post-processing to be enabled in Settings —
 * otherwise the run button is disabled with an explanatory hint.
 */
export function ListenPostProcessDialog({
	entryId,
	isOpen,
	onClose,
}: ListenPostProcessDialogProps): ReactNode {
	const t = useTranslations("history");
	const tc = useTranslations("common");
	const postProcessingEnabled = useSettingsStore(
		(s) => s.settings.llm.dictation.enabled,
	);
	const [presetId, setPresetId] = useState(
		LISTEN_POST_PROCESS_PRESETS[0]?.id ?? CUSTOM_PRESET_ID,
	);
	const [customInstructions, setCustomInstructions] = useState("");
	const [running, setRunning] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// Same one-step lift the modifier dialog's prompt textarea uses, so the
	// custom-instructions input reads as an input on the modal surface.
	const inputLevel = Math.min(useSurface() + 1, 8);

	const presetOptions: SelectOption[] = [
		...LISTEN_POST_PROCESS_PRESETS.map((preset) => ({
			id: preset.id,
			label: t(preset.labelKey),
			...(PRESET_ICONS[preset.id] ? { icon: PRESET_ICONS[preset.id] } : {}),
		})),
		{
			icon: FileEditIcon,
			id: CUSTOM_PRESET_ID,
			label: t("listenPresetCustom"),
		},
	];
	const instructions = resolveInstructions(presetId, customInstructions);
	const canRun = postProcessingEnabled && instructions !== null && !running;

	const handleClose = () => {
		if (!running) {
			setError(null);
			onClose();
		}
	};

	const run = async () => {
		if (!canRun || instructions === null) {
			return;
		}
		setRunning(true);
		setError(null);
		try {
			await postProcessHistoryEntry(Number(entryId), instructions);
			setRunning(false);
			onClose();
		} catch (err) {
			setRunning(false);
			setError(err instanceof Error ? err.message : String(err));
		}
	};

	return (
		<Modal isOpen={isOpen} onClose={handleClose}>
			<div className="flex max-h-[86vh] w-[28rem] max-w-[90vw] flex-col">
				<DialogHeader
					closeLabel={tc("close")}
					onClose={handleClose}
					rail
					title={t("listenPostProcessTitle")}
				/>
				<DialogBody className="flex flex-col divide-y divide-divider">
					<FormControl label={t("listenPostProcessPreset")} layout="row">
						<Select
							aria-label={t("listenPostProcessPreset")}
							className="w-56"
							onChange={setPresetId}
							options={presetOptions}
							value={presetId}
						/>
					</FormControl>
					{presetId === CUSTOM_PRESET_ID ? (
						<FormControl label={t("listenPostProcessCustomLabel")}>
							<AutoTextarea
								aria-label={t("listenPostProcessCustomLabel")}
								id="listen-post-process-custom-input"
								minRows={INSTRUCTIONS_MIN_ROWS}
								onChange={(e) => setCustomInstructions(e.target.value)}
								placeholder={t("listenPostProcessCustomPlaceholder")}
								// Resolved here, outside the popup's SurfaceProvider — pass it
								// through so the input keeps the exact step it painted on.
								surfaceLevel={inputLevel}
								value={customInstructions}
							/>
						</FormControl>
					) : null}
					{postProcessingEnabled ? null : (
						<p className="border-none pt-2 text-body-sm text-warning">
							{t("listenPostProcessDisabled")}
						</p>
					)}
					{error ? (
						<p className="break-words border-none pt-2 text-body-sm text-error">
							{error}
						</p>
					) : null}
					{running ? (
						<p className="border-none pt-2 text-body-sm text-foreground-muted">
							{t("listenPostProcessRunning")}
						</p>
					) : null}
				</DialogBody>
				<DialogFooter bar>
					<DialogActionButton
						disabled={running}
						onClick={handleClose}
						variant="neutral"
					>
						{tc("cancel")}
					</DialogActionButton>
					<DialogActionButton disabled={!canRun} onClick={run} variant="accent">
						{running ? (
							<span className="inline-flex items-center gap-1.5">
								<Spinner className="size-3.5" />
								{t("listenPostProcessRun")}
							</span>
						) : (
							t("listenPostProcessRun")
						)}
					</DialogActionButton>
				</DialogFooter>
			</div>
		</Modal>
	);
}
