"use client";

import { Combobox } from "@base-ui/react/combobox";
import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type ComponentPropsWithoutRef, useEffect } from "react";
import { useTranslations } from "use-intl";
import { lookupModelsDev, useModelsDevStore } from "@/entities/llm-catalog";
import type { OpenRouterModel } from "@/shared/api/models";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { ModelSpecHoverCard } from "@/shared/ui/model-spec-card";
import { PulseDot } from "@/shared/ui/pulse-dot";
import { MODEL_TRIGGER_GLASS_CLASSES } from "@/shared/ui/switching-trigger";
import { buildOpenRouterSpec } from "../lib/build-openrouter-spec";
import { VariantBadge } from "@/shared/ui/model-picker/lib/model-list-meta-chips";
import { getVariantClasses } from "@/shared/ui/model-picker/lib/model-selector-display-utils";
import {
	formatMaker,
	formatModelName,
} from "@/shared/ui/model-picker/lib/model-selector-utils";
import { getProviderIconWithFallback } from "@/shared/ui/model-picker/lib/provider-icons";
import { AuthorBadge } from "@/shared/ui/model-picker/ui/AuthorBadge";
import {
	getTriggerDataState,
	isMissingModelId,
} from "./model-selector-trigger-helpers";
import { TruncatedText } from "@/shared/ui/model-picker/ui/TruncatedText";

// Glass-card trigger — shares the exact material vocabulary with the
// pill, STT picker, and settings titlebar: theme-token vertical gradient,
// hairline inset ring, inset top highlight, tinted drop shadow. Hover
// lifts a surface level; open swaps to an accent-tinted wash and reveals
// the Docker-blue hairline at the top edge.
const TRIGGER_GLASS_CLASSES = `${MODEL_TRIGGER_GLASS_CLASSES} disabled:opacity-50`;

export interface ModelSelectorTriggerProps {
	disabled: boolean;
	isLoading: boolean;
	open: boolean;
	parsedModelId: string | undefined;
	placeholder: string;
	selectedModel: OpenRouterModel | undefined;
}

function MakerBadge({ maker }: { maker: string | undefined }) {
	if (!maker) {
		return null;
	}
	return (
		<AuthorBadge
			label={formatMaker(maker)}
			logoSrc={getProviderIconWithFallback(maker)}
		/>
	);
}

function SelectedVariantBadge({
	variant,
}: {
	variant: OpenRouterModel["variant"];
}) {
	if (!variant) {
		return null;
	}
	return (
		<VariantBadge
			variant={variant}
			variantClasses={getVariantClasses(variant)}
		/>
	);
}

function SelectedModelContent({
	selectedModel,
}: {
	selectedModel: OpenRouterModel;
}) {
	// Subscribe to the index so the card re-renders once models.dev loads, and
	// kick off the (cached, offline-graceful) fetch on mount.
	const index = useModelsDevStore((s) => s.index);
	const isLoading = useModelsDevStore((s) => s.isLoading);
	const ensureLoaded = useModelsDevStore((s) => s.ensureLoaded);
	useEffect(() => {
		ensureLoaded();
	}, [ensureLoaded]);
	const enrichment = index
		? lookupModelsDev(
				index,
				selectedModel.id,
				selectedModel.model_name ?? selectedModel.name,
			)
		: null;
	const spec = buildOpenRouterSpec(selectedModel, enrichment, {
		loading: isLoading,
	});
	return (
		<ModelSpecHoverCard spec={spec}>
			<div className="flex min-w-0 flex-1 items-center gap-2">
				<MakerBadge maker={selectedModel.maker} />
				<TruncatedText
					className="min-w-0 flex-1 font-medium text-body text-foreground leading-tight tracking-tight"
					text={formatModelName(
						selectedModel.model_name ?? selectedModel.name,
						selectedModel.maker,
					)}
				/>
				<SelectedVariantBadge variant={selectedModel.variant} />
			</div>
		</ModelSpecHoverCard>
	);
}

function SelectedContent({
	selectedModel,
	parsedModelId,
	placeholder,
}: {
	selectedModel: OpenRouterModel | undefined;
	parsedModelId: string | undefined;
	placeholder: string;
}) {
	const t = useTranslations("modelPicker");
	if (selectedModel) {
		return <SelectedModelContent selectedModel={selectedModel} />;
	}

	if (isMissingModelId(parsedModelId)) {
		return (
			<div className="flex min-w-0 flex-1 items-center gap-2">
				<Badge className="shrink-0 text-2xs" variant="secondary">
					{t("openrouter")}
				</Badge>
				<span className="truncate font-medium text-body text-foreground tracking-tight">
					{t("auto")}
				</span>
			</div>
		);
	}

	return (
		<span className="font-medium text-body text-foreground-muted italic tracking-tight">
			{placeholder}
		</span>
	);
}

interface TriggerButtonProps extends ModelSelectorTriggerProps {
	buttonProps: ComponentPropsWithoutRef<"button">;
}

export function TriggerButton({
	buttonProps,
	open,
	disabled,
	isLoading,
	selectedModel,
	parsedModelId,
	placeholder,
}: TriggerButtonProps) {
	return (
		<Button
			{...buttonProps}
			aria-expanded={open}
			className={TRIGGER_GLASS_CLASSES}
			data-loading={isLoading || undefined}
			data-slot="model-selector-trigger"
			data-state={getTriggerDataState(open)}
			disabled={disabled || isLoading}
			type="button"
		>
			{/* Accent hairline — fades in only when the popup is open. Same
			    brand moment as the STT picker, the pill, and the settings
			    titlebar — one Docker-blue thread runs through every glass
			    surface in the app. */}
			<span
				aria-hidden="true"
				className="pointer-events-none absolute inset-x-3 top-0 h-px bg-gradient-to-r from-transparent via-accent/55 to-transparent opacity-0 transition-opacity duration-200 group-data-[state=open]:opacity-100"
			/>
			{isLoading ? (
				<div className="flex flex-1 items-center gap-2">
					<PulseDot className="size-2.5 text-foreground-muted" />
					<span className="font-medium text-body text-foreground-muted italic tracking-tight">
						{placeholder}
					</span>
				</div>
			) : (
				<SelectedContent
					parsedModelId={parsedModelId}
					placeholder={placeholder}
					selectedModel={selectedModel}
				/>
			)}
			<HugeiconsIcon
				className="ms-2 size-4 shrink-0 text-foreground-muted transition-[transform,color] duration-200 ease-out group-data-[state=open]:rotate-180 group-data-[state=open]:text-foreground"
				icon={ArrowDown01Icon}
			/>
		</Button>
	);
}

export function ModelSelectorTrigger({
	selectedModel,
	parsedModelId,
	placeholder,
	open,
	disabled,
	isLoading,
}: ModelSelectorTriggerProps) {
	return (
		<Combobox.Trigger
			nativeButton
			render={(props) => (
				<TriggerButton
					buttonProps={props as ComponentPropsWithoutRef<"button">}
					disabled={disabled}
					isLoading={isLoading}
					open={open}
					parsedModelId={parsedModelId}
					placeholder={placeholder}
					selectedModel={selectedModel}
				/>
			)}
		/>
	);
}
