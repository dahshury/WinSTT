"use client";

import { AiCloud01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useTranslations } from "next-intl";
import { useCredentialStatus } from "@/entities/cloud-stt-credential";
import {
	CLOUD_CATALOG,
	CLOUD_PROVIDERS,
	type CloudModel,
	providerDisplayName,
} from "@/entities/cloud-stt-provider";
import { useSettingsStore } from "@/entities/setting";
import { windowOpenSettings } from "@/shared/api/ipc-client";
import type { CloudSttProvider } from "@/shared/api/models";
import { Tooltip } from "@/shared/ui/tooltip";

/**
 * Cloud provider header — name, status dot, and either a "Configure key →"
 * button (when there is no key) or nothing (otherwise; rows below are
 * directly selectable). Status dot mirrors the credential probe:
 * verified=green, invalid=red, anything else=grey.
 */
function CloudProviderHeader({ provider }: { provider: CloudSttProvider }) {
	const apiKey = useSettingsStore((s) => s.settings.integrations[provider].apiKey);
	const status = useCredentialStatus(provider);
	const t = useTranslations("integrations");
	const hasKey = apiKey.trim().length > 0;

	let dotColor = "bg-foreground-dim/40";
	if (status.status === "verified") {
		dotColor = "bg-success";
	} else if (status.status === "invalid") {
		dotColor = "bg-error";
	} else if (hasKey && status.status === "idle") {
		dotColor = "bg-foreground-muted";
	}

	return (
		<div className="flex items-center justify-between border-border/60 border-b bg-surface-2 px-3 py-1.5">
			<div className="flex items-center gap-2">
				<span className={`inline-block size-1.5 rounded-full ${dotColor}`} />
				<span className="font-semibold text-[10px] text-foreground-muted uppercase tracking-[0.12em]">
					{providerDisplayName(provider)}
				</span>
			</div>
			{!hasKey && (
				<button
					className="text-foreground-muted text-xs underline-offset-2 hover:text-foreground-secondary hover:underline"
					onClick={windowOpenSettings}
					type="button"
				>
					{t("configureKey")} →
				</button>
			)}
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
	const apiKey = useSettingsStore((s) => s.settings.integrations[provider].apiKey);
	const t = useTranslations("integrations");
	const hasKey = apiKey.trim().length > 0;
	const fullId = `${provider}:${model.id}`;

	const button = (
		<button
			className={[
				"flex w-full items-start gap-2 px-3 py-2 text-left transition-colors",
				selected ? "bg-accent/10" : "hover:bg-surface-2",
				hasKey ? "cursor-pointer" : "cursor-not-allowed opacity-40",
			].join(" ")}
			disabled={!hasKey}
			onClick={() => onSelect(fullId)}
			type="button"
		>
			<div className="flex flex-1 flex-col">
				<span className="text-body text-foreground">{model.displayName}</span>
				{model.description ? (
					<span className="text-2xs text-foreground-muted">{model.description}</span>
				) : null}
			</div>
			<span className="rounded-sm bg-surface-tertiary px-1.5 py-0.5 font-mono text-[10px] text-foreground-dim">
				{model.id}
			</span>
		</button>
	);

	if (hasKey) {
		return button;
	}
	return (
		<Tooltip content={t("configureKeyTooltip")} side="top">
			<span>{button}</span>
		</Tooltip>
	);
}

interface CloudSttSectionProps {
	onSelect: (modelId: string) => void;
	selectedId: string;
}

/**
 * Compact cloud-models panel rendered above the local picker (settings panel
 * + detached picker window). Each provider gets a sticky header followed by
 * a list of provider-native model rows; selecting one persists the colon-
 * prefixed `provider:model_id` to `settings.model.model`.
 *
 * Greyed-out rows (no key) carry a tooltip pointing users back at Settings →
 * Integrations. The selected row is highlighted; the rest of the model
 * picker continues to render local models below.
 */
export function CloudSttSection({ selectedId, onSelect }: CloudSttSectionProps) {
	const t = useTranslations("integrations");
	return (
		<div className="overflow-hidden rounded-md border border-border bg-surface-elevated">
			<div className="flex items-center gap-2 bg-surface-2 px-3 py-1.5">
				<HugeiconsIcon className="text-foreground-muted" icon={AiCloud01Icon} size={12} />
				<span className="font-semibold text-[10px] text-foreground-muted uppercase tracking-[0.12em]">
					{t("cloudModels")}
				</span>
			</div>
			{CLOUD_PROVIDERS.map((provider) => (
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
