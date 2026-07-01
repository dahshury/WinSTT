import {
	ArrowTurnBackwardIcon,
	Delete02Icon,
	PackageRemoveIcon,
} from "@hugeicons/core-free-icons";
import { type ReactNode, useReducer } from "react";
import { useTranslations } from "use-intl";
import { SettingSection, useSettingsStore } from "@/entities/setting";
import {
	removeApplicationData,
	removeDownloadedModels,
} from "@/shared/api/ipc-client";
import { ConfirmDialog } from "@/shared/ui/confirm-dialog";
import { Toggle } from "@/shared/ui/toggle";
import { AboutActionRow } from "./AboutActionRow";
import { AppDataUsageBreakdown } from "./AppDataUsageBreakdown";

interface ResetSectionState {
	cleanupError: string;
	deleteOllamaModels: boolean;
	deleteOllamaModelsWithModelCleanup: boolean;
	modelCleanupError: string;
	removeConfirmOpen: boolean;
	removeModelsConfirmOpen: boolean;
	resetConfirmOpen: boolean;
}

type ResetSectionAction =
	| { open: boolean; type: "resetConfirmOpenChanged" }
	| { open: boolean; type: "removeModelsConfirmOpenChanged" }
	| { open: boolean; type: "removeConfirmOpenChanged" }
	| { checked: boolean; type: "deleteOllamaModelsWithModelCleanupChanged" }
	| { checked: boolean; type: "deleteOllamaModelsChanged" }
	| { error: string; type: "modelCleanupErrorChanged" }
	| { error: string; type: "cleanupErrorChanged" };

const INITIAL_RESET_SECTION_STATE: ResetSectionState = {
	cleanupError: "",
	deleteOllamaModels: false,
	deleteOllamaModelsWithModelCleanup: false,
	modelCleanupError: "",
	removeConfirmOpen: false,
	removeModelsConfirmOpen: false,
	resetConfirmOpen: false,
};

function OllamaCleanupToggle({
	checked,
	description,
	onCheckedChange,
	title,
}: {
	checked: boolean;
	description: string;
	onCheckedChange: (checked: boolean) => void;
	title: string;
}) {
	return (
		<div className="flex items-start justify-between gap-4 rounded-md border border-divider bg-foreground/5 p-3">
			<div className="flex min-w-0 flex-col gap-1">
				<span className="font-medium text-body text-foreground">{title}</span>
				<span className="text-body text-foreground-muted">{description}</span>
			</div>
			<Toggle
				aria-label={title}
				checked={checked}
				onCheckedChange={onCheckedChange}
			/>
		</div>
	);
}

function resetSectionReducer(
	state: ResetSectionState,
	action: ResetSectionAction,
): ResetSectionState {
	switch (action.type) {
		case "resetConfirmOpenChanged":
			return { ...state, resetConfirmOpen: action.open };
		case "removeModelsConfirmOpenChanged":
			return { ...state, removeModelsConfirmOpen: action.open };
		case "removeConfirmOpenChanged":
			return { ...state, removeConfirmOpen: action.open };
		case "deleteOllamaModelsWithModelCleanupChanged":
			return {
				...state,
				deleteOllamaModelsWithModelCleanup: action.checked,
			};
		case "deleteOllamaModelsChanged":
			return { ...state, deleteOllamaModels: action.checked };
		case "modelCleanupErrorChanged":
			return { ...state, modelCleanupError: action.error };
		case "cleanupErrorChanged":
			return { ...state, cleanupError: action.error };
	}
}

