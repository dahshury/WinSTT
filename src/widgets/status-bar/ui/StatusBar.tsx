import { Separator } from "@base-ui/react/separator";
import { Mic01Icon } from "@hugeicons/core-free-icons";
// Deep-import the lightweight STT label helpers (not the `@/widgets/model-picker` barrel) so
// the heavy SttModelSelector / Ollama / OpenRouter / TTS picker UI trees are
// not dragged into the `main` window's chunk — StatusBar only needs these two
// helpers, and the barrel re-export would otherwise pull the whole
// model-picker package into the main entry.
import { variantDisplayName } from "@/widgets/model-picker/stt/lib/family-helpers";
import { useTranslations } from "use-intl";
import {
	applyDeviceSelection,
	buildInputDeviceOptions,
	priorityFromReorderedOptions,
	useInputDevices,
} from "@/entities/audio-device";
import { useCatalogStore, useModelSwapStore } from "@/entities/model-catalog";
import { useSettingsStore } from "@/entities/setting";
import { ConnectionIndicator } from "@/features/connect-server";
import { useListenStore } from "@/features/listen-mode";
import {
	useDownloadAggregate,
	useDownloadStore,
} from "@/features/model-download";
import { surfaceClasses, useSurface } from "@/shared/lib/surface";
import { Tooltip } from "@/shared/ui/tooltip";
import { abbreviateDevice, shortDeviceName } from "../lib/device-name";
import { FOOTER_TOOLTIP_DELAY, FooterMenuChip } from "./FooterMenuChip";
import { ActiveModelChip } from "./FooterModelChip";
import { FooterDownloadChip, ModelSwapChip } from "./FooterStatusChips";

/** Stable fallback so the zustand selector doesn't fabricate a new `[]` per render. */
const EMPTY_PRIORITY: readonly string[] = [];

