import { FileExportIcon, FileImportIcon } from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { type ReactNode, useState } from "react";
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
import { AboutActionButton } from "./AboutActionButton";

function unwrapCommand<T>(result: Result<T, string>): T {
	if (result.status === "error") {
		throw new Error(String(result.error || "Command failed"));
	}
	return result.data;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
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

function SettingsTransferRow({
	buttonLabel,
	disabled,
	icon,
	iconClassName,
	onClick,
	title,
}: {
	buttonLabel: string;
	disabled?: boolean;
	icon: IconSvgElement;
	iconClassName?: string | undefined;
	onClick: () => void;
	title: string;
}) {
	return (
		<div className="flex items-center gap-4 py-3">
			<div className="flex min-w-0 flex-1 flex-col gap-1">
				<span className="font-medium text-body text-foreground leading-tight">
					{title}
				</span>
			</div>
			<AboutActionButton
				icon={icon}
				onClick={onClick}
				{...(disabled !== undefined ? { disabled } : {})}
				{...(iconClassName !== undefined ? { iconClassName } : {})}
			>
				{buttonLabel}
			</AboutActionButton>
		</div>
	);
}

export function SettingsTransferSection(): ReactNode {
	const settingsT = useTranslations("settings");
	const commonT = useTranslations("common");
	const [exporting, setExporting] = useState(false);
	const [importing, setImporting] = useState(false);
	const [importConfirmOpen, setImportConfirmOpen] = useState(false);
	const [importReport, setImportReport] = useState<SettingsImportResult | null>(
		null,
	);
	const [errorMessageText, setErrorMessageText] = useState<string | null>(null);
	const [errorTitle, setErrorTitle] = useState("");

	const handleExport = async () => {
		setExporting(true);
		setErrorMessageText(null);
		try {
			const result = unwrapCommand(await commands.settingsExportFull());
			if (!result.cancelled && !result.ok) {
				setErrorTitle(settingsT("settingsExportFailed"));
				setErrorMessageText(result.error ?? settingsT("settingsExportFailed"));
			}
		} catch (error) {
			setErrorTitle(settingsT("settingsExportFailed"));
			setErrorMessageText(errorMessage(error));
		} finally {
			setExporting(false);
		}
	};

	const handleImportConfirm = async () => {
		setImporting(true);
		setErrorMessageText(null);
		try {
			const result = unwrapCommand(await commands.settingsImportFull());
			if (result.cancelled) {
				return;
			}
			if (!result.ok) {
				setErrorTitle(settingsT("settingsImportFailed"));
				setErrorMessageText(result.error ?? settingsT("settingsImportFailed"));
				return;
			}
			const settings = await settingsLoadStrict();
			useSettingsStore.getState().setSettings(settings);
			setImportReport(result);
		} catch (error) {
			setErrorTitle(settingsT("settingsImportFailed"));
			setErrorMessageText(errorMessage(error));
		} finally {
			setImporting(false);
		}
	};

	return (
		<>
			<ConfirmDialog
				cancelLabel={commonT("cancel")}
				confirmLabel={settingsT("settingsImportConfirm")}
				description={settingsT("settingsImportConfirmDescription")}
				onConfirm={handleImportConfirm}
				onOpenChange={setImportConfirmOpen}
				open={importConfirmOpen}
				title={settingsT("settingsImportConfirmTitle")}
			/>
			<ImportReportDialog
				onOpenChange={(open) => {
					if (!open) {
						setImportReport(null);
					}
				}}
				open={importReport !== null}
				result={importReport}
			/>
			<TransferErrorDialog
				message={errorMessageText}
				onOpenChange={(open) => {
					if (!open) {
						setErrorMessageText(null);
					}
				}}
				title={errorTitle}
			/>
			<SettingSection
				divided
				icon={FileExportIcon}
				title={`${settingsT("settingsExport")} / ${settingsT("settingsImport")}`}
			>
				<SettingsTransferRow
					buttonLabel={settingsT("settingsExport")}
					disabled={exporting || importing}
					icon={FileExportIcon}
					iconClassName={exporting ? "animate-spin" : undefined}
					onClick={handleExport}
					title={settingsT("settingsExport")}
				/>
				<SettingsTransferRow
					buttonLabel={settingsT("settingsImport")}
					disabled={exporting || importing}
					icon={FileImportIcon}
					iconClassName={importing ? "animate-spin" : undefined}
					onClick={() => setImportConfirmOpen(true)}
					title={settingsT("settingsImport")}
				/>
			</SettingSection>
		</>
	);
}
