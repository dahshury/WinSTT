import { PlugSocketIcon } from "@hugeicons/core-free-icons";
import { useEffect, useRef, useState } from "react";
import { useTranslations } from "use-intl";
import {
	DEFAULT_SETTINGS,
	SettingResetButton,
	SettingSection,
	useSettingsStore,
} from "@/entities/setting";
import { ProviderIntegrationSection } from "@/features/verify-credentials";
import { IPC } from "@/shared/api/ipc-channels";
import { ipcInvoke } from "@/shared/api/ipc-client";
import { ElevatedSurface } from "@/shared/ui/elevated-surface";
import { FormControl } from "@/shared/ui/form-control";
import { Spinner } from "@/shared/ui/spinner";
import { PasswordField, TextField } from "@/shared/ui/text-field";

const OPENROUTER_KEYS_URL = "https://openrouter.ai/keys";

/** Same window the OpenAI/ElevenLabs sections use — long enough that a paste
 *  produces one probe, short enough that the verdict lands quickly. */
const VERIFY_DEBOUNCE_MS = 600;

type OpenRouterStatus = "idle" | "verifying" | "verified" | "invalid" | "offline";

interface VerifyResponse {
	code?: "auth" | "network" | "rate_limit" | "provider_error";
	message?: string;
	ok: boolean;
}

/** Pure mapper from a verify-credentials IPC response to an OpenRouter status
 *  pill state. Pulled out of the component so the async verify runner stays
 *  under Biome's cognitive-complexity cap. */
function statusFromVerifyResponse(response: VerifyResponse): {
	lastError?: string;
	status: OpenRouterStatus;
} {
	if (response.ok) {
		return { status: "verified" };
	}
	const status: OpenRouterStatus = response.code === "network" ? "offline" : "invalid";
	return { status, ...(response.message ? { lastError: response.message } : {}) };
}

