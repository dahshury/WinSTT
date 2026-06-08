import { Button as BaseButton } from "@base-ui/react/button";
import { ArrowUpRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { AnimatePresence, m } from "motion/react";
import { useEffect, useState } from "react";
import { useTranslations } from "use-intl";
import { providerOf } from "@/entities/cloud-stt-provider";
import { useCredentialStatus } from "@/entities/cloud-stt-credential";
import { useSettingsStore } from "@/entities/setting";
import { CloudModelSelect } from "@/features/select-cloud-stt-model";
import { verifyCredential } from "@/features/verify-credentials";
import type { IntegrationCloudProvider } from "@/shared/api/models";
import { cn } from "@/shared/lib/cn";
import { ElevatedSurface } from "@/shared/ui/elevated-surface";
import { FormControl } from "@/shared/ui/form-control";
import { Spinner } from "@/shared/ui/spinner";
import { Switcher, type SwitcherOption } from "@/shared/ui/switcher";
import { PasswordField } from "@/shared/ui/text-field";
import { useOnboardingWizardStore } from "../../model/wizard-store";

interface ProviderMeta {
	caption: string;
	// Onboarding collects only the integrations-backed STT keys (OpenAI /
	// ElevenLabs); OpenRouter is configured later via its shared LLM key.
	id: IntegrationCloudProvider;
	keyPlaceholder: string;
	keyUrl: string;
	label: string;
}

const PROVIDERS: readonly ProviderMeta[] = [
	{
		id: "elevenlabs",
		label: "ElevenLabs",
		caption: "Scribe v1 — strong on accented + noisy audio.",
		keyUrl: "https://elevenlabs.io/app/settings/api-keys",
		keyPlaceholder: "Paste your ElevenLabs API key",
	},
];

const PROVIDER_OPTIONS: readonly SwitcherOption<IntegrationCloudProvider>[] =
	PROVIDERS.map((p) => ({
		value: p.id,
		label: p.label,
	}));

const VERIFY_BUTTON_MOTION_PROPS = {
	whileHover: { y: -1 },
	whileTap: { scale: 0.97 },
} as const;
const CLOUD_MODEL_BACKEND = "onnx_asr" as const;
const MotionBaseButton = m.create(BaseButton);

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
	const [provider, setProvider] = useState<IntegrationCloudProvider>("elevenlabs");
	const apiKey = useSettingsStore(
		(s) => s.settings.integrations[provider].apiKey,
	);
	const activeModel = useSettingsStore((s) => s.settings.model.model);
	const integrations = useSettingsStore((s) => s.settings.integrations);
	// OpenRouter STT reuses the single LLM key (no integrations entry).
	const openrouterKey = useSettingsStore((s) => s.settings.llm.openrouterApiKey);
	const updateIntegrations = useSettingsStore((s) => s.updateIntegrations);
	const updateModelSettings = useSettingsStore((s) => s.updateModelSettings);
	const status = useCredentialStatus(provider);
	const setCloudSttReady = useOnboardingWizardStore((s) => s.setCloudSttReady);

	const hasKey = apiKey.trim().length > 0;
	const meta = PROVIDERS.find((p) => p.id === provider) ?? PROVIDERS[0];
	const verifyDisabled = !hasKey || status.status === "verifying";
	const activeProvider = providerOf(activeModel);
	const activeProviderHasKey =
		activeProvider === "openrouter"
			? openrouterKey.trim().length > 0
			: activeProvider !== null &&
				integrations[activeProvider].apiKey.trim().length > 0;

	useEffect(() => {
		setCloudSttReady(activeProviderHasKey);
	}, [activeProviderHasKey, setCloudSttReady]);

	const handleVerify = () => {
		verifyCredential(provider, apiKey).catch(() => undefined);
	};

	const handleModelSelect = (modelId: string) => {
		updateModelSettings({
			model: modelId,
			backend: CLOUD_MODEL_BACKEND,
			realtimeModel: "",
		});
	};

	return (
		<div className="flex flex-col gap-3">
			<FormControl
				caption={`${meta?.label ?? t("provider")} — ${meta?.caption ?? ""}`}
				label={t("provider")}
				layout="stacked"
			>
				<ElevatedSurface>
					<Switcher<IntegrationCloudProvider>
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
						<AnimatePresence initial={false} mode="wait">
							<StatusPill
								apiKey={apiKey}
								key={`${provider}-${status.status}-${hasKey}`}
								status={status}
							/>
						</AnimatePresence>
						<MotionBaseButton
							className={cn(
								"inline-flex h-7 items-center justify-center rounded-sm bg-surface-3 px-3 font-medium text-body-sm text-foreground-secondary outline-none ring-1 ring-divider-strong transition-[background-color,color] duration-150",
								"hover:bg-surface-4 hover:text-foreground",
								"focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-surface-1",
								"disabled:cursor-not-allowed disabled:opacity-40",
							)}
							disabled={verifyDisabled}
							onClick={handleVerify}
							{...(verifyDisabled ? {} : VERIFY_BUTTON_MOTION_PROPS)}
							type="button"
						>
							{status.status === "verifying"
								? t("verifyingKey")
								: t("verifyKey")}
						</MotionBaseButton>
					</div>
				</div>
			</FormControl>

			<FormControl
				caption="Choose the cloud speech model WinSTT should use for dictation."
				label="Cloud speech model"
				layout="stacked"
			>
				<CloudModelSelect
					onSelect={handleModelSelect}
					selectedId={activeProviderHasKey ? activeModel : ""}
				/>
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
	const motionProps = {
		animate: { opacity: 1, scale: 1, y: 0 },
		exit: { opacity: 0, scale: 0.94, y: -3 },
		initial: { opacity: 0, scale: 0.92, y: 3 },
		transition: { duration: 0.16, ease: [0.22, 1, 0.36, 1] },
	} as const;
	if (status.status === "verifying") {
		return (
			<m.span
				className="inline-flex items-center gap-1.5 rounded-sm bg-surface-3 px-1.5 py-0.5 text-2xs text-foreground-muted ring-1 ring-divider"
				{...motionProps}
			>
				<Spinner className="size-2.5 border" />
				<span className="font-medium uppercase tracking-wider">
					{t("statusVerifying")}
				</span>
			</m.span>
		);
	}
	if (apiKey.trim().length === 0) {
		return (
			<m.span
				className="inline-flex items-center rounded-sm bg-surface-3 px-1.5 py-0.5 font-medium text-2xs text-foreground-muted uppercase tracking-wider ring-1 ring-divider"
				{...motionProps}
			>
				{t("statusNoKey")}
			</m.span>
		);
	}
	if (status.status === "verified") {
		return (
			<m.span
				className="inline-flex items-center rounded-sm bg-success/15 px-1.5 py-0.5 font-medium text-2xs text-success uppercase tracking-wider ring-1 ring-success/30"
				{...motionProps}
			>
				{t("statusVerified")}
			</m.span>
		);
	}
	if (status.status === "invalid") {
		return (
			<m.span
				className="inline-flex items-center rounded-sm bg-error/15 px-1.5 py-0.5 font-medium text-2xs text-error uppercase tracking-wider ring-1 ring-error/30"
				title={status.lastError}
				{...motionProps}
			>
				{t("statusInvalidKey")}
			</m.span>
		);
	}
	if (status.status === "offline") {
		return (
			<m.span
				className="inline-flex items-center rounded-sm bg-warning/15 px-1.5 py-0.5 font-medium text-2xs text-warning uppercase tracking-wider ring-1 ring-warning/30"
				title={status.lastError}
				{...motionProps}
			>
				{t("statusUnreachable")}
			</m.span>
		);
	}
	return null;
}
