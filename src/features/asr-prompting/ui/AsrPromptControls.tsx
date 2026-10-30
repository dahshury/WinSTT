import { useTranslations } from "use-intl";
import { useSettingsStore, useSettingsTabStore } from "@/entities/setting";
import {
	asrPromptCapability,
	nativeAsrCleanupActive,
} from "@/shared/lib/asr-prompting";
import { AutoTextarea } from "@/shared/ui/auto-textarea";
import { Button } from "@/shared/ui/button";
import { FormControl } from "@/shared/ui/form-control";
import { Switcher } from "@/shared/ui/switcher";

export function AsrPromptControls({
	disabled = false,
}: {
	disabled?: boolean;
}) {
	const model = useSettingsStore((s) => s.settings.model);
	const update = useSettingsStore((s) => s.updateModelSettings);
	const state = useSettingsStore((s) => s.settings);
	const t = useTranslations("asrPrompt");
	const capability = asrPromptCapability(model.model);
	if (capability === "none") {
		return null;
	}
	const source =
		model.asrPromptModel !== model.model ||
		(capability === "task" && model.asrPromptSource === "cleanupPresets")
			? "off"
			: model.asrPromptSource;
	const options = [
		{ value: "off", label: t("off") },
		{ value: "custom", label: t("custom") },
		...(capability === "cleanup"
			? [{ value: "cleanupPresets", label: t("presets") }]
			: []),
	];
	return (
		<div className="flex flex-col gap-3 py-3">
			<FormControl
				caption={capability === "cleanup" ? t("hint") : t("taskHint")}
				disabled={disabled}
				label={t("title")}
			>
				<Switcher
					fullWidth
					onChange={(value) => {
						if (
							value !== "off" &&
							value !== "custom" &&
							value !== "cleanupPresets"
						) {
							return;
						}
						update({
							asrPromptSource: value,
							asrPromptModel: model.model,
							asrInstruction:
								model.asrPromptModel === model.model
									? model.asrInstruction
									: "",
							asrAllowSeparateCleanup: false,
						});
						if (
							capability === "cleanup" &&
							(value === "cleanupPresets" ||
								(value === "custom" &&
									model.asrPromptModel === model.model &&
									model.asrInstruction.trim()))
						) {
							useSettingsStore
								.getState()
								.updateLlmDictation({ enabled: false });
						}
					}}
					options={options.map((option) => ({ ...option, disabled }))}
					value={source}
				/>
			</FormControl>
			{source === "custom" && (
				<FormControl disabled={disabled} label={t("instruction")}>
					<AutoTextarea
						aria-label={t("instruction")}
						disabled={disabled}
						maxLength={16_384}
						onChange={(event) => {
							const instruction = event.target.value;
							update({ asrInstruction: instruction });
							if (
								capability === "cleanup" &&
								instruction.trim() &&
								!model.asrAllowSeparateCleanup
							) {
								useSettingsStore
									.getState()
									.updateLlmDictation({ enabled: false });
							}
						}}
						value={model.asrInstruction}
					/>
				</FormControl>
			)}
			{nativeAsrCleanupActive(state) && (
				<div className="flex flex-col gap-2">
					<p className="text-xs text-foreground-muted">
						{model.asrAllowSeparateCleanup && state.llm.dictation.enabled
							? t("additionalEnabled")
							: t("additionalHint")}
					</p>
					<Button
						disabled={disabled}
						onClick={() => useSettingsTabStore.getState().setActiveTab("llm")}
						className="self-start rounded-md bg-surface-3 px-3 py-1.5 text-xs"
					>
						{t("configureCleanup")}
					</Button>
				</div>
			)}
		</div>
	);
}
