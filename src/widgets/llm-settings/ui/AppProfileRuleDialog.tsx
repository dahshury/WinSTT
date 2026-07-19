import { useState } from "react";
import { useTranslations } from "use-intl";
import type { ContextAppEntry } from "@/shared/api/ipc-client";
import { ContextAppSingleCombobox } from "@/shared/ui/context-app-combobox";
import {
	Dialog,
	DialogActionButton,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogTitle,
} from "@/shared/ui/dialog";
import {
	normalizeExeInput,
	normalizeUrlPatternInput,
	type AppProfileRule,
} from "../model/app-profile-rules";

interface AppProfileRuleDialogProps {
	apps: ContextAppEntry[];
	onClose: () => void;
	onSave: (rule: AppProfileRule) => void;
	rule: AppProfileRule;
}

const inputClass =
	"h-8 w-full rounded-lg border border-border bg-surface-2 px-2.5 text-body text-foreground outline-none focus-visible:ring-2 focus-visible:ring-accent";

export function AppProfileRuleDialog({
	apps,
	onClose,
	onSave,
	rule,
}: AppProfileRuleDialogProps) {
	const t = useTranslations("llm");
	const [appExe, setAppExe] = useState(rule.appExe);
	const [titlePattern, setTitlePattern] = useState(rule.titlePattern);
	const [urlPattern, setUrlPattern] = useState(rule.urlPattern);

	const normalized = {
		appExe: normalizeExeInput(appExe),
		titlePattern: titlePattern.trim(),
		urlPattern: normalizeUrlPatternInput(urlPattern),
	};
	const canSave = Boolean(
		normalized.appExe || normalized.titlePattern || normalized.urlPattern,
	);
	const save = () => {
		if (!canSave) {
			return;
		}
		onSave({ ...rule, ...normalized });
	};

	return (
		<Dialog onOpenChange={(next) => !next && onClose()} open>
			<DialogContent size="lg">
				<DialogTitle>{t("appProfileEditRule")}</DialogTitle>
				<DialogDescription>
					{t("appProfileDialogDescription")}
				</DialogDescription>
				<div className="grid gap-3">
					<div className="grid gap-1 font-medium text-body text-foreground-secondary">
						<span>{t("appProfileAppExe")}</span>
						<ContextAppSingleCombobox
							apps={apps}
							ariaLabel={t("appProfileAppExe")}
							emptyLabel="No matching apps. Type an executable name instead."
							onChange={setAppExe}
							placeholder={t("appProfileAppExePlaceholder")}
							value={appExe}
						/>
					</div>
					<label className="grid gap-1 font-medium text-body text-foreground-secondary">
						{t("appProfileTitlePattern")}
						<input
							aria-label={t("appProfileTitlePattern")}
							className={inputClass}
							onChange={(event) => setTitlePattern(event.target.value)}
							placeholder={t("appProfileTitlePatternPlaceholder")}
							value={titlePattern}
						/>
					</label>
					<label className="grid gap-1 font-medium text-body text-foreground-secondary">
						{t("appProfileUrlPattern")}
						<input
							aria-label={t("appProfileUrlPattern")}
							className={inputClass}
							onChange={(event) => setUrlPattern(event.target.value)}
							placeholder={t("appProfileUrlPatternPlaceholder")}
							value={urlPattern}
						/>
						<span className="font-normal text-caption text-foreground-muted">
							{t("appProfileUrlHint")}
						</span>
					</label>
					{canSave ? null : (
						<p className="text-caption text-foreground-muted">
							{t("appProfileValidation")}
						</p>
					)}
				</div>
				<DialogFooter>
					<DialogActionButton onClick={onClose}>
						{t("appProfileCancel")}
					</DialogActionButton>
					<DialogActionButton
						disabled={!canSave}
						onClick={save}
						variant="accent"
					>
						{t("appProfileSaveRule")}
					</DialogActionButton>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
