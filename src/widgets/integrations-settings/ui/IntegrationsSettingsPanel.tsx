import { Button as BaseButton } from "@base-ui/react/button";
import { AiBrain01Icon, ApiIcon } from "@hugeicons/core-free-icons";
import { useEffect, useRef, useState } from "react";
import { useTranslations } from "use-intl";
import {
	DEFAULT_SETTINGS,
	SettingField,
	SettingSection,
	useSettingsStore,
} from "@/entities/setting";
import { ProviderIntegrationSection } from "@/features/verify-credentials";
import { IPC } from "@/shared/api/ipc-channels";
import { ipcInvoke } from "@/shared/api/ipc-client";
import { cn } from "@/shared/lib/cn";
import { surfaceBg, useSurface } from "@/shared/lib/surface";
import { ConfirmDialog } from "@/shared/ui/confirm-dialog";
import { ElevatedSurface } from "@/shared/ui/elevated-surface";
import { FormControl } from "@/shared/ui/form-control";
import { Spinner } from "@/shared/ui/spinner";
import { PasswordField, TextField } from "@/shared/ui/text-field";

const OPENROUTER_KEYS_URL = "https://openrouter.ai/keys";

/** Same window the OpenAI/ElevenLabs sections use — long enough that a paste
 *  produces one probe, short enough that the verdict lands quickly. */
const VERIFY_DEBOUNCE_MS = 600;

type OpenRouterStatus =
	| "idle"
	| "verifying"
	| "verified"
	| "invalid"
	| "offline";

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
	const status: OpenRouterStatus =
		response.code === "network" ? "offline" : "invalid";
	return {
		status,
		...(response.message ? { lastError: response.message } : {}),
	};
}

type VerifySettlement =
	| { ok: true; response: VerifyResponse }
	| { ok: false; err: unknown };

/** Flattens the verify-credentials settlement into the next status pill
 *  state. Extracted so the async runner avoids nested ternaries (Biome's
 *  ``noNestedTernary``) without dropping the no-early-return shape that
 *  keeps ``react-doctor/async-defer-await`` quiet. */
function computeOpenrouterNextStatus(
	isStale: boolean,
	settled: VerifySettlement,
): { lastError?: string; status: OpenRouterStatus } | null {
	if (isStale) {
		return null;
	}
	if (settled.ok) {
		return statusFromVerifyResponse(settled.response);
	}
	const message =
		settled.err instanceof Error
			? settled.err.message
			: String(settled.err ?? "");
	return { status: "offline", ...(message ? { lastError: message } : {}) };
}