export function ResetSection(): ReactNode {
	const resetSettings = useSettingsStore((s) => s.resetSettings);
	const ts = useTranslations("settings");
	const tc = useTranslations("common");
	const [state, dispatch] = useReducer(
		resetSectionReducer,
		INITIAL_RESET_SECTION_STATE,
	);
	const {
		cleanupError,
		deleteOllamaModels,
		deleteOllamaModelsWithModelCleanup,
		modelCleanupError,
		removeConfirmOpen,
		removeModelsConfirmOpen,
		resetConfirmOpen,
	} = state;

	const handleRemoveDownloadedModels = () => {
		dispatch({ type: "modelCleanupErrorChanged", error: "" });
		removeDownloadedModels(deleteOllamaModelsWithModelCleanup)
			.then((result) => {
				const issues = [...result.errors, ...result.ollamaErrors];
				if (issues.length > 0) {
					dispatch({
						type: "modelCleanupErrorChanged",
						error: issues.join("\n"),
					});
					dispatch({ type: "removeModelsConfirmOpenChanged", open: true });
				}
			})
			.catch((err) => {
				dispatch({
					type: "modelCleanupErrorChanged",
					error: err instanceof Error ? err.message : String(err),
				});
				dispatch({ type: "removeModelsConfirmOpenChanged", open: true });
			});
	};

	const handleRemoveApplicationData = () => {
		dispatch({ type: "cleanupErrorChanged", error: "" });
		removeApplicationData(deleteOllamaModels).catch((err) => {
			dispatch({
				type: "cleanupErrorChanged",
				error: err instanceof Error ? err.message : String(err),
			});
			dispatch({ type: "removeConfirmOpenChanged", open: true });
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
				onOpenChange={(open) =>
					dispatch({ type: "resetConfirmOpenChanged", open })
				}
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
						<OllamaCleanupToggle
							checked={deleteOllamaModelsWithModelCleanup}
							description={ts("removeApplicationDataOllamaDescription")}
							onCheckedChange={(checked) =>
								dispatch({
									type: "deleteOllamaModelsWithModelCleanupChanged",
									checked,
								})
							}
							title={ts("removeApplicationDataOllama")}
						/>
						{modelCleanupError ? (
							<p className="whitespace-pre-line text-body text-error">
								{modelCleanupError}
							</p>
						) : null}
					</div>
				}
				onConfirm={handleRemoveDownloadedModels}
				onOpenChange={(open) =>
					dispatch({ type: "removeModelsConfirmOpenChanged", open })
				}
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
						<OllamaCleanupToggle
							checked={deleteOllamaModels}
							description={ts("removeApplicationDataOllamaDescription")}
							onCheckedChange={(checked) =>
								dispatch({ type: "deleteOllamaModelsChanged", checked })
							}
							title={ts("removeApplicationDataOllama")}
						/>
						{cleanupError ? (
							<p className="text-body text-error">{cleanupError}</p>
						) : null}
					</div>
				}
				onConfirm={handleRemoveApplicationData}
				onOpenChange={(open) =>
					dispatch({ type: "removeConfirmOpenChanged", open })
				}
				open={removeConfirmOpen}
				title={ts("removeApplicationDataTitle")}
			/>
			<SettingSection
				description={ts("applicationDataDescription")}
				divided
				icon={Delete02Icon}
				title={ts("applicationDataTitle")}
			>
				<AppDataUsageBreakdown />
				<AboutActionRow
					buttonLabel={ts("removeDownloadedModelsButton")}
					icon={PackageRemoveIcon}
					onClick={() => {
						dispatch({ type: "modelCleanupErrorChanged", error: "" });
						dispatch({ type: "removeModelsConfirmOpenChanged", open: true });
					}}
					summary={ts("removeDownloadedModelsSummary")}
					title={ts("removeDownloadedModelsButton")}
				/>
				<AboutActionRow
					buttonLabel={ts("removeApplicationDataButton")}
					destructive
					icon={Delete02Icon}
					onClick={() => {
						dispatch({ type: "cleanupErrorChanged", error: "" });
						dispatch({ type: "removeConfirmOpenChanged", open: true });
					}}
					summary={ts("removeApplicationDataSummary")}
					title={ts("removeApplicationDataButton")}
				/>
			</SettingSection>
			<SettingSection
				description={ts("resetDefaultsSummary")}
				icon={ArrowTurnBackwardIcon}
				title={ts("resetDefaultsTitle")}
			>
				<AboutActionRow
					buttonLabel={ts("resetDefaults")}
					icon={ArrowTurnBackwardIcon}
					onClick={() =>
						dispatch({ type: "resetConfirmOpenChanged", open: true })
					}
					summary={ts("resetDefaultsSummary")}
					title={ts("resetDefaults")}
				/>
			</SettingSection>
		</>
	);
}
