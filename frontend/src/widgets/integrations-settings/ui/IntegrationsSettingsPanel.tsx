import { PlugSocketIcon } from "@hugeicons/core-free-icons";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import {
	DEFAULT_SETTINGS,
	SettingResetButton,
	SettingSection,
	useSettingsStore,
} from "@/entities/setting";
import { ProviderIntegrationSection } from "@/features/verify-credentials";
import { IPC } from "@/shared/api/ipc-channels";
import { ipcInvoke, settingsLoad } from "@/shared/api/ipc-client";
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

export function IntegrationsSettingsPanel() {
	const endpoint = useSettingsStore((s) => s.settings.llm.endpoint);
	const persistedOpenrouterKey = useSettingsStore((s) => s.settings.llm.openrouterApiKey);
	const updateLlmSettings = useSettingsStore((s) => s.updateLlmSettings);
	const setSettings = useSettingsStore((s) => s.setSettings);
	const t = useTranslations("integrations");
	const tLlm = useTranslations("llm");
	const tc = useTranslations("common");

	// Force a refresh from electron-store when the panel mounts. The global
	// `useSyncSettings` hook already runs settingsLoad() on its own, but it
	// fires once per window-mount and can race with localStorage hydration —
	// this explicit pull guarantees the masked-secret field shows the latest
	// persisted plaintext whenever the user opens the tab.
	useEffect(() => {
		let cancelled = false;
		settingsLoad()
			.then((loaded) => {
				if (!cancelled) {
					setSettings(loaded);
				}
			})
			.catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, [setSettings]);

	// Local typed value for OpenRouter — never persisted until a verify
	// probe accepts it (or the network fails, in which case we persist
	// optimistically since a flaky connection is indistinguishable from a
	// valid key behind one).
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
		},
		[]
	);

	const applyVerifyResult = (key: string, response: VerifyResponse) => {
		if (response.ok) {
			updateLlmSettings({ openrouterApiKey: key });
			setOpenrouterStatus({ status: "verified" });
			return;
		}
		if (response.code === "network") {
			updateLlmSettings({ openrouterApiKey: key });
			setOpenrouterStatus({
				status: "offline",
				...(response.message ? { lastError: response.message } : {}),
			});
			return;
		}
		// Explicit auth/provider rejection — never persist a key that the
		// provider has told us is wrong. The typed value stays in the local
		// input so the user can fix it without re-typing.
		setOpenrouterStatus({
			status: "invalid",
			...(response.message ? { lastError: response.message } : {}),
		});
	};

	const runOpenrouterVerify = async (key: string) => {
		const myReqId = ++openrouterReqIdRef.current;
		if (key.trim().length === 0) {
			// User cleared the field — persist the clear.
			updateLlmSettings({ openrouterApiKey: "" });
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
			applyVerifyResult(key, response);
		} catch (err) {
			if (myReqId !== openrouterReqIdRef.current) {
				return;
			}
			// IPC transport failure — treat as offline. Persist optimistically.
			const message = err instanceof Error ? err.message : String(err);
			updateLlmSettings({ openrouterApiKey: key });
			setOpenrouterStatus({ status: "offline", ...(message ? { lastError: message } : {}) });
		}
	};

	const handleOpenrouterChange = (value: string) => {
		setLocalOpenrouterKey(value);
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
