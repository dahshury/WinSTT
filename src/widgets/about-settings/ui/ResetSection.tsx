import {
	ArrowTurnBackwardIcon,
	Delete02Icon,
	PackageRemoveIcon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { type ReactNode, useState } from "react";
import { useTranslations } from "use-intl";
import { SettingSection, useSettingsStore } from "@/entities/setting";
import {
	removeApplicationData,
	removeDownloadedModels,
} from "@/shared/api/ipc-client";
import { ConfirmDialog } from "@/shared/ui/confirm-dialog";
import { Toggle } from "@/shared/ui/toggle";
import { AboutActionButton } from "./AboutActionButton";

// Reset actions share the fixed-width About action button; the destructive row
// keeps its error tone without leaving the standard elevated control surface.
interface ResetActionRowProps {
	buttonLabel: string;
	/** Render the trailing button with the dim-error destructive treatment. */
	destructive?: boolean;
	icon: IconSvgElement;
	onClick: () => void;
	summary: string;
	title: string;
}

/** One flat row in the Reset/Removal section — title + summary on the left, a
 *  compact standard button on the right. Mirrors the FormControl "row" rhythm
 *  (`gap-4 py-3`) so it divides cleanly alongside the other settings rows. */
function ResetActionRow({
	buttonLabel,
	destructive = false,
	icon,
	onClick,
	summary,
	title,
}: ResetActionRowProps) {
	return (
		<div className="flex items-center gap-4 py-3">
			<div className="flex min-w-0 flex-1 flex-col gap-1">
				<span className="font-medium text-body text-foreground leading-tight">
					{title}
				</span>
				<span className="text-body-sm text-foreground-muted leading-snug">
					{summary}
				</span>
			</div>
			<AboutActionButton
				icon={icon}
				onClick={onClick}
				variant={destructive ? "danger" : "neutral"}
			>
				{buttonLabel}
			</AboutActionButton>
		</div>
	);
}

export function ResetSection(): ReactNode {
	const resetSettings = useSettingsStore((s) => s.resetSettings);
	const ts = useTranslations("settings");
	const tc = useTranslations("common");
	const [resetConfirmOpen, setResetConfirmOpen] = useState(false);
	const [removeModelsConfirmOpen, setRemoveModelsConfirmOpen] = useState(false);
	const [removeConfirmOpen, setRemoveConfirmOpen] = useState(false);
	const [
		deleteOllamaModelsWithModelCleanup,
		setDeleteOllamaModelsWithModelCleanup,
	] = useState(false);
	const [deleteOllamaModels, setDeleteOllamaModels] = useState(false);
	const [modelCleanupError, setModelCleanupError] = useState("");
	const [cleanupError, setCleanupError] = useState("");

	const handleRemoveDownloadedModels = () => {
		setModelCleanupError("");
		removeDownloadedModels(deleteOllamaModelsWithModelCleanup)
			.then((result) => {
				const issues = [...result.errors, ...result.ollamaErrors];
				if (issues.length > 0) {
					setModelCleanupError(issues.join("\n"));
					setRemoveModelsConfirmOpen(true);
				}
			})
			.catch((err) => {
				setModelCleanupError(err instanceof Error ? err.message : String(err));
				setRemoveModelsConfirmOpen(true);
			});
	};

	const handleRemoveApplicationData = () => {
		setCleanupError("");
		removeApplicationData(deleteOllamaModels).catch((err) => {
			setCleanupError(err instanceof Error ? err.message : String(err));
			setRemoveConfirmOpen(true);
		});
	};

	return (
		<>
			<ConfirmDialog
				cancelLabel={tc("cancel")}
				confirmLabel={ts("resetConfirm")}
				description={
					<div className="flex flex-col gap-2">
						<p>{ts("resetDescription")}</p>
						<p className="font-medium text-error">
							{ts("permanentActionWarning")}
						</p>
					</div>
				}
				onConfirm={resetSettings}
				onOpenChange={setResetConfirmOpen}
				open={resetConfirmOpen}
				title={ts("resetTitle")}
			/>
			<ConfirmDialog
				cancelLabel={tc("cancel")}
				confirmLabel={ts("removeDownloadedModelsConfirm")}
				description={
					<div className="flex flex-col gap-3">
						<p>{ts("removeDownloadedModelsDescription")}</p>
						<p className="font-medium text-error">
							{ts("permanentActionWarning")}
						</p>
						<div className="flex items-start justify-between gap-4 rounded-md border border-divider bg-foreground/5 p-3">
							<div className="flex min-w-0 flex-col gap-1">
								<span className="font-medium text-body text-foreground">
									{ts("removeApplicationDataOllama")}
								</span>
								<span className="text-body text-foreground-muted">
									{ts("removeApplicationDataOllamaDescription")}
								</span>
							</div>
							<Toggle
								aria-label={ts("removeApplicationDataOllama")}
								checked={deleteOllamaModelsWithModelCleanup}
								onCheckedChange={setDeleteOllamaModelsWithModelCleanup}
							/>
						</div>
						{modelCleanupError ? (
							<p className="whitespace-pre-line text-body text-error">
								{modelCleanupError}
							</p>
						) : null}
					</div>
				}
				onConfirm={handleRemoveDownloadedModels}
				onOpenChange={setRemoveModelsConfirmOpen}
				open={removeModelsConfirmOpen}
				title={ts("removeDownloadedModelsTitle")}
			/>
			<ConfirmDialog
				cancelLabel={tc("cancel")}
				confirmLabel={ts("removeApplicationDataConfirm")}
				description={
					<div className="flex flex-col gap-3">
						<p>{ts("removeApplicationDataDescription")}</p>
						<p className="font-medium text-error">
							{ts("permanentActionWarning")}
						</p>
						<div className="flex items-start justify-between gap-4 rounded-md border border-divider bg-foreground/5 p-3">
							<div className="flex min-w-0 flex-col gap-1">
								<span className="font-medium text-body text-foreground">
									{ts("removeApplicationDataOllama")}
								</span>
								<span className="text-body text-foreground-muted">
									{ts("removeApplicationDataOllamaDescription")}
								</span>
							</div>
							<Toggle
								aria-label={ts("removeApplicationDataOllama")}
								checked={deleteOllamaModels}
								onCheckedChange={setDeleteOllamaModels}
							/>
						</div>
						{cleanupError ? (
							<p className="text-body text-error">{cleanupError}</p>
						) : null}
					</div>
				}
				onConfirm={handleRemoveApplicationData}
				onOpenChange={setRemoveConfirmOpen}
				open={removeConfirmOpen}
				title={ts("removeApplicationDataTitle")}
			/>
			<SettingSection
				description={ts("resetAndRemovalDescription")}
				divided
				icon={ArrowTurnBackwardIcon}
				title={ts("resetAndRemovalTitle")}
			>
				<ResetActionRow
					buttonLabel={ts("resetDefaults")}
					icon={ArrowTurnBackwardIcon}
					onClick={() => setResetConfirmOpen(true)}
					summary={ts("resetDefaultsSummary")}
					title={ts("resetDefaults")}
				/>
				<ResetActionRow
					buttonLabel={ts("removeDownloadedModelsButton")}
					icon={PackageRemoveIcon}
					onClick={() => {
						setModelCleanupError("");
						setRemoveModelsConfirmOpen(true);
					}}
					summary={ts("removeDownloadedModelsSummary")}
					title={ts("removeDownloadedModelsButton")}
				/>
				<ResetActionRow
					buttonLabel={ts("removeApplicationDataButton")}
					destructive
					icon={Delete02Icon}
					onClick={() => {
						setCleanupError("");
						setRemoveConfirmOpen(true);
					}}
					summary={ts("removeApplicationDataSummary")}
					title={ts("removeApplicationDataButton")}
				/>
			</SettingSection>
		</>
	);
}
