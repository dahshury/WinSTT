import { ArrowUpRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import { useTranslations } from "use-intl";
import { useCredentialStatus } from "@/entities/cloud-stt-credential";
import { useSettingsStore } from "@/entities/setting";
import { verifyCredential } from "@/features/verify-credentials";
import type { CloudSttProvider } from "@/shared/api/models";
import { cn } from "@/shared/lib/cn";
import { ElevatedSurface } from "@/shared/ui/elevated-surface";
import { FormControl } from "@/shared/ui/form-control";
import { Spinner } from "@/shared/ui/spinner";
import { Switcher, type SwitcherOption } from "@/shared/ui/switcher";
import { PasswordField } from "@/shared/ui/text-field";

interface ProviderMeta {
	caption: string;
	id: CloudSttProvider;
	keyPlaceholder: string;
	keyUrl: string;
	label: string;
}

const PROVIDERS: readonly ProviderMeta[] = [
	{
		id: "openai",
		label: "OpenAI",
		caption: "Whisper API — broad language support.",
		keyUrl: "https://platform.openai.com/api-keys",
		keyPlaceholder: "sk-…",
	},
	{
		id: "elevenlabs",
		label: "ElevenLabs",
		caption: "Scribe v1 — strong on accented + noisy audio.",
		keyUrl: "https://elevenlabs.io/app/settings/api-keys",
		keyPlaceholder: "Paste your ElevenLabs API key",
	},
];

const PROVIDER_OPTIONS: readonly SwitcherOption<CloudSttProvider>[] = PROVIDERS.map((p) => ({
	value: p.id,
	label: p.label,
}));

/**
 * Step 3: collect a cloud provider key. Provider is selected via the canonical
 * `Switcher` segmented control. The key field sits inside the same
 * `FormControl` + `ElevatedSurface` sandwich used everywhere in Settings.
 *
 * Always skippable — Next stays enabled regardless of whether the user enters
 * a key. The same verify flow (verify-credentials feature) is reused so the
 * status pill semantics match the Settings → Integrations panel exactly.
 */
export function OnboardingCloudKeysStep() {
	const t = useTranslations("onboarding");
	const [provider, setProvider] = useState<CloudSttProvider>("openai");
	const apiKey = useSettingsStore((s) => s.settings.integrations[provider].apiKey);
	const updateIntegrations = useSettingsStore((s) => s.updateIntegrations);
	const status = useCredentialStatus(provider);

	const hasKey = apiKey.trim().length > 0;
	const meta = PROVIDERS.find((p) => p.id === provider) ?? PROVIDERS[0];

	const handleVerify = () => {
		verifyCredential(provider, apiKey).catch(() => undefined);
	};

	return (
		<div className="flex flex-col gap-3">
			<FormControl
				caption={`${meta?.label ?? t("provider")} — ${meta?.caption ?? ""}`}
				label={t("provider")}
				layout="stacked"
			>
				<ElevatedSurface>
					<Switcher<CloudSttProvider>
						fullWidth
						onChange={setProvider}
						options={PROVIDER_OPTIONS}
						value={provider}
					/>
				</ElevatedSurface>
			</FormControl>

			<FormControl
				caption={t("apiKeyCaption")}
				label={t("apiKeyLabel", { provider: meta?.label ?? "API" })}
				labelTrailing={
					<a
						className="inline-flex items-center gap-1 font-mono text-foreground-muted text-xs-tight uppercase tracking-[0.14em] underline-offset-4 transition-colors hover:text-foreground-secondary hover:underline"
						href={meta?.keyUrl ?? "#"}
						rel="noreferrer noopener"
						target="_blank"
					>
						{t("getKey")}
						<HugeiconsIcon icon={ArrowUpRight01Icon} size={10} />
					</a>
				}
				layout="stacked"
			>
				<div className="flex flex-col gap-2.5">
					<ElevatedSurface inline>
						<PasswordField
							id="onboarding-api-key"
							onChange={(e) =>
								updateIntegrations({
									[provider]: {
										apiKey: e.target.value,
										verified: null,
										lastVerifiedAt: null,
									},
								})
							}
							placeholder={meta?.keyPlaceholder ?? ""}
							value={apiKey}
						/>
					</ElevatedSurface>
					<div className="flex items-center justify-between gap-2">
						<StatusPill apiKey={apiKey} status={status} />
						<button
							className={cn(
								"inline-flex h-7 items-center justify-center rounded-sm bg-surface-3 px-3 font-medium text-body-sm text-foreground-secondary outline-none ring-1 ring-divider-strong transition-[background-color,color] duration-150",
								"hover:bg-surface-4 hover:text-foreground",
								"focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-surface-1",
								"disabled:cursor-not-allowed disabled:opacity-40"
							)}
							disabled={!hasKey || status.status === "verifying"}
							onClick={handleVerify}
							type="button"
						>
							{status.status === "verifying" ? t("verifyingKey") : t("verifyKey")}
						</button>
					</div>
				</div>
			</FormControl>
		</div>
	);
}

interface StatusPillProps {
	apiKey: string;
	status: { status: string; lastError?: string | undefined };
}

function StatusPill({ status, apiKey }: StatusPillProps) {
	const t = useTranslations("onboarding");
	if (status.status === "verifying") {
		return (
			<span className="inline-flex items-center gap-1.5 rounded-sm bg-surface-3 px-1.5 py-0.5 text-2xs text-foreground-muted ring-1 ring-divider">
				<Spinner className="size-2.5 border" />
				<span className="font-medium uppercase tracking-wider">{t("statusVerifying")}</span>
			</span>
		);
	}
	if (apiKey.trim().length === 0) {
		return (
			<span className="inline-flex items-center rounded-sm bg-surface-3 px-1.5 py-0.5 font-medium text-2xs text-foreground-muted uppercase tracking-wider ring-1 ring-divider">
				{t("statusNoKey")}
			</span>
		);
	}
	if (status.status === "verified") {
		return (
			<span className="inline-flex items-center rounded-sm bg-success/15 px-1.5 py-0.5 font-medium text-2xs text-success uppercase tracking-wider ring-1 ring-success/30">
				{t("statusVerified")}
			</span>
		);
	}
	if (status.status === "invalid") {
		return (
			<span
				className="inline-flex items-center rounded-sm bg-error/15 px-1.5 py-0.5 font-medium text-2xs text-error uppercase tracking-wider ring-1 ring-error/30"
				title={status.lastError}
			>
				{t("statusInvalidKey")}
			</span>
		);
	}
	if (status.status === "offline") {
		return (
			<span
				className="inline-flex items-center rounded-sm bg-warning/15 px-1.5 py-0.5 font-medium text-2xs text-warning uppercase tracking-wider ring-1 ring-warning/30"
				title={status.lastError}
			>
				{t("statusUnreachable")}
			</span>
		);
	}
	return null;
}
