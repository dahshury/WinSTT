"use client";

import { AiCloud01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useTranslations } from "use-intl";
import { useCredentialStatus } from "@/entities/cloud-stt-credential";
import {
	CLOUD_CATALOG,
	CLOUD_PROVIDERS,
	type CloudModel,
	providerDisplayName,
} from "@/entities/cloud-stt-provider";
import { useSettingsStore } from "@/entities/setting";
import type { CloudSttProvider } from "@/shared/api/models";
import { cn } from "@/shared/lib/cn";
import { surfaceBg, useSurface } from "@/shared/lib/surface";

/**
 * Cloud provider header — name and credential status dot. Only rendered for
 * providers whose API key has been configured (filtered by the parent), so
 * the "no key" branch is unreachable here. Status dot mirrors the credential
 * probe: verified=green, invalid=red, anything else=grey.
 */
function CloudProviderHeader({ provider }: { provider: CloudSttProvider }) {
	const status = useCredentialStatus(provider);

	let dotColor = "bg-foreground-muted";
	if (status.status === "verified") {
		dotColor = "bg-success";
	} else if (status.status === "invalid") {
		dotColor = "bg-error";
	}

	return (
		<div className="flex items-center justify-between border-border/60 border-b bg-surface-2 px-3 py-1.5">
			<div className="flex items-center gap-2">
				<span className={`inline-block size-1.5 rounded-full ${dotColor}`} />
				<span className="font-semibold text-[10px] text-foreground-muted uppercase tracking-[0.12em]">
					{providerDisplayName(provider)}
				</span>
			</div>
		</div>
	);
}

interface CloudRowProps {
	model: CloudModel;
	onSelect: (modelId: string) => void;
	provider: CloudSttProvider;
	selected: boolean;
}

function CloudRow({ provider, model, onSelect, selected }: CloudRowProps) {
	const fullId = `${provider}:${model.id}`;
	// The chip sits on an already-lifted row inside the lifted section container,
	// so lift two steps above the substrate to stay legible on top of it.
	const chipLevel = Math.min(useSurface() + 2, 8);
	return (
		<button
			className={[
				"flex w-full cursor-pointer items-start gap-2 px-3 py-2 text-left transition-colors",
				selected ? "bg-accent/10" : "hover:bg-surface-2",
			].join(" ")}
			onClick={() => onSelect(fullId)}
			type="button"
		>
			<div className="flex flex-1 flex-col">
				<span className="text-body text-foreground">{model.displayName}</span>
				{model.description ? (
					<span className="text-2xs text-foreground-muted">{model.description}</span>
				) : null}
			</div>
			<span
				className={cn(
					"rounded-sm px-1.5 py-0.5 font-mono text-[10px] text-foreground-dim",
					surfaceBg(chipLevel)
				)}
			>
				{model.id}
			</span>
		</button>
	);
}

interface CloudSttSectionProps {
	onSelect: (modelId: string) => void;
	selectedId: string;
}

/**
 * Compact cloud-models panel rendered above the local picker (settings panel
 * + detached picker window). Only providers whose API key has been configured
 * contribute a header + model rows; the section collapses to nothing when no
 * provider has a key (the local picker below is the only path forward until
 * the user adds a key in Settings → Integrations).
 */
export function CloudSttSection({ selectedId, onSelect }: CloudSttSectionProps) {
	const t = useTranslations("integrations");
	const integrations = useSettingsStore((s) => s.settings.integrations);
	const visibleProviders = CLOUD_PROVIDERS.filter(
		(provider) => integrations[provider].apiKey.trim().length > 0
	);

	// Lift the cloud-models panel above whatever surface hosts it (settings
	// section or the detached picker window) — surfaces system, not a flat token.
	// Computed before the early return so the hook order stays stable.
	const level = Math.min(useSurface() + 1, 8);

	if (visibleProviders.length === 0) {
		return null;
	}

	return (
		<div className={cn("overflow-hidden rounded-md border border-border", surfaceBg(level))}>
			<div className="flex items-center gap-2 bg-surface-2 px-3 py-1.5">
				<HugeiconsIcon className="text-foreground-muted" icon={AiCloud01Icon} size={12} />
				<span className="font-semibold text-[10px] text-foreground-muted uppercase tracking-[0.12em]">
					{t("cloudModels")}
				</span>
			</div>
			{visibleProviders.map((provider) => (
				<div key={provider}>
					<CloudProviderHeader provider={provider} />
					{CLOUD_CATALOG[provider].map((model) => (
						<CloudRow
							key={model.id}
							model={model}
							onSelect={onSelect}
							provider={provider}
							selected={selectedId === `${provider}:${model.id}`}
						/>
					))}
				</div>
			))}
		</div>
	);
}