export function StatusBar() {
	const currentModel = useSettingsStore((s) => s.settings.model?.model);
	const recordingMode = useSettingsStore(
		(s) => s.settings.general?.recordingMode ?? "ptt",
	);
	const inputDeviceIndex = useSettingsStore(
		(s) => s.settings.audio?.inputDeviceIndex,
	);
	const inputDevicePriority = useSettingsStore(
		(s) => s.settings.audio?.inputDevicePriority ?? EMPTY_PRIORITY,
	);
	const updateAudio = useSettingsStore((s) => s.updateAudioSettings);
	const isListening = useListenStore((s) => s.isListening);
	const listenDeviceName = useListenStore((s) => s.deviceName);
	const isDownloading = useDownloadStore((s) => s.isDownloading);
	// Per-quant + whole-model aggregate so the footer chip can preempt the
	// idle model chip with a "↓ Model X%" / "↓ N downloads · X%" view
	// whenever bytes are streaming — visible even with the detached picker
	// dismissed, so the user can monitor progress from the main window.
	const downloadAggregate = useDownloadAggregate();
	const getCatalogModel = useCatalogStore((s) => s.getModel);
	const allCatalogModels = useCatalogStore((s) => s.models);
	const swappingMain = useModelSwapStore((s) => s.activeMain);
	const mainSwapping = swappingMain !== null;
	const t = useTranslations("statusBar");
	const tAudio = useTranslations("audio");
	const tModel = useTranslations("model");

	const { devices, defaultDevice } = useInputDevices();
	const defaultLabel = defaultDevice
		? `${tAudio("systemDefault")} (${defaultDevice.name})`
		: tAudio("systemDefault");
	const { deviceOptions, currentDeviceId, currentDeviceLabel } =
		buildInputDeviceOptions(
			devices,
			inputDeviceIndex ?? null,
			defaultLabel,
			defaultDevice?.name,
			inputDevicePriority,
		);
	const currentDeviceName =
		currentDeviceId === "default"
			? (defaultDevice?.name ?? tAudio("systemDefault"))
			: currentDeviceLabel;

	// Same semantics as the settings picker: clicking promotes the device to
	// the top of a non-empty preference order (so the click always wins);
	// "System default" clears the order.
	const handleDeviceChange = (v: string) =>
		applyDeviceSelection({
			id: v,
			onChange: (idx) => updateAudio({ inputDeviceIndex: idx }),
			onPriorityChange: (p) => updateAudio({ inputDevicePriority: p }),
			options: deviceOptions,
			priority: inputDevicePriority,
		});

	const handleDeviceReorder = (orderedIds: string[]) =>
		updateAudio({
			inputDevicePriority: priorityFromReorderedOptions(
				deviceOptions,
				orderedIds,
			),
		});

	const tIntegrations = useTranslations("integrations");

	const substrate = useSurface();
	const barLevel = Math.min(substrate + 1, 8);
	return (
		<div
			className={[
				`flex shrink-0 items-center gap-1.5 overflow-hidden whitespace-nowrap ${surfaceClasses(barLevel, 1)} py-1 pr-2 pl-3 font-mono`,
				isDownloading && "pointer-events-none opacity-50",
			]
				.filter(Boolean)
				.join(" ")}
		>
			<ConnectionIndicator />
			<div className="flex min-w-0 flex-1 items-center gap-1.5">
				<Separator
					className="h-3 w-px shrink-0 bg-border"
					orientation="vertical"
				/>
				{recordingMode === "listen" ? (
					<Tooltip
						content={
							isListening
								? t("loopbackActiveTooltip")
								: t("loopbackIdleTooltip")
						}
						delay={FOOTER_TOOLTIP_DELAY}
						side="top"
					>
						<span className="inline-flex max-w-[120px] cursor-help items-center gap-1.5 text-2xs">
							{isListening && (
								<span className="inline-block size-1.5 shrink-0 animate-pulse rounded-full bg-success" />
							)}
							<span
								className={`truncate ${isListening ? "text-success" : "text-foreground-secondary"}`}
							>
								{listenDeviceName
									? shortDeviceName(listenDeviceName)
									: t("loopbackIdle")}
							</span>
						</span>
					</Tooltip>
				) : (
					<FooterMenuChip
						ariaLabel={tAudio("inputDevice")}
						icon={Mic01Icon}
						label={abbreviateDevice(currentDeviceName)}
						onChange={handleDeviceChange}
						onReorder={handleDeviceReorder}
						options={deviceOptions}
						reorderHandleLabel={tAudio("devicePriorityHandle")}
						tooltip={currentDeviceName}
						value={currentDeviceId}
					/>
				)}
				{currentModel && (
					<>
						<Separator
							className="h-3 w-px shrink-0 bg-border"
							orientation="vertical"
						/>
						<div className="flex min-w-0 flex-1 items-center">
							{(() => {
								if (mainSwapping) {
									const swapModel = swappingMain
										? getCatalogModel(swappingMain)
										: undefined;
									const swapName = swapModel
										? variantDisplayName(swapModel, allCatalogModels)
										: (swappingMain ?? "");
									return (
										<ModelSwapChip
											label={t("switchingModel", { model: swapName })}
											tooltip={t("switchingModelTooltip", { model: swapName })}
										/>
									);
								}
								if (downloadAggregate) {
									const primaryModel = getCatalogModel(
										downloadAggregate.primary.modelId,
									);
									const primaryName = primaryModel
										? variantDisplayName(primaryModel, allCatalogModels)
										: downloadAggregate.primary.modelId;
									const tooltipKey =
										downloadAggregate.count >= 2
											? "downloadingMultiTooltip"
											: "downloadingTooltip";
									const tooltip = t(tooltipKey, {
										count: downloadAggregate.count,
										model: primaryName,
									});
									return (
										<FooterDownloadChip
											aggregate={downloadAggregate}
											ariaLabel={tModel("model")}
											primaryModelName={primaryName}
											tooltip={tooltip}
										/>
									);
								}
								return (
									<ActiveModelChip
										currentModel={currentModel}
										tIntegrations={tIntegrations}
										tModel={tModel}
										tStatus={t}
									/>
								);
							})()}
						</div>
					</>
				)}
			</div>
		</div>
	);
}
