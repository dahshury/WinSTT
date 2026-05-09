"use client";

import { AnimatePresence, motion } from "motion/react";
import { cn } from "@/shared/lib/cn";
import { formatMaker } from "../lib/model-selector-utils";
import { MODEL_VARIANT_INFO, type ModelVariant } from "../lib/model-variant-utils";
import {
	type FilterableParameter,
	formatProviderName,
	PARAMETER_INFO,
} from "../lib/openrouter-provider-utils";
import { ActiveFilterBadge } from "./ActiveFilterBadge";

export interface ActiveFiltersBarProps {
	className?: string;
	onEndpointProviderSelect: (provider: string | null) => void;
	onMakerToggle: (maker: string) => void;
	onParametersChange?: (params: FilterableParameter[]) => void;
	onRemoveParameter: (param: FilterableParameter) => void;
	onVariantSelect: (variant: ModelVariant | "none" | null) => void;
	selectedEndpointProvider: string | null;
	selectedMakers: string[];
	selectedParameters: FilterableParameter[];
	selectedVariant: ModelVariant | "none" | null;
}

export function ActiveFiltersBar({
	selectedMakers,
	selectedVariant,
	selectedEndpointProvider,
	selectedParameters,
	onMakerToggle,
	onVariantSelect,
	onEndpointProviderSelect,
	onRemoveParameter,
	className,
}: ActiveFiltersBarProps) {
	const hasFilters =
		selectedMakers.length > 0 ||
		selectedVariant !== null ||
		selectedEndpointProvider !== null ||
		selectedParameters.length > 0;

	if (!hasFilters) {
		return null;
	}

	return (
		<section
			aria-label="Active filters"
			className={cn(
				"flex flex-wrap items-center gap-2 border-border border-b px-2 py-1.5",
				className
			)}
			data-has-filters={hasFilters || undefined}
			data-slot="active-filters-bar"
		>
			<AnimatePresence initial={false}>
				{selectedMakers.map((maker) => (
					<motion.div
						animate={{ opacity: 1 }}
						exit={{ opacity: 0, transition: { duration: 0.3, ease: "easeIn" } }}
						initial={{ opacity: 0 }}
						key={`maker-${maker}`}
						transition={{ duration: 0.15, ease: "easeOut" }}
					>
						<ActiveFilterBadge
							label="Author"
							onRemove={() => onMakerToggle(maker)}
							value={formatMaker(maker)}
						/>
					</motion.div>
				))}
				{selectedVariant !== null && (
					<motion.div
						animate={{ opacity: 1 }}
						exit={{ opacity: 0, transition: { duration: 0.3, ease: "easeIn" } }}
						initial={{ opacity: 0 }}
						key={`variant-${selectedVariant}`}
						transition={{ duration: 0.15, ease: "easeOut" }}
					>
						<ActiveFilterBadge
							label="Variant"
							onRemove={() => onVariantSelect(null)}
							value={
								selectedVariant === "none"
									? "Standard"
									: (MODEL_VARIANT_INFO[selectedVariant]?.label ?? selectedVariant)
							}
						/>
					</motion.div>
				)}
				{selectedEndpointProvider !== null && (
					<motion.div
						animate={{ opacity: 1 }}
						exit={{ opacity: 0, transition: { duration: 0.3, ease: "easeIn" } }}
						initial={{ opacity: 0 }}
						key={`endpoint-${selectedEndpointProvider}`}
						transition={{ duration: 0.15, ease: "easeOut" }}
					>
						<ActiveFilterBadge
							label="Provider"
							onRemove={() => onEndpointProviderSelect(null)}
							value={formatProviderName(selectedEndpointProvider)}
						/>
					</motion.div>
				)}
				{selectedParameters.map((param) => (
					<motion.div
						animate={{ opacity: 1 }}
						exit={{ opacity: 0, transition: { duration: 0.3, ease: "easeIn" } }}
						initial={{ opacity: 0 }}
						key={`param-${param}`}
						transition={{ duration: 0.15, ease: "easeOut" }}
					>
						<ActiveFilterBadge
							label="Param"
							onRemove={() => onRemoveParameter(param)}
							value={PARAMETER_INFO[param].label}
						/>
					</motion.div>
				))}
			</AnimatePresence>
		</section>
	);
}
