"use client";

import type { ComponentPropsWithoutRef } from "react";
import type { OpenRouterEndpoint, OpenRouterModel } from "@/shared/api/models";
import { cn } from "@/shared/lib/cn";
import {
	buildFeatures,
	buildFeaturesFromSource,
	type FeatureIconConfig,
	type FeatureSource,
	getChipIcon,
	getChipLabelClass,
	getChipSizeClass,
} from "../lib/endpoint-feature-icons-test-helpers";
import { Tooltip, TooltipContent, TooltipTrigger } from "./Tooltip";

interface EndpointFeatureIconsProps {
	className?: string;
	endpoint: OpenRouterEndpoint;
	flat?: boolean;
	maxIcons?: number;
	showLabels?: boolean;
	size?: "sm" | "md";
}

interface ModelFeatureIconsProps {
	className?: string;
	flat?: boolean;
	maxIcons?: number;
	model: OpenRouterModel;
	showLabels?: boolean;
	size?: "sm" | "md";
}

interface FeatureSourceIconsProps {
	className?: string | undefined;
	flat?: boolean;
	maxIcons?: number;
	showLabels?: boolean;
	size?: "sm" | "md";
	source: FeatureSource;
}

interface FeatureIconsProps {
	className?: string | undefined;
	features: Array<{ key: string; config: FeatureIconConfig }>;
	flat: boolean;
	showLabels: boolean;
	size: "sm" | "md";
}

function ChipBody({
	config,
	isSmall,
	shouldShowLabel,
}: {
	config: FeatureIconConfig;
	isSmall: boolean;
	shouldShowLabel: boolean;
}) {
	return (
		<>
			{getChipIcon(config, isSmall)}
			{shouldShowLabel && (
				<span className={getChipLabelClass(isSmall)}>{config.shortLabel}</span>
			)}
		</>
	);
}

function FeatureIcons({
	features,
	showLabels,
	size,
	flat,
	className,
}: FeatureIconsProps) {
	if (features.length === 0) {
		return null;
	}

	const isSmall = size === "sm";

	return (
		<div className={cn("flex items-center gap-0.5", className)}>
			{features.map(({ key, config }) => {
				const isQuantization = key === "quantization";
				const shouldShowLabel = isQuantization || showLabels;

				return (
					<Tooltip key={key}>
						<TooltipTrigger
							render={(props) => (
								<div
									{...(props as ComponentPropsWithoutRef<"div">)}
									className={cn(
										"inline-flex cursor-default items-center justify-center gap-0.5 transition-[transform,box-shadow,color] duration-150",
										flat
											? cn(config.textClass, "hover:scale-110")
											: cn(
													"rounded-md border hover:scale-105 hover:shadow-sm",
													config.bgClass,
													config.textClass,
													config.borderClass,
												),
										getChipSizeClass({ flat, isSmall, shouldShowLabel }),
									)}
									data-feature-key={key}
								>
									<ChipBody
										config={config}
										isSmall={isSmall}
										shouldShowLabel={shouldShowLabel}
									/>
								</div>
							)}
						/>
						<TooltipContent className="max-w-xs" side="top">
							<p className="font-semibold text-body-sm">{config.label}</p>
							<p className="text-foreground-muted text-xs-tight leading-relaxed">
								{config.description}
							</p>
						</TooltipContent>
					</Tooltip>
				);
			})}
		</div>
	);
}

export function FeatureSourceIcons({
	source,
	maxIcons = 4,
	showLabels = false,
	size = "sm",
	flat = false,
	className,
}: FeatureSourceIconsProps) {
	const features = buildFeaturesFromSource(source, maxIcons);
	return (
		<FeatureIcons
			className={className}
			features={features}
			flat={flat}
			showLabels={showLabels}
			size={size}
		/>
	);
}

export function EndpointFeatureIcons({
	endpoint,
	maxIcons = 4,
	showLabels = false,
	size = "sm",
	flat = false,
	className,
}: EndpointFeatureIconsProps) {
	const features = buildFeatures(endpoint, maxIcons);
	return (
		<FeatureIcons
			className={className}
			features={features}
			flat={flat}
			showLabels={showLabels}
			size={size}
		/>
	);
}

export function ModelFeatureIcons({
	model,
	showLabels = false,
	size = "sm",
	flat = false,
	className,
}: ModelFeatureIconsProps) {
	return (
		<FeatureSourceIcons
			className={className}
			flat={flat}
			showLabels={showLabels}
			size={size}
			source={model}
		/>
	);
}
