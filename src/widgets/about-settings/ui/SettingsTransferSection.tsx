import { FileExportIcon, FileImportIcon } from "@hugeicons/core-free-icons";
import { type ReactNode, useReducer } from "react";
import { useTranslations } from "use-intl";
import {
	commands,
	type Result,
	type SettingsImportResult,
	type SettingsRestoreItem,
} from "@/bindings";
import { SettingSection, useSettingsStore } from "@/entities/setting";
import { settingsLoadStrict } from "@/shared/api/ipc-client";
import { ConfirmDialog } from "@/shared/ui/confirm-dialog";
import { DialogActionButton, DialogClose } from "@/shared/ui/dialog";
import { DialogShell } from "@/shared/ui/dialog-shell";
import { AboutActionRow } from "./AboutActionRow";

function unwrapCommand<T>(result: Result<T, string>): T {
	if (result.status === "error") {
		throw new Error(String(result.error || "Command failed"));
	}
	return result.data;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

type SettingsSnapshot = Awaited<ReturnType<typeof settingsLoadStrict>>;

type ExportOutcome = { ok: true } | { message: string; ok: false };

type ImportOutcome =
	| { status: "cancelled" }
	| { message: string; status: "failed" }
	| {
			report: SettingsImportResult;
			settings: SettingsSnapshot;
			status: "imported";
	  };

async function runSettingsExport(
	failureMessage: string,
): Promise<ExportOutcome> {
	try {
		const result = unwrapCommand(await commands.settingsExportFull());
		if (!result.cancelled && !result.ok) {
			return { message: result.error ?? failureMessage, ok: false };
		}
		return { ok: true };
	} catch (error) {
		return { message: errorMessage(error), ok: false };
	}
}

async function runSettingsImport(
	failureMessage: string,
): Promise<ImportOutcome> {
	try {
		const result = unwrapCommand(await commands.settingsImportFull());
		if (result.cancelled) {
			return { status: "cancelled" };
		}
		if (!result.ok) {
			return {
				message: result.error ?? failureMessage,
				status: "failed",
			};
		}
		const settings = await settingsLoadStrict();
		return { report: result, settings, status: "imported" };
	} catch (error) {
		return { message: errorMessage(error), status: "failed" };
	}
}

interface TransferState {
	exporting: boolean;
	importing: boolean;
	importConfirmOpen: boolean;
	importReport: SettingsImportResult | null;
	errorTitle: string;
	errorMessageText: string | null;
}

type TransferAction =
	| { type: "exportStarted" }
	| { type: "exportFinished" }
	| { type: "importStarted" }
	| { type: "importFinished" }
	| { type: "transferFailed"; title: string; message: string }
	| { type: "importSucceeded"; report: SettingsImportResult }
	| { type: "importReportClosed" }
	| { type: "errorDismissed" }
	| { type: "importConfirmOpenChanged"; open: boolean };

const INITIAL_TRANSFER_STATE: TransferState = {
	exporting: false,
	importing: false,
	importConfirmOpen: false,
	importReport: null,
	errorTitle: "",
	errorMessageText: null,
};

function transferReducer(
	state: TransferState,
	action: TransferAction,
): TransferState {
	switch (action.type) {
		case "exportStarted":
			return { ...state, exporting: true, errorMessageText: null };
		case "exportFinished":
			return { ...state, exporting: false };
		case "importStarted":
			return { ...state, importing: true, errorMessageText: null };
		case "importFinished":
			return { ...state, importing: false };
		case "transferFailed":
			return {
				...state,
				errorTitle: action.title,
				errorMessageText: action.message,
			};
		case "importSucceeded":
			return { ...state, importReport: action.report };
		case "importReportClosed":
			return { ...state, importReport: null };
		case "errorDismissed":
			return { ...state, errorMessageText: null };
		case "importConfirmOpenChanged":
			return { ...state, importConfirmOpen: action.open };
		default:
			return state;
	}
}

function ReportList({
	emptyText,
	items,
}: {
	emptyText: string;
	items: SettingsRestoreItem[];
}) {
	if (items.length === 0) {
		return <p className="text-body text-foreground-muted">{emptyText}</p>;
	}
	return (
		<ul className="flex max-h-40 flex-col gap-1.5 overflow-y-auto pr-1">
			{items.map((item) => (
				<li
					className="rounded-md bg-foreground/[0.04] px-2.5 py-2"
					key={`${item.area}:${item.message}`}
				>
					<p className="font-medium text-body text-foreground">{item.area}</p>
					<p className="text-body-sm text-foreground-muted">{item.message}</p>
				</li>
			))}
		</ul>
	);
}

function ImportReportDialog({
	onOpenChange,
	open,
	result,
}: {
	onOpenChange: (open: boolean) => void;
	open: boolean;
	result: SettingsImportResult | null;
}) {
	const t = useTranslations("settings");
	if (!result) {
		return null;
	}
	return (
		<DialogShell
			body={
				<div className="flex flex-col gap-4">
					<div>
						<p className="mb-2 font-medium text-body text-foreground">
							{t("settingsImportReportRestored")}
						</p>
						<ReportList
							emptyText={t("settingsImportReportNone")}
							items={result.restored}
						/>
					</div>
					<div>
						<p className="mb-2 font-medium text-body text-foreground">
							{t("settingsImportReportAdjusted")}
						</p>
						<ReportList
							emptyText={t("settingsImportReportNoAdjustments")}
							items={result.adjusted}
						/>
					</div>
				</div>
			}
			description={t("settingsImportReportDescription")}
			onOpenChange={onOpenChange}
			open={open}
			title={t("settingsImportReportTitle")}
			width={520}
		>
			<DialogClose
				render={
					<DialogActionButton variant="accent">
						{t("settingsImportReportClose")}
					</DialogActionButton>
				}
			/>
		</DialogShell>
	);
}

function TransferErrorDialog({
	message,
	onOpenChange,
	title,
}: {
	message: string | null;
	onOpenChange: (open: boolean) => void;
	title: string;
}) {
	const commonT = useTranslations("common");
	if (!message) {
		return null;
	}
	return (
		<DialogShell
			description={message}
			onOpenChange={onOpenChange}
			open={message !== null}
			title={title}
		>
			<DialogClose
				render={
					<DialogActionButton variant="neutral">
						{commonT("close")}
					</DialogActionButton>
				}
			/>
		</DialogShell>
	);
}

export function SettingsTransferSection(): ReactNode {
	// 'use no memo' — handleExport / handleImportConfirm contain try/catch/finally
	// the React Compiler cannot memoize yet (react-hooks-js/todo). The error
	// handling is load-bearing and the closures capture component scope, so the
	// bodies cannot be hoisted out; the consolidated reducer below keeps renders
	// low even without the compiler.
	"use no memo";
	const settingsT = useTranslations("settings");
	const commonT = useTranslations("common");
	const [state, dispatch] = useReducer(transferReducer, INITIAL_TRANSFER_STATE);
	const {
		exporting,
		importing,
		importConfirmOpen,
		importReport,
		errorMessageText,
		errorTitle,
	} = state;

	const handleExport = () => {
		const failureTitle = settingsT("settingsExportFailed");
		dispatch({ type: "exportStarted" });
		void runSettingsExport(failureTitle)
			.then((result) => {
				if (result.ok) {
					return;
				}
				dispatch({
					type: "transferFailed",
					title: failureTitle,
					message: result.message,
				});
			})
			.finally(() => {
				dispatch({ type: "exportFinished" });
			});
	};

	const handleImportConfirm = () => {
		const failureTitle = settingsT("settingsImportFailed");
		dispatch({ type: "importStarted" });
		void runSettingsImport(failureTitle)
			.then((result) => {
				switch (result.status) {
					case "cancelled":
						return;
					case "failed":
						dispatch({
							type: "transferFailed",
							title: failureTitle,
							message: result.message,
						});
						return;
					case "imported":
						useSettingsStore.getState().setSettings(result.settings);
						dispatch({ type: "importSucceeded", report: result.report });
						return;
				}
			})
			.finally(() => {
				dispatch({ type: "importFinished" });
			});
	};

	return (
		<>
			<ConfirmDialog
				cancelLabel={commonT("cancel")}
				confirmLabel={settingsT("settingsImportConfirm")}
				description={settingsT("settingsImportConfirmDescription")}
				onConfirm={handleImportConfirm}
				onOpenChange={(open) =>
					dispatch({ open, type: "importConfirmOpenChanged" })
				}
				open={importConfirmOpen}
				title={settingsT("settingsImportConfirmTitle")}
			/>
			<ImportReportDialog
				onOpenChange={(open) => {
					if (!open) {
						dispatch({ type: "importReportClosed" });
					}
				}}
				open={importReport !== null}
				result={importReport}
			/>
			<TransferErrorDialog
				message={errorMessageText}
				onOpenChange={(open) => {
					if (!open) {
						dispatch({ type: "errorDismissed" });
					}
				}}
				title={errorTitle}
			/>
			<SettingSection
				divided
				icon={FileExportIcon}
				title={`${settingsT("settingsExport")} / ${settingsT("settingsImport")}`}
			>
				<AboutActionRow
					buttonLabel={settingsT("settingsExport")}
					disabled={exporting || importing}
					icon={FileExportIcon}
					iconClassName={exporting ? "animate-spin" : undefined}
					onClick={handleExport}
					title={settingsT("settingsExport")}
				/>
				<AboutActionRow
					buttonLabel={settingsT("settingsImport")}
					disabled={exporting || importing}
					icon={FileImportIcon}
					iconClassName={importing ? "animate-spin" : undefined}
					onClick={() =>
						dispatch({ open: true, type: "importConfirmOpenChanged" })
					}
					title={settingsT("settingsImport")}
				/>
			</SettingSection>
		</>
	);
}
