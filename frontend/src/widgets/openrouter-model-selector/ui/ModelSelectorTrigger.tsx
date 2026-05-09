"use client";

import { Combobox } from "@base-ui/react/combobox";
import { ArrowUpDownIcon, ServerStack01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ComponentPropsWithoutRef } from "react";
import type { OpenRouterEndpoint, OpenRouterModel } from "@/shared/api/models";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { Spinner } from "@/shared/ui/spinner";
import { formatPricing, getVariantIcon } from "../lib/model-selector-display-utils";
import { formatMaker, formatModelName } from "../lib/model-selector-utils";
import { MODEL_VARIANT_INFO } from "../lib/model-variant-utils";
import { getProviderIconWithFallback } from "../lib/provider-icons";

export interface ModelSelectorTriggerProps {
	disabled: boolean;
	isLoading: boolean;
	open: boolean;
	parsedModelId: string | undefined;
	placeholder: string;
	selectedEndpoint: OpenRouterEndpoint | null;
	selectedModel: OpenRouterModel | undefined;
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
			<div className="flex min-w-0 flex-1 flex-col items-start gap-1">
				<div className="flex w-full min-w-0 items-center gap-2">
					{!!selectedModel.maker &&
						(() => {
							const providerIcon = getProviderIconWithFallback(selectedModel.maker);
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
									{formatMaker(selectedModel.maker)}
								</Badge>
							);
						})()}
					{selectedModel.variant && (
						<Badge className="shrink-0 gap-1 text-2xs" variant="outline">
							{getVariantIcon(selectedModel.variant)}
							{MODEL_VARIANT_INFO[selectedModel.variant]?.label ?? selectedModel.variant}
						</Badge>
					)}
					<span className="truncate font-medium">
						{formatModelName(selectedModel.model_name ?? selectedModel.name)}
					</span>
				</div>
				{selectedEndpoint && (
					<div className="flex items-center gap-2 text-foreground-muted text-xs-tight">
						<HugeiconsIcon className="size-3" icon={ServerStack01Icon} />
						<span>via {selectedEndpoint.provider_name}</span>
						<span className="opacity-60">({formatPricing(selectedEndpoint.pricing)})</span>
					</div>
				)}
			</div>
		);
	}

	if (parsedModelId === undefined || parsedModelId === "") {
		return (
			<div className="flex min-w-0 flex-1 items-center gap-2">
				<Badge className="shrink-0 text-2xs" variant="secondary">
					OpenRouter
				</Badge>
				<span className="truncate font-medium">Auto</span>
			</div>
		);
	}

	return <span className="text-foreground-muted">{placeholder}</span>;
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
				<Button
					{...(props as ComponentPropsWithoutRef<"button">)}
					aria-expanded={open}
					className="flex h-auto min-h-10 w-full items-center justify-between rounded-sm border border-border bg-surface-secondary px-3 py-2 text-left hover:bg-surface-hover"
					data-loading={isLoading || undefined}
					data-slot="model-selector-trigger"
					data-state={open ? "open" : "closed"}
					disabled={disabled || isLoading}
					type="button"
				>
					{isLoading ? (
						<div className="flex flex-1 items-center gap-2">
							<Spinner className="size-4" />
							<span className="text-foreground-muted">{placeholder}</span>
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
						className="ms-2 size-4 shrink-0 text-foreground-muted"
						icon={ArrowUpDownIcon}
					/>
				</Button>
			)}
		/>
	);
}
