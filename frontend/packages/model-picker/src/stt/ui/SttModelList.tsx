"use client";

import { Combobox } from "@base-ui/react/combobox";
import { ServerStack01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ModelStateEntry, SystemInfoEntry } from "@/shared/api/ipc-client";
import type { OnnxQuantization } from "@/shared/config/defaults";
import {
	type AuthorGroup,
	bundleVariants,
	type FamilyKey,
	getAuthorLabel,
	getFamilyConfig,
} from "../lib/family-helpers";
import { SttVariantBundle } from "./SttVariantBundle";

export interface SttModelListProps {
	currentQuantization: OnnxQuantization;
	/** Bundle base ids the user has currently expanded — owned by the selector. */
	expandedBundles: ReadonlySet<string>;
	hasActiveFilters: boolean;
	onSelect: (modelId: string, quantization?: OnnxQuantization) => void;
	/** Toggle handler for the variant-bundle chevron. */
	onToggleExpanded: (baseId: string) => void;
	selectedId: string | undefined;
	statesById: Record<string, ModelStateEntry>;
	systemInfo: SystemInfoEntry | null;
}

function AuthorLabel({ family }: { family: FamilyKey }) {
	const config = getFamilyConfig(family);
	const author = getAuthorLabel(family);
	return (
		<Combobox.GroupLabel
			className="sticky top-0 z-raised flex items-center gap-2 border-border/60 border-b bg-surface-elevated/95 px-3 py-1.5 backdrop-blur-sm"
			data-rail-section={family}
		>
			{config.logoSrc ? (
				<img
					alt={`${author} logo`}
					className="size-4 shrink-0 rounded-[3px] object-cover"
					height={16}
					src={config.logoSrc}
					width={16}
				/>
			) : (
				<span className={`flex size-4 items-center justify-center rounded ${config.chip}`}>
					<HugeiconsIcon className="size-3" icon={config.icon} />
				</span>
			)}
			<span className="font-semibold text-[10px] text-foreground-muted uppercase tracking-[0.12em]">
				{author}
			</span>
			<span className="text-[10px] text-foreground-dim">· {config.label}</span>
		</Combobox.GroupLabel>
	);
}

function EmptyState({ hasActiveFilters }: { hasActiveFilters: boolean }) {
	return (
		<div className="mx-auto flex w-full max-w-[280px] flex-col items-center gap-2 px-4 py-8 text-center">
			<div className="flex size-10 items-center justify-center rounded-full bg-surface-secondary">
				<HugeiconsIcon className="size-5 text-foreground-muted" icon={ServerStack01Icon} />
			</div>
			<p className="text-balance font-semibold text-body">No models found</p>
			<p className="text-balance text-foreground-muted text-xs-tight">
				{hasActiveFilters
					? "Try clearing filters or adjusting your search."
					: "Waiting for the catalog to load…"}
			</p>
		</div>
	);
}

export function SttModelList({
	statesById,
	systemInfo,
	selectedId,
	currentQuantization,
	onSelect,
	hasActiveFilters,
	expandedBundles,
	onToggleExpanded,
}: SttModelListProps) {
	return (
		<div className="flex min-h-0 flex-1 flex-col overflow-y-auto" data-slot="stt-model-list">
			<Combobox.Empty className="block">
				<EmptyState hasActiveFilters={hasActiveFilters} />
			</Combobox.Empty>
			<Combobox.List className="p-0 pb-2">
				{(group: AuthorGroup) => {
					// Bundling happens INSIDE the group render so it stays
					// responsive to the menu-filtered set the selector hands
					// us — a filter that hides a multilingual variant lets
					// its .en sibling render solo automatically.
					const bundles = bundleVariants(group.items);
					return (
						<Combobox.Group className="flex flex-col" items={group.items} key={group.value}>
							<AuthorLabel family={group.value} />
							{bundles.map((bundle) => (
								<SttVariantBundle
									bundle={bundle}
									currentQuantization={currentQuantization}
									expanded={expandedBundles.has(bundle.baseId)}
									key={bundle.baseId}
									onSelect={onSelect}
									onToggleExpanded={onToggleExpanded}
									selectedId={selectedId}
									statesById={statesById}
									systemInfo={systemInfo}
								/>
							))}
						</Combobox.Group>
					);
				}}
			</Combobox.List>
		</div>
	);
}
