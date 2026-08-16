import { useEffect, useRef, useState } from "react";
import { useTranslations } from "use-intl";
import {
	DEFAULT_SETTINGS,
	SettingField,
	useSettingsStore,
} from "@/entities/setting";
import { CredentialStatusPill } from "@/features/verify-credentials";
import { fetchOllamaModels } from "@/shared/api/ipc-client";
import { cn } from "@/shared/lib/cn";
import { fireAndForget } from "@/shared/lib/fire-and-forget";
import { validateLoopbackOllamaEndpoint } from "@/shared/lib/ollama-endpoint";
import { useSurface } from "@/shared/lib/surface";
import { Button } from "@/shared/ui/button";
import { ElevatedSurface } from "@/shared/ui/elevated-surface";
import { TextField } from "@/shared/ui/text-field";
import { resolveCredentialPillState } from "../lib/credential-display";
import {
	useIntegrationVerifyStatus,
	useIntegrationVerifyStore,
} from "../model/integration-verify-store";
import { useProviderCapabilities } from "../model/use-provider-capabilities";
import { ProviderCard } from "./ProviderCard";

/** Brand name, not copy: identical in all 20 locales, exactly like the hardcoded
 *  "ElevenLabs" / "OpenRouter" in `providerDisplayName` (cloud-stt-provider). */
const OLLAMA_DISPLAY_NAME = "Ollama";

/** Same compact action treatment the key rows use, so the three cards' primary
 *  actions line up visually. */
const ACTION_CLASS = cn(
	"h-7 shrink-0 rounded-sm bg-surface-4 px-2.5 font-medium text-body-sm text-foreground-secondary ring-1 ring-divider-strong transition-colors duration-150",
	"hover:bg-surface-5 hover:text-foreground",
	"focus-visible:ring-2 focus-visible:ring-accent",
);

/**
 * The keyless integration. Its "credential" is a loopback endpoint, so the card
 * carries the endpoint field instead of a key row, and no "Get a key" link —
 * its description states outright that no account is needed.
 *
 * "Test connection" here means reachability (`/api/tags` via
 * `ollama_refresh_models`), not authentication, and feeds the SAME status pill
 * the hosted providers use so all three cards read identically.
 */
export function OllamaCard() {
	const t = useTranslations("integrations");
	const tLlm = useTranslations("llm");
	const endpoint = useSettingsStore((s) => s.settings.llm.endpoint);
	const updateLlmSettings = useSettingsStore((s) => s.updateLlmSettings);
	const capabilities = useProviderCapabilities("ollama");
	const live = useIntegrationVerifyStatus("ollama");
	// Matches the capability chips inside ProviderCard — one elevation, not two.
	const chipLevel = Math.min(useSurface() + 1, 8);

	const [endpointDraft, setEndpointDraft] = useState(endpoint);
	const endpointFocusedRef = useRef(false);
	const probeIdRef = useRef(0);

	useEffect(() => {
		if (!endpointFocusedRef.current) {
			setEndpointDraft(endpoint);
		}
	}, [endpoint]);

	useEffect(
		() => () => {
			// Any in-flight probe resolves into the stale branch rather than writing
			// a reachability verdict from an unmounted card.
			probeIdRef.current++;
		},
		[],
	);

	const trimmedEndpoint = endpointDraft.trim();
	const endpointValidation = validateLoopbackOllamaEndpoint(endpointDraft);
	const endpointError =
		trimmedEndpoint.length === 0
			? tLlm("endpointRequired")
			: endpointValidation.ok
				? undefined
				: tLlm("endpointInvalid");

	const runProbe = async () => {
		const myProbeId = ++probeIdRef.current;
		useIntegrationVerifyStore
			.getState()
			.setStatus("ollama", { status: "verifying" });
		// `fetchOllamaModels` already swallows transport failures into a
		// `{ reachable: false }` fallback, so there is nothing to catch here.
		const result = await fetchOllamaModels();
		if (myProbeId === probeIdRef.current) {
			useIntegrationVerifyStore.getState().setStatus("ollama", {
				status: result.reachable ? "verified" : "offline",
				...(result.error ? { lastError: result.error } : {}),
			});
		}
	};

	// The probe reports on the endpoint the BACKEND currently holds, so an
	// unsaved/invalid draft has nothing meaningful to test.
	const canProbe = endpointError === undefined;
	const probeResult =
		live.status === "verified"
			? t("endpointReachable")
			: live.status === "offline"
				? t("endpointUnreachable")
				: null;

	return (
		<ProviderCard
			capabilities={capabilities}
			description={t("ollamaDescription")}
			name={OLLAMA_DISPLAY_NAME}
			provider="ollama"
			statusPill={
				<CredentialStatusPill
					chipLevel={chipLevel}
					lastError={live.lastError}
					providerLabel={OLLAMA_DISPLAY_NAME}
					state={resolveCredentialPillState({
						hasCredential: canProbe,
						// No persisted reachability verdict exists (and it would be stale
						// the moment Ollama stops), so the pill always starts unverified.
						persistedVerified: null,
						status: live.status,
					})}
					t={t}
				/>
			}
		>
			<div className="flex flex-col gap-2">
				<SettingField
					error={endpointError}
					isDefault={endpoint === DEFAULT_SETTINGS.llm.endpoint}
					label={tLlm("endpoint")}
					onReset={() => {
						setEndpointDraft(DEFAULT_SETTINGS.llm.endpoint);
						updateLlmSettings({ endpoint: DEFAULT_SETTINGS.llm.endpoint });
					}}
					tooltip={tLlm("endpointTooltip")}
				>
					<ElevatedSurface inline>
						<TextField
							aria-invalid={endpointError !== undefined || undefined}
							aria-label={tLlm("endpoint")}
							error={endpointError !== undefined}
							onBlur={() => {
								endpointFocusedRef.current = false;
								if (endpointValidation.ok) {
									setEndpointDraft(endpointValidation.endpoint);
								}
							}}
							onChange={(e) => {
								const next = e.target.value;
								setEndpointDraft(next);
								const validation = validateLoopbackOllamaEndpoint(next);
								if (validation.ok) {
									updateLlmSettings({ endpoint: validation.endpoint });
								}
							}}
							onFocus={() => {
								endpointFocusedRef.current = true;
							}}
							placeholder={DEFAULT_SETTINGS.llm.endpoint}
							value={endpointDraft}
						/>
					</ElevatedSurface>
				</SettingField>

				<div className="flex flex-wrap items-center justify-between gap-2">
					<span className="text-body-sm text-foreground-muted">
						{probeResult}
					</span>
					<Button
						className={ACTION_CLASS}
						disabled={!canProbe}
						onClick={() =>
							fireAndForget(runProbe(), "integrations.ollamaTestConnection")
						}
					>
						{t("testConnection")}
					</Button>
				</div>
			</div>
		</ProviderCard>
	);
}
