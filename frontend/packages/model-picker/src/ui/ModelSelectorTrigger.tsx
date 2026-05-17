"use client";

import { Combobox } from "@base-ui/react/combobox";
import { ArrowDown01Icon, ServerStack01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ComponentPropsWithoutRef } from "react";
import type { OpenRouterEndpoint, OpenRouterModel } from "@/shared/api/models";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { Spinner } from "@/shared/ui/spinner";
import { formatPricing } from "../lib/model-selector-display-utils";
import { formatMaker, formatModelName } from "../lib/model-selector-utils";
import { getProviderIconWithFallback } from "../lib/provider-icons";
import { TruncatedText } from "./TruncatedText";
import { VariantBadgeIcon } from "./VariantBadgeIcon";

// Glass-card trigger — shares the exact material vocabulary with the
// pill, STT picker, and settings titlebar: theme-token vertical gradient,
// hairline inset ring, inset top highlight, tinted drop shadow. Hover
// lifts a surface level; open swaps to an accent-tinted wash and reveals
// the Docker-blue hairline at the top edge.
const TRIGGER_GLASS_CLASSES =
	"group relative flex h-auto min-h-[3.25rem] w-full items-center justify-between gap-2 overflow-hidden rounded-lg bg-gradient-to-b from-[var(--color-surface-3)]/85 to-[var(--color-surface-2)]/95 px-3 py-2 text-left shadow-[inset_0_1px_0_0_rgba(255,255,255,0.06),0_2px_6px_-3px_rgba(2,3,8,0.55)] ring-1 ring-white/[0.07] ring-inset transition-[transform,background-color,box-shadow] duration-150 ease-out hover:from-[var(--color-surface-4)]/85 hover:to-[var(--color-surface-3)]/95 hover:ring-white/[0.13] active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-50 data-[state=open]:from-[oklch(62%_0.19_260/0.10)] data-[state=open]:to-[var(--color-surface-2)]/95 data-[state=open]:ring-accent/40";

export interface ModelSelectorTriggerProps {
	disabled: boolean;
	isLoading: boolean;
	open: boolean;
	parsedModelId: string | undefined;
	placeholder: string;
	selectedEndpoint: OpenRouterEndpoint | null;
	selectedModel: OpenRouterModel | undefined;
}

export function isMissingModelId(parsedModelId: string | undefined): boolean {
	return parsedModelId === undefined || parsedModelId === "";
}

function MakerBadge({ maker }: { maker: string | undefined }) {
	if (!maker) {
		return null;
	}
	const providerIcon = getProviderIconWithFallback(maker);
	return (
		<Badge className="shrink-0 gap-1.5 text-2xs" variant="secondary">
			{providerIcon ? (
				<span className="flex size-3 shrink-0 items-center justify-center overflow-hidden rounded border border-border/50 bg-surface p-0.5">
					{/** biome-ignore lint/performance/noImgElement: Provider icons are static local PNG/SVGs served from /public; next/image adds runtime overhead for tiny 12x12 thumbnails. */}
					<img
						alt=""
						className="size-full object-contain"
						height={12}
						loading="eager"
						src={providerIcon}
						width={12}
					/>
				</span>
			) : null}
			{formatMaker(maker)}
		</Badge>
	);
}

function EndpointRow({ selectedEndpoint }: { selectedEndpoint: OpenRouterEndpoint | null }) {
	if (!selectedEndpoint) {
		return null;
	}
	return (
		<div className="flex items-center gap-2 text-foreground-muted text-xs-tight">
			<HugeiconsIcon className="size-3" icon={ServerStack01Icon} />
			<span>via {selectedEndpoint.provider_name}</span>
			<span className="opacity-60">({formatPricing(selectedEndpoint.pricing)})</span>
		</div>
	);
}

function SelectedModelContent({
	selectedModel,
	selectedEndpoint,
}: {
	selectedModel: OpenRouterModel;
	selectedEndpoint: OpenRouterEndpoint | null;
}) {
	return (
		<div className="flex min-w-0 flex-1 items-center gap-3">
			<MakerBadge maker={selectedModel.maker} />
			<div className="flex min-w-0 flex-1 flex-col items-start gap-1">
				<div className="flex w-full min-w-0 items-center gap-1.5">
					{selectedModel.variant ? <VariantBadgeIcon variant={selectedModel.variant} /> : null}
					<TruncatedText
						className="font-medium text-body text-foreground leading-tight tracking-tight"
						text={formatModelName(
							selectedModel.model_name ?? selectedModel.name,
							selectedModel.maker
						)}
					/>
				</div>
				<EndpointRow selectedEndpoint={selectedEndpoint} />
			</div>
		</div>
	);
}

function renderSelectedContent({
	selectedModel,
	selectedEndpoint,
	parsedModelId,
	placeholder,
}: {
	selectedModel: OpenRouterModel | undefined;
	selectedEndpoint: OpenRouterEndpoint | null;
	parsedModelId: string | undefined;
	placeholder: string;
}) {
	if (selectedModel) {
		return (
			<SelectedModelContent selectedEndpoint={selectedEndpoint} selectedModel={selectedModel} />
		);
	}

	if (isMissingModelId(parsedModelId)) {
		return (
			<div className="flex min-w-0 flex-1 items-center gap-2">
				<Badge className="shrink-0 text-2xs" variant="secondary">
					OpenRouter
				</Badge>
				<span className="truncate font-medium text-body text-foreground tracking-tight">Auto</span>
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

function getTriggerDataState(open: boolean): "open" | "closed" {
	return open ? "open" : "closed";
}

export function TriggerButton({
	buttonProps,
	open,
	disabled,
	isLoading,
	selectedModel,
	selectedEndpoint,
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
					<Spinner className="size-4" />
					<span className="font-medium text-body text-foreground-muted italic tracking-tight">
						{placeholder}
					</span>
				</div>
			) : (
				renderSelectedContent({
					selectedModel,
					selectedEndpoint,
					parsedModelId,
					placeholder,
				})
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
	selectedEndpoint,
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
					selectedEndpoint={selectedEndpoint}
					selectedModel={selectedModel}
				/>
			)}
		/>
	);
}