export function IntegrationsSettingsPanel() {
	const endpoint = useSettingsStore((s) => s.settings.llm.endpoint);
	const persistedOpenrouterKey = useSettingsStore(
		(s) => s.settings.llm.openrouterApiKey,
	);
	const updateLlmSettings = useSettingsStore((s) => s.updateLlmSettings);
	const dictationProvider = useSettingsStore(
		(s) => s.settings.llm.dictation.provider,
	);
	const transformsProvider = useSettingsStore(
		(s) => s.settings.llm.transforms.provider,
	);
	const t = useTranslations("integrations");
	const tLlm = useTranslations("llm");
	const tc = useTranslations("common");
	const chipLevel = Math.min(useSurface() + 1, 8);

	// Persisted key is read from the in-memory Zustand store, which `useSyncSettings`
	// (mounted by SettingsPage) already reconciled with persisted store on window
	// open. Re-running `settingsLoad()` on every panel mount used to clobber the
	// store with stale disk data whenever the user switched away and back before
	// the 300ms debounced `settingsSave` had a chance to write — wiping a freshly-
	// typed key out from under the input.

	// Persistence happens on every keystroke (see `handleOpenrouterChange`), so
	// `persistedOpenrouterKey` from the store IS the input's source of truth —
	// no local state mirror needed. The verify probe runs in the background
	// purely to drive the status pill and never blocks or reverts persistence;
	// an auth-rejected key stays in the field with an "invalid" pill so the
	// user can fix it without re-typing.
	const [openrouterStatus, setOpenrouterStatus] = useState<{
		lastError?: string;
		status: OpenRouterStatus;
	}>({ status: "idle" });
	const openrouterDebounceRef = useRef<number | null>(null);
	const openrouterReqIdRef = useRef(0);
	const [openrouterDialogOpen, setOpenrouterDialogOpen] = useState(false);

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
		[],
	);

	const runOpenrouterVerify = async (key: string) => {
		if (key.trim().length === 0) {
			setOpenrouterStatus({ status: "idle" });
			return;
		}
		const myReqId = ++openrouterReqIdRef.current;
		setOpenrouterStatus({ status: "verifying" });
		// Dispatch the IPC, then translate either path (success or rejection)
		// into a single ``next`` status. No conditional early-return follows
		// the await — the stale-request check just feeds the same setter,
		// which keeps react-doctor/async-defer-await happy: the awaited value
		// is consumed unconditionally, never thrown away by a fast-skip path.
		const settled = await ipcInvoke<VerifyResponse>(IPC.INTEGRATIONS_VERIFY, {
			provider: "openrouter",
			apiKey: key,
		}).then(
			(response) => ({ ok: true as const, response }),
			(err: unknown) => ({ ok: false as const, err }),
		);
		const isStale = myReqId !== openrouterReqIdRef.current;
		const next = computeOpenrouterNextStatus(isStale, settled);
		if (next) {
			setOpenrouterStatus(next);
		}
	};

	const handleOpenrouterChange = (value: string) => {
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

	// Cancel any pending verify and clear the key. The auto-revert guard (main
	// window) switches any LLM feature on OpenRouter back to Ollama + disabled
	// once the cleared key broadcasts — here we just drop the secret + pill.
	const clearOpenrouterKey = () => {
		if (openrouterDebounceRef.current !== null) {
			window.clearTimeout(openrouterDebounceRef.current);
			openrouterDebounceRef.current = null;
		}
		openrouterReqIdRef.current++;
		updateLlmSettings({ openrouterApiKey: "" });
		setOpenrouterStatus({ status: "idle" });
	};

	const requestRemoveOpenrouter = () => {
		// Confirm before yanking a key an LLM feature is actively using; otherwise
		// clear immediately. Manual field-clears always auto-revert silently.
		const isActiveCloud =
			dictationProvider === "openrouter" || transformsProvider === "openrouter";
		if (isActiveCloud) {
			setOpenrouterDialogOpen(true);
			return;
		}
		clearOpenrouterKey();
	};

	const hasOpenrouterKey = persistedOpenrouterKey.trim().length > 0;

	const openrouterPill = renderOpenrouterPill({
		apiKey: persistedOpenrouterKey,
		chipLevel,
		status: openrouterStatus,
		t,
	});

	return (
		<div className="flex flex-col gap-2">
			{/* ── Language Models (LLM) ───────────────────────────────────
			 *  Powers dictation cleanup, context-aware edits and translation.
			 *  Backed by a LOCAL Ollama server (endpoint) or a CLOUD OpenRouter
			 *  key. These keys have nothing to do with cloud transcription —
			 *  the grouping makes that explicit so an OpenRouter key is no
			 *  longer mistaken for the thing that unlocks Cloud STT. */}
			<SettingSection
				description={t("llmSectionCaption")}
				icon={AiBrain01Icon}
				title={t("llmSectionTitle")}
			>
				<div className="flex flex-col divide-y divide-surface-1">
					<div className="col-span-2">
						<SettingField
							isDefault={endpoint === DEFAULT_SETTINGS.llm.endpoint}
							label={tLlm("endpoint")}
							onReset={() =>
								updateLlmSettings({ endpoint: DEFAULT_SETTINGS.llm.endpoint })
							}
							tooltip={tLlm("endpointTooltip")}
						>
							<ElevatedSurface inline>
								<TextField
									onChange={(e) =>
										updateLlmSettings({ endpoint: e.target.value })
									}
									placeholder="http://localhost:11434"
									value={endpoint}
								/>
							</ElevatedSurface>
						</SettingField>
					</div>

					<div className="col-span-2">
						<FormControl
							label={tLlm("openrouterApiKey")}
							labelTrailing={
								<div className="flex items-center gap-2">
									{openrouterPill}
									<BaseButton
										className="text-foreground-muted text-xs underline-offset-2 hover:text-foreground-secondary hover:underline"
										onClick={() => window.open(OPENROUTER_KEYS_URL, "_blank")}
										type="button"
									>
										{t("getApiKey")}
									</BaseButton>
								</div>
							}
							tooltip={`${tLlm("openrouterApiKeyTooltip")} ${tLlm("openrouterApiKeyCaption")}`}
						>
							<div className="flex flex-col gap-2">
								<ElevatedSurface inline>
									<PasswordField
										hideLabel={tc("hidePassword")}
										onChange={(e) => handleOpenrouterChange(e.target.value)}
										placeholder={tLlm("openrouterApiKeyPlaceholder")}
										revealLabel={tc("showPassword")}
										value={persistedOpenrouterKey}
									/>
								</ElevatedSurface>
								{hasOpenrouterKey && (
									<div className="flex items-center justify-end gap-2">
										<BaseButton
											className={cn(
												"rounded border border-border px-3 py-1 text-foreground-secondary text-xs transition-colors hover:bg-surface-elevated",
												surfaceBg(chipLevel),
											)}
											onClick={requestRemoveOpenrouter}
											type="button"
										>
											{t("removeKey")}
										</BaseButton>
									</div>
								)}
							</div>
						</FormControl>
					</div>
				</div>
				<ConfirmDialog
					cancelLabel={t("cancel")}
					confirmLabel={t("remove")}
					description={t("removeKeyConfirm", { provider: "OpenRouter" })}
					onConfirm={clearOpenrouterKey}
					onOpenChange={setOpenrouterDialogOpen}
					open={openrouterDialogOpen}
					title={t("removeKeyTitle", { provider: "OpenRouter" })}
				/>
			</SettingSection>

			{/* ── Cloud Speech-to-Text ────────────────────────────────────
			 *  THE keys that unlock the Local/Cloud Source switcher in the
			 *  Transcription tab. OpenAI (Whisper / GPT-4o transcribe) and ElevenLabs
			 *  (Scribe) are the only cloud STT providers — `hasAnyCloudKey`
			 *  in ModelSettingsPanel gates on exactly these two. */}
			<SettingSection
				description={t("sttSectionCaption")}
				icon={ApiIcon}
				title={t("sttSectionTitle")}
			>
				<div className="flex flex-col divide-y divide-surface-1">
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
		</div>
	);
}

function renderOpenrouterPill({
	apiKey,
	chipLevel,
	status,
	t,
}: {
	apiKey: string;
	chipLevel: number;
	status: { lastError?: string; status: OpenRouterStatus };
	t: ReturnType<typeof useTranslations>;
}) {
	if (status.status === "verifying") {
		return (
			<span
				className={cn(
					"inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-2xs text-foreground-muted",
					surfaceBg(chipLevel),
				)}
			>
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
