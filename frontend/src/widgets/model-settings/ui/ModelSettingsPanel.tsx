"use client";

import { useCallback } from "react";
import { SettingSection } from "@/entities/setting";
import { useConnectionStore } from "@/features/connect-server";
import { useSettingsStore } from "@/features/update-settings";

import { COMPUTE_TYPES, LANGUAGES, WHISPER_MODELS } from "@/shared/config/defaults";
import { FormControl } from "@/shared/ui/form-control";
import { NumberStepper } from "@/shared/ui/number-stepper";
import { SearchableSelect } from "@/shared/ui/searchable-select";
import { Select } from "@/shared/ui/select";

function toOpts(items: readonly string[]) {
	return items.map((v) => ({ id: v, label: v }));
}

const MODEL_OPTS = toOpts(WHISPER_MODELS);
const COMPUTE_OPTS = toOpts(COMPUTE_TYPES);
const LANG_OPTS = LANGUAGES.map((l) => ({ id: l.code, label: l.name }));
const ALL_DEVICE_OPTS = [
	{ id: "auto", label: "Auto" },
	{ id: "cpu", label: "CPU" },
];
const CPU_ONLY_OPTS = [{ id: "cpu", label: "CPU" }];

export function ModelSettingsPanel() {
	const model = useSettingsStore((s) => s.settings.model);
	const update = useSettingsStore((s) => s.updateModelSettings);
	const gpuInfo = useConnectionStore((s) => s.gpuInfo);
	const gpuAvailable = gpuInfo?.available ?? true;
	const deviceOpts = gpuAvailable ? ALL_DEVICE_OPTS : CPU_ONLY_OPTS;
	const deviceValue = gpuAvailable ? (model?.device ?? "auto") : "cpu";

	const handleModelChange = useCallback(
		(v: string) => {
			update({ model: v as (typeof WHISPER_MODELS)[number] });
		},
		[update]
	);

	return (
		<div className="flex flex-col gap-5">
			<SettingSection title="Main Model">
				<div className="grid grid-cols-2 gap-x-4 gap-y-3 py-2">
					<FormControl
						caption="Whisper model for final transcription"
						label="Model"
						tooltip="The Whisper AI model used for final transcription. Larger models (large-v2) are more accurate but use more memory and are slower. Smaller models (tiny, base) are faster but less accurate."
					>
						<SearchableSelect
							onChange={handleModelChange}
							options={MODEL_OPTS}
							value={model?.model ?? "large-v2"}
						/>
					</FormControl>
					<FormControl caption="Transcription language" label="Language">
						<Select
							onChange={(v) => update({ language: v })}
							options={LANG_OPTS}
							value={model?.language ?? "en"}
						/>
					</FormControl>
					<FormControl
						caption="Quantization for inference"
						label="Compute Type"
						tooltip="Controls numerical precision during inference. 'float16' is faster on GPU with minimal quality loss. 'int8' uses less memory. 'default' lets the system choose the best option for your hardware."
					>
						<Select
							onChange={(v) => update({ computeType: v as (typeof COMPUTE_TYPES)[number] })}
							options={COMPUTE_OPTS}
							value={model?.computeType ?? "default"}
						/>
					</FormControl>
					<FormControl
						caption={gpuAvailable ? "Auto uses GPU when available" : "No GPU detected"}
						label="Device"
					>
						<Select
							onChange={(v) => update({ device: v as "auto" | "cpu" })}
							options={deviceOpts}
							value={deviceValue}
						/>
					</FormControl>
					<FormControl
						caption="Search width for main model"
						label="Beam Size"
						tooltip="Number of candidate transcriptions evaluated simultaneously. Higher values improve accuracy but increase processing time. Default of 5 is a good balance for most use cases."
					>
						<NumberStepper
							max={20}
							min={1}
							onChange={(v) => update({ beamSize: v })}
							step={1}
							value={model?.beamSize ?? 5}
						/>
					</FormControl>
				</div>
			</SettingSection>

			<SettingSection title="Realtime Model">
				<div className="grid grid-cols-2 gap-x-4 gap-y-3 py-2">
					<FormControl
						caption="Smaller model for live preview"
						label="Realtime Model"
						tooltip="A separate, smaller model used for live preview while you speak. Runs in parallel with the main model to provide instant feedback without affecting final transcription quality."
					>
						<SearchableSelect
							onChange={(v) => update({ realtimeModel: v as (typeof WHISPER_MODELS)[number] })}
							options={MODEL_OPTS}
							value={model?.realtimeModel ?? "tiny"}
						/>
					</FormControl>
					<FormControl
						caption="Search width for realtime"
						label="Realtime Beam Size"
						tooltip="Beam size for the realtime preview model. Lower values give faster live feedback at the cost of some accuracy. This only affects the live preview, not the final transcription."
					>
						<NumberStepper
							max={20}
							min={1}
							onChange={(v) => update({ beamSizeRealtime: v })}
							step={1}
							value={model?.beamSizeRealtime ?? 3}
						/>
					</FormControl>
				</div>
			</SettingSection>
			<SettingSection title="Large Language Model">
				<div className="flex items-center justify-center py-8">
					<p className="font-mono text-foreground-muted text-sm">Coming soon</p>
				</div>
			</SettingSection>
		</div>
	);
}
