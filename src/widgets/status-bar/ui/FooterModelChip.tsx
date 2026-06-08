import { Button as BaseButton } from "@base-ui/react/button";
import {
	AiAudioIcon,
	AiCloud01Icon,
	ArrowDown01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
// Deep-import the lightweight STT label helpers (not the `@picker` barrel) so
// the heavy SttModelSelector / Ollama / OpenRouter / TTS picker UI trees are
// not dragged into the `main` window's chunk — StatusBar only needs these two
// helpers, and the barrel re-export would otherwise pull the whole
// model-picker package into the main entry.
import {
	getFamilyConfig,
	variantDisplayName,
} from "@picker/stt/lib/family-helpers";
import { formatModelName } from "@picker/lib/model-selector-utils";
import { type MouseEvent, type ReactNode, useEffect, useRef } from "react";
import { useTranslations } from "use-intl";
import {
	providerDisplayName,
	providerOf,
	useOpenRouterSttCatalogStore,
} from "@/entities/cloud-stt-provider";
import { useCatalogStore } from "@/entities/model-catalog";
import { useSettingsStore } from "@/entities/setting";
import { IPC } from "@/shared/api/ipc-channels";
import { ipcSend } from "@/shared/api/ipc-client";
import type { OpenRouterSttModel } from "@/shared/api/models";
import { createProviderIconResolver } from "@/shared/lib/provider-icon-resolver";
import { surfaceHoverBg, useSurface } from "@/shared/lib/surface";
import { Tooltip } from "@/shared/ui/tooltip";
import { FOOTER_TOOLTIP_DELAY } from "./FooterMenuChip";

interface FooterModelChipProps {
	ariaLabel: string;
	icon?: IconSvgElement;
	label: string;
	/** Public path to the model maker's brand logo. When set, the logo is
	 *  rendered recolored to the footer's dim gray (alpha-masked) in place of
	 *  the HugeIcon, so the chip shows the model's own mark while staying
	 *  monochrome with the rest of the footer. */
	logoSrc?: string | undefined;
	tooltip: string;
}

/** Leading glyph for the footer model chip. When a brand `logoSrc` is bundled
 *  for the family, the logo is painted in the footer's dim gray via a CSS alpha
 *  mask (the logo's own colors are discarded — only its silhouette shows), so
 *  it matches the surrounding monochrome footer. Otherwise the family's
 *  HugeIcon is shown in the same gray. */
function FooterModelGlyph({
	icon,
	logoSrc,
}: {
	icon: IconSvgElement;
	logoSrc?: string | undefined;
}): ReactNode {
	if (logoSrc) {
		return (
			<span
				aria-hidden="true"
				className="size-[11px] shrink-0 bg-foreground-dim"
				data-logo-src={logoSrc}
				style={{
					maskImage: `url("${logoSrc}")`,
					maskPosition: "center",
					maskRepeat: "no-repeat",
					maskSize: "contain",
					WebkitMaskImage: `url("${logoSrc}")`,
					WebkitMaskPosition: "center",
					WebkitMaskRepeat: "no-repeat",
					WebkitMaskSize: "contain",
				}}
			/>
		);
	}
	return (
		<HugeiconsIcon
			aria-hidden="true"
			color="var(--color-foreground-dim)"
			icon={icon}
			size={11}
		/>
	);
}

/** Same outer shape as the old footer select chip (icon · name · chevron),
 *  but clicking it opens the detached model-picker window — the only way
 *  the full picker can be shown without being clipped by the 420×150 main
 *  window. Sends its own viewport rect so the window anchors above it. */
const CHIP_SLOT = '[data-slot="stt-model-selector-trigger"]';
const OPENROUTER_SELECTION_PREFIX = "openrouter:";
const resolveFooterProviderIcon = createProviderIconResolver({
	meta: "meta-llama",
	mistral: "mistralai",
	xai: "x-ai",
});

function stripOpenrouterPrefix(modelId: string): string {
	return modelId.startsWith(OPENROUTER_SELECTION_PREFIX)
		? modelId.slice(OPENROUTER_SELECTION_PREFIX.length)
		: modelId;
}

function parseOpenrouterModelId(modelId: string): {
	maker?: string;
	modelName: string;
} {
	const parts = modelId.split("/").filter(Boolean);
	if (parts.length <= 1) {
		return { modelName: parts[0] ?? modelId };
	}
	return {
		maker: (parts[0] as string).replace(/^~+/, ""),
		modelName: parts.slice(1).join("/"),
	};
}

function resolveOpenrouterFooterModel(
	currentModel: string,
	models: readonly OpenRouterSttModel[],
): { label: string; logoSrc?: string } {
	const bareId = stripOpenrouterPrefix(currentModel);
	const catalogModel = models.find((model) => model.id === bareId);
	const parsed = parseOpenrouterModelId(catalogModel?.id ?? bareId);
	const label =
		formatModelName(parsed.modelName, parsed.maker) ||
		formatModelName(catalogModel?.name ?? "", parsed.maker) ||
		currentModel;
	const logoSrc = parsed.maker ? resolveFooterProviderIcon(parsed.maker) : null;
	return {
		label,
		...(logoSrc ? { logoSrc } : {}),
	};
}

function FooterModelChip({
	ariaLabel,
	label,
	tooltip,
	icon = AiAudioIcon,
	logoSrc,
}: FooterModelChipProps): ReactNode {
	const substrate = useSurface();
	const hoverLevel = Math.min(substrate + 2, 8);
	// The picker is a separate always-on-top window; clicking back into THIS
	// (main) window doesn't reliably blur it, so OS-focus alone can't dismiss
	// it. Any pointer-down anywhere in the app that isn't the chip itself is
	// "clicked outside the popup" → tell main to close. Main no-ops the
	// message when the picker isn't shown, so the open flag is just a cheap
	// guard to avoid sending on every idle click.
	const openRef = useRef(false);
	const openModelPicker = (e: MouseEvent<HTMLButtonElement>) => {
		const r = e.currentTarget.getBoundingClientRect();
		ipcSend(IPC.MODEL_PICKER_OPEN, {
			x: r.x,
			y: r.y,
			width: r.width,
			height: r.height,
		});
		openRef.current = true;
	};
	useEffect(() => {
		const onPointerDown = (e: PointerEvent) => {
			const target = e.target as HTMLElement | null;
			if (target?.closest(CHIP_SLOT)) {
				return; // the chip toggles itself via main
			}
			if (openRef.current) {
				openRef.current = false;
				ipcSend(IPC.MODEL_PICKER_CLOSE);
			}
		};
		window.addEventListener("pointerdown", onPointerDown, true);
		return () => window.removeEventListener("pointerdown", onPointerDown, true);
	}, []);
	return (
		<Tooltip content={tooltip} delay={FOOTER_TOOLTIP_DELAY} side="top">
			<BaseButton
				aria-label={ariaLabel}
				className={`flex max-w-full cursor-pointer select-none items-center gap-1 rounded-xs bg-transparent px-1 py-[1px] text-2xs text-foreground-dim outline-none transition-colors ${surfaceHoverBg(hoverLevel)} focus-visible:ring-1 focus-visible:ring-accent`}
				data-slot="stt-model-selector-trigger"
				onClick={openModelPicker}
				type="button"
			>
				<FooterModelGlyph icon={icon} logoSrc={logoSrc} />
				<span className="min-w-0 truncate">{label}</span>
				<HugeiconsIcon
					aria-hidden="true"
					className="shrink-0 text-foreground-dim"
					icon={ArrowDown01Icon}
					size={11}
				/>
			</BaseButton>
		</Tooltip>
	);
}

interface ActiveModelChipProps {
	currentModel: string;
	tIntegrations: ReturnType<typeof useTranslations>;
	tModel: ReturnType<typeof useTranslations>;
	tStatus: ReturnType<typeof useTranslations>;
}

/**
 * Renders the footer model chip with cloud or local affordances. Pulled
 * out of `StatusBar` to keep the parent under Biome's cognitive-complexity
 * cap — the cloud branch reads several store fields and computes a
 * localized tooltip string, all of which counted against the parent.
 */
export function ActiveModelChip({
	currentModel,
	tModel,
	tStatus,
	tIntegrations,
}: ActiveModelChipProps): ReactNode {
	const cloudProvider = providerOf(currentModel);
	const getModel = useCatalogStore((s) => s.getModel);
	const catalogModels = useCatalogStore((s) => s.models);
	const openrouterModels = useOpenRouterSttCatalogStore((s) => s.models);
	// OpenRouter STT shares the LLM key and has no `integrations.*` entry (so no
	// persisted `verified` flag) — treat it as unverified/unknown rather than
	// indexing a missing provider.
	const cloudVerified = useSettingsStore((s) =>
		cloudProvider && cloudProvider !== "openrouter"
			? s.settings.integrations[cloudProvider].verified
			: null,
	);
	// The footer chip shows the size-free variant name so the always-visible
	// main window matches the detached picker + settings tab (e.g.
	// "nemo-canary-180m-flash" → "Canary Flash"). The full catalog name lives
	// on the tooltip; the raw id is the fallback for cloud / boot-race ids the
	// catalog doesn't know about.
	const modelInfo = getModel(currentModel);
	const label = modelInfo
		? variantDisplayName(modelInfo, catalogModels)
		: currentModel;
	// Local models lead with their maker's brand logo — recolored to the
	// footer's dim gray (alpha-masked) in FooterModelGlyph — instead of a
	// generic audio glyph. Families without a bundled logo fall back to their
	// family HugeIcon (still more specific than the old generic icon).
	const familyConfig = modelInfo ? getFamilyConfig(modelInfo.family) : null;
	if (cloudProvider) {
		const cloudDisplay =
			cloudProvider === "openrouter"
				? resolveOpenrouterFooterModel(currentModel, openrouterModels)
				: null;
		const status =
			cloudVerified === true
				? tIntegrations("providerStatusValid")
				: tIntegrations("providerStatusNotVerified");
		return (
			<FooterModelChip
				ariaLabel={tModel("model")}
				icon={AiCloud01Icon}
				label={cloudDisplay?.label ?? label}
				logoSrc={cloudDisplay?.logoSrc}
				tooltip={tIntegrations("providerStatus", {
					provider: providerDisplayName(cloudProvider),
					status,
				})}
			/>
		);
	}
	return (
		<FooterModelChip
			ariaLabel={tModel("model")}
			icon={familyConfig?.icon ?? AiAudioIcon}
			label={label}
			logoSrc={familyConfig?.logoSrc}
			tooltip={tStatus("modelTooltip", {
				model: modelInfo?.displayName ?? currentModel,
			})}
		/>
	);
}
