"use client";

import { AnimatePresence, domAnimation, LazyMotion, m } from "motion/react";
import { cn } from "@/shared/lib/cn";
import { formatMaker } from "../lib/model-selector-utils";
import type { ModelVariant } from "../lib/model-variant-utils";
import {
	type FilterableParameter,
	formatProviderName,
	PARAMETER_INFO,
} from "../lib/openrouter-provider-utils";
import { ActiveFilterBadge } from "./ActiveFilterBadge";
import { getVariantLabel, hasActiveFilters } from "./active-filters-bar-helpers";

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

const FADE_TRANSITION = { duration: 0.15, ease: "easeOut" } as const;
const FADE_EXIT = { opacity: 0, transition: { duration: 0.3, ease: "easeIn" } } as const;

function AnimatedBadge({ children, id }: { children: React.ReactNode; id: string }) {
	return (
		<m.div
			animate={{ opacity: 1 }}
			exit={FADE_EXIT}
			initial={{ opacity: 0 }}
			key={id}
			transition={FADE_TRANSITION}
		>
			{children}
		</m.div>
	);
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
	if (
		!hasActiveFilters(selectedMakers, selectedVariant, selectedEndpointProvider, selectedParameters)
	) {
		return null;
	}

	return (
		<section
			aria-label="Active filters"
			className={cn(
				"flex flex-wrap items-center gap-2 border-border border-b px-2 py-1.5",
				className
			)}
			data-has-filters
			data-slot="active-filters-bar"
		>
			<LazyMotion features={domAnimation}>
				<AnimatePresence initial={false}>
					{selectedMakers.map((maker) => (
						<AnimatedBadge id={`maker-${maker}`} key={`maker-${maker}`}>
							<ActiveFilterBadge
								label="Author"
								onRemove={() => onMakerToggle(maker)}
								value={formatMaker(maker)}
							/>
						</AnimatedBadge>
					))}
					{selectedVariant !== null && (
						<AnimatedBadge id={`variant-${selectedVariant}`} key={`variant-${selectedVariant}`}>
							<ActiveFilterBadge
								label="Variant"
								onRemove={() => onVariantSelect(null)}
								value={getVariantLabel(selectedVariant)}
							/>
						</AnimatedBadge>
					)}
					{selectedEndpointProvider !== null && (
						<AnimatedBadge
							id={`endpoint-${selectedEndpointProvider}`}
							key={`endpoint-${selectedEndpointProvider}`}
						>
							<ActiveFilterBadge
								label="Provider"
								onRemove={() => onEndpointProviderSelect(null)}
								value={formatProviderName(selectedEndpointProvider)}
							/>
						</AnimatedBadge>
					)}
					{selectedParameters.map((param) => (
						<AnimatedBadge id={`param-${param}`} key={`param-${param}`}>
							<ActiveFilterBadge
								label="Param"
								onRemove={() => onRemoveParameter(param)}
								value={PARAMETER_INFO[param].label}
							/>
						</AnimatedBadge>
					))}
				</AnimatePresence>
			</LazyMotion>
		</section>
	);
}
