"use client";

import { useTranslations } from "next-intl";
import { useEffect } from "react";
import { useLlmCatalogStore } from "@/entities/llm-catalog";
import { SettingSection } from "@/entities/setting";
import { useSettingsStore } from "@/features/update-settings";
import { Button } from "@/shared/ui/button";
import { FormControl } from "@/shared/ui/form-control";
import { SearchableSelect } from "@/shared/ui/searchable-select";
import { Switcher } from "@/shared/ui/switcher";
import { TextField } from "@/shared/ui/text-field";

export function LlmSettingsPanel() {
	const llm = useSettingsStore((s) => s.settings.llm);
	const update = useSettingsStore((s) => s.updateLlmSettings);
	const t = useTranslations("llm");
	const tc = useTranslations("common");

	const { models, isLoaded, isScanning, error, scanModels } = useLlmCatalogStore();

	useEffect(() => {
		if (!isLoaded) {
			scanModels();
		}
	}, [isLoaded, scanModels]);

	const modelOpts = models.map((m) => ({
		id: m.name,
		label: `${m.name} (${(m.size / 1e9).toFixed(1)} GB)`,
	}));

	const presetOpts = [
		{ value: "neutral", label: t("presetNeutral") },
		{ value: "formal", label: t("presetFormal") },
		{ value: "friendly", label: t("presetFriendly") },
		{ value: "technical", label: t("presetTechnical") },
		{ value: "casual", label: t("presetCasual") },
		{ value: "concise", label: t("presetConcise") },
	] as const;

	const enabled = llm?.enabled ?? false;
	const endpoint = llm?.endpoint ?? "http://localhost:11434";
	const model = llm?.model ?? "";
	const preset = llm?.preset ?? "neutral";

	return (
		<div className="flex flex-col gap-5">
			<SettingSection onToggle={(v) => update({ enabled: v })} title={t("title")} toggled={enabled}>
				<div className="grid grid-cols-2 gap-x-4 gap-y-3 py-2">
					<FormControl
						caption={t("endpointCaption")}
						label={t("endpoint")}
						tooltip={t("endpointTooltip")}
					>
						<TextField
							onChange={(e) => update({ endpoint: e.target.value })}
							placeholder="http://localhost:11434"
							value={endpoint}
						/>
					</FormControl>

					<FormControl caption={t("modelCaption")} label={t("model")} tooltip={t("modelTooltip")}>
						<div className="flex gap-2">
							<div className="flex-1">
								<SearchableSelect
									onChange={(v) => update({ model: v })}
									options={modelOpts}
									value={model}
								/>
							</div>
							<Button
								className="h-8 rounded-md border border-border bg-surface-secondary px-3 font-medium text-[13px] transition-colors duration-150 hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-40"
								disabled={isScanning}
								onClick={scanModels}
							>
								{isScanning ? tc("scanning") : tc("refresh")}
							</Button>
						</div>
					</FormControl>

					<div className="col-span-2">
						<FormControl
							caption={t("presetCaption")}
							label={t("preset")}
							tooltip={t("presetTooltip")}
						>
							<Switcher
								onChange={(v) => update({ preset: v })}
								options={presetOpts}
								value={preset}
							/>
						</FormControl>
					</div>

					{error && (
						<div className="col-span-2 rounded bg-error/10 p-3 text-error text-sm">{error}</div>
					)}
				</div>
			</SettingSection>
		</div>
	);
}