export function IntegrationsSettingsPanel() {
	const endpoint = useSettingsStore((s) => s.settings.llm.endpoint);
	const persistedOpenrouterKey = useSettingsStore((s) => s.settings.llm.openrouterApiKey);
	const updateLlmSettings = useSettingsStore((s) => s.updateLlmSettings);
	const t = useTranslations("integrations");
	const tLlm = useTranslations("llm");
	const tc = useTranslations("common");

	// Persisted key is read from the in-memory Zustand store, which `useSyncSettings`
	// (mounted by SettingsPage) already reconciled with electron-store on window
	// open. Re-running `settingsLoad()` on every panel mount used to clobber the
	// store with stale disk data whenever the user switched away and back before
	// the 300ms debounced `settingsSave` had a chance to write — wiping a freshly-
	// typed key out from under the input.

	// Local typed value for OpenRouter — kept in sync with the persisted store
	// value so the field re-hydrates correctly when the user reopens the panel.
	// Persistence happens on every keystroke (see `handleOpenrouterChange`); the
	// verify probe runs in the background purely to drive the status pill, and
	// never blocks or reverts persistence. An auth-rejected key stays in the
	// field with an "invalid" pill so the user can fix it without re-typing.
	const [localOpenrouterKey, setLocalOpenrouterKey] = useState(persistedOpenrouterKey);
	const [openrouterStatus, setOpenrouterStatus] = useState<{
		lastError?: string;
		status: OpenRouterStatus;
	}>({ status: "idle" });
	const openrouterDebounceRef = useRef<number | null>(null);
	const openrouterReqIdRef = useRef(0);

	useEffect(() => {
		setLocalOpenrouterKey(persistedOpenrouterKey);
	}, [persistedOpenrouterKey]);

	useEffect(
		() => () => {
			if (openrouterDebounceRef.current !== null) {
				window.clearTimeout(openrouterDebounceRef.current);
			}
			// Bump the request-id so any in-flight verify resolves into the
			// stale-check branch and can't write a status pill on a remounted
			// instance with fresh local state.
			openrouterReqIdRef.current++;
		},
		[]
	);

	const runOpenrouterVerify = async (key: string) => {
		const myReqId = ++openrouterReqIdRef.current;
		if (key.trim().length === 0) {
			setOpenrouterStatus({ status: "idle" });
			return;
		}
		setOpenrouterStatus({ status: "verifying" });
		try {
			const response = await ipcInvoke<VerifyResponse>(IPC.INTEGRATIONS_VERIFY, {
				provider: "openrouter",
				apiKey: key,
			});
			if (myReqId !== openrouterReqIdRef.current) {
				return;
			}
			setOpenrouterStatus(statusFromVerifyResponse(response));
		} catch (err) {
			if (myReqId !== openrouterReqIdRef.current) {
				return;
			}
			const message = err instanceof Error ? err.message : String(err);
			setOpenrouterStatus({ status: "offline", ...(message ? { lastError: message } : {}) });
		}
	};

	const handleOpenrouterChange = (value: string) => {
		setLocalOpenrouterKey(value);
		// Persist on every keystroke. The verify probe scheduled below only
		// drives the status pill — it never gates persistence. A tab switch
		// mid-typing (Base UI's Tabs.Panel unmounts inactive panels) leaves
		// the key safely in the store regardless of whether the verify ever
		// completes.
		updateLlmSettings({ openrouterApiKey: value });
		if (openrouterDebounceRef.current !== null) {
			window.clearTimeout(openrouterDebounceRef.current);
		}
		openrouterDebounceRef.current = window.setTimeout(() => {
			openrouterDebounceRef.current = null;
			runOpenrouterVerify(value).catch(() => undefined);
		}, VERIFY_DEBOUNCE_MS);
	};

	const openrouterPill = renderOpenrouterPill({
		apiKey: localOpenrouterKey,
		status: openrouterStatus,
		t,
	});

	return (
		<SettingSection description={t("description")} icon={PlugSocketIcon} title={t("title")}>
			<div className="flex flex-col divide-y divide-surface-1">
				<div className="col-span-2">
					<FormControl
						caption={tLlm("endpointCaption")}
						label={tLlm("endpoint")}
						labelTrailing={
							<SettingResetButton
								isDefault={endpoint === DEFAULT_SETTINGS.llm.endpoint}
								onReset={() => updateLlmSettings({ endpoint: DEFAULT_SETTINGS.llm.endpoint })}
							/>
						}
						tooltip={tLlm("endpointTooltip")}
					>
						<ElevatedSurface inline>
							<TextField
								onChange={(e) => updateLlmSettings({ endpoint: e.target.value })}
								placeholder="http://localhost:11434"
								value={endpoint}
							/>
						</ElevatedSurface>
					</FormControl>
				</div>

				<div className="col-span-2">
					<FormControl
						caption={tLlm("openrouterApiKeyCaption")}
						label={tLlm("openrouterApiKey")}
						labelTrailing={
							<div className="flex items-center gap-2">
								{openrouterPill}
								<button
									className="text-foreground-muted text-xs underline-offset-2 hover:text-foreground-secondary hover:underline"
									onClick={() => window.open(OPENROUTER_KEYS_URL, "_blank")}
									type="button"
								>
									{t("getApiKey")}
								</button>
							</div>
						}
						tooltip={tLlm("openrouterApiKeyTooltip")}
					>
						<ElevatedSurface inline>
							<PasswordField
								hideLabel={tc("hidePassword")}
								onChange={(e) => handleOpenrouterChange(e.target.value)}
								placeholder={tLlm("openrouterApiKeyPlaceholder")}
								revealLabel={tc("showPassword")}
								value={localOpenrouterKey}
							/>
						</ElevatedSurface>
					</FormControl>
				</div>

				<ProviderIntegrationSection
					keyCaption={t("openaiApiKeyCaption")}
					keyLabel={t("openaiApiKey")}
					placeholder={t("openaiApiKeyPlaceholder")}
					provider="openai"
				/>

				<ProviderIntegrationSection
					keyCaption={t("elevenlabsApiKeyCaption")}
					keyLabel={t("elevenlabsApiKey")}
					placeholder={t("elevenlabsApiKeyPlaceholder")}
					provider="elevenlabs"
				/>
			</div>
		</SettingSection>
	);
}

function renderOpenrouterPill({
	apiKey,
	status,
	t,
}: {
	apiKey: string;
	status: { lastError?: string; status: OpenRouterStatus };
	t: ReturnType<typeof useTranslations>;
}) {
	if (status.status === "verifying") {
		return (
			<span className="inline-flex items-center gap-1 rounded-sm bg-surface-tertiary px-1.5 py-0.5 text-2xs text-foreground-muted">
				<Spinner className="size-2.5 border" />
				{t("verifying")}
			</span>
		);
	}
	if (apiKey.trim().length === 0) {
		return null;
	}
	if (status.status === "verified") {
		return (
			<span className="rounded-sm bg-success/15 px-1.5 py-0.5 text-2xs text-success">
				{t("verified")}
			</span>
		);
	}
	if (status.status === "invalid") {
		return (
			<span
				className="rounded-sm bg-error/15 px-1.5 py-0.5 text-2xs text-error"
				title={status.lastError}
			>
				{t("invalid")}
			</span>
		);
	}
	if (status.status === "offline") {
		return (
			<span
				className="rounded-sm bg-warning/15 px-1.5 py-0.5 text-2xs text-warning"
				title={status.lastError}
			>
				{t("couldNotVerify")}
			</span>
		);
	}
	return null;
}
