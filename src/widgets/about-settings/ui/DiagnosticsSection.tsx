import {
	Bug01Icon,
	FileZipIcon,
	Folder01Icon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import type { ReactNode } from "react";
import { SettingSection } from "@/entities/setting";
import { diagOpenLogsFolder, diagSaveBundle } from "@/shared/api/ipc-client";
import { AboutActionButton } from "./AboutActionButton";
import type { AboutT } from "./types";

interface DiagnosticsActionRowProps {
	buttonLabel: string;
	icon: IconSvgElement;
	onClick: () => void;
	summary: string;
	title: string;
}

function DiagnosticsActionRow({
	buttonLabel,
	icon,
	onClick,
	summary,
	title,
}: DiagnosticsActionRowProps): ReactNode {
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
			<AboutActionButton icon={icon} onClick={onClick}>
				{buttonLabel}
			</AboutActionButton>
		</div>
	);
}

export function DiagnosticsSection({ t }: { t: AboutT }): ReactNode {
	const handleOpenLogsFolder = async () => {
		await diagOpenLogsFolder();
	};

	const handleSaveDiagnosticBundle = async () => {
		await diagSaveBundle();
	};

	return (
		<SettingSection
			description={t("diagnosticsDescription")}
			divided
			icon={Bug01Icon}
			title={t("diagnosticsTitle")}
		>
			<DiagnosticsActionRow
				buttonLabel={t("openLogsFolder")}
				icon={Folder01Icon}
				onClick={handleOpenLogsFolder}
				summary={t("openLogsFolderSummary")}
				title={t("openLogsFolder")}
			/>
			<DiagnosticsActionRow
				buttonLabel={t("saveDiagnosticBundleButton")}
				icon={FileZipIcon}
				onClick={handleSaveDiagnosticBundle}
				summary={t("saveDiagnosticBundleSummary")}
				title={t("saveDiagnosticBundle")}
			/>
		</SettingSection>
	);
}
