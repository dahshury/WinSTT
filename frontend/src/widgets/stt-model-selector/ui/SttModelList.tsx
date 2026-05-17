"use client";

import { Combobox } from "@base-ui/react/combobox";
import { ServerStack01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { Ref } from "react";
import type { ModelInfo } from "@/entities/model-catalog";
import type { ModelStateEntry, SystemInfoEntry } from "@/shared/api/ipc-client";
import type { OnnxQuantization } from "@/shared/config/defaults";
import {
	type AuthorGroup,
	type FamilyKey,
	getAuthorLabel,
	getFamilyConfig,
} from "../lib/family-helpers";
import { SttModelCard } from "./SttModelCard";

export interface SttModelListProps {
	currentQuantization: OnnxQuantization;
	hasActiveFilters: boolean;
	onSelect: (modelId: string, quantization?: OnnxQuantization) => void;
	/** Forwarded to the overflow-y-auto wrapper so the selector can drive
	 *  scroll-spy + click-to-scroll for the left family rail. */
	scrollRef?: Ref<HTMLDivElement>;
	selectedId: string | undefined;
	statesById: Record<string, ModelStateEntry>;
	systemInfo: SystemInfoEntry | null;
}

function AuthorLabel({ family }: { family: FamilyKey }) {
	const config = getFamilyConfig(family);
	return (
		<Combobox.GroupLabel
			className="sticky top-0 z-10 flex items-center gap-2 border-border/60 border-b bg-surface-elevated/95 px-3 py-1.5 backdrop-blur-sm"
			data-rail-section={family}
		>
			<span className={`flex size-4 items-center justify-center rounded ${config.chip}`}>
				<HugeiconsIcon className="size-3" icon={config.icon} />
			</span>
			<span className="font-semibold text-[10px] text-foreground-muted uppercase tracking-[0.12em]">
				{getAuthorLabel(family)}
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
	scrollRef,
}: SttModelListProps) {
	return (
		<div
			className="flex min-h-0 flex-1 flex-col overflow-y-auto"
			data-slot="stt-model-list"
			ref={scrollRef}
		>
			<Combobox.Empty className="block">
				<EmptyState hasActiveFilters={hasActiveFilters} />
			</Combobox.Empty>
			<Combobox.List className="p-0 pb-2">
				{(group: AuthorGroup) => (
					<Combobox.Group className="flex flex-col" items={group.items} key={group.value}>
						<AuthorLabel family={group.value} />
						<Combobox.Collection>
							{(model: ModelInfo) => (
								<SttModelCard
									currentQuantization={currentQuantization}
									key={model.id}
									model={model}
									onSelect={onSelect}
									selectedId={selectedId}
									state={statesById[model.id]}
									systemInfo={systemInfo}
								/>
							)}
						</Combobox.Collection>
					</Combobox.Group>
				)}
			</Combobox.List>
		</div>
	);
}
