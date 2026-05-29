"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "use-intl";
import { useCredentialStatus, useCredentialStatusStore } from "@/entities/cloud-stt-credential";
import { getApiKeyUrl, providerDisplayName, providerOf } from "@/entities/cloud-stt-provider";
import { useSettingsStore } from "@/entities/setting";
import { IPC } from "@/shared/api/ipc-channels";
import { ipcInvoke } from "@/shared/api/ipc-client";
import type { CloudSttErrorCode, CloudSttProvider } from "@/shared/api/models";
import { cn } from "@/shared/lib/cn";
import { surfaceBg, useSurface } from "@/shared/lib/surface";
import { ConfirmDialog } from "@/shared/ui/confirm-dialog";
import { ElevatedSurface } from "@/shared/ui/elevated-surface";
import { FormControl } from "@/shared/ui/form-control";
import { Spinner } from "@/shared/ui/spinner";
import { PasswordField } from "@/shared/ui/text-field";

interface ProviderIntegrationSectionProps {
	keyCaption: string;
	keyLabel: string;
	placeholder: string;
	provider: CloudSttProvider;
}

interface VerifyResponse {
	code?: CloudSttErrorCode;
	message?: string;
	ok: boolean;
}

/** Debounce window after the last keystroke before we hit the provider's
 *  auth endpoint. Long enough that pasting / fast typing produces one
 *  probe, short enough that the user gets the verdict before they move on. */
const VERIFY_DEBOUNCE_MS = 600;

/**
 * Renders the key field + live status pill + Remove action for a single
 * cloud provider. Used in `IntegrationsSettingsPanel` so OpenAI and
 * ElevenLabs each get a self-contained block with identical mechanics.
 *
 * Persistence is immediate: every keystroke writes the typed value to
 * `settings.integrations[provider].apiKey` so a tab switch (Base UI's
 * Tabs.Panel unmounts inactive panels) can never lose the key. The
 * provider auth probe runs in the background, debounced from the last
 * keystroke, and only drives the status pill plus the `verified` /
 * `lastVerifiedAt` metadata — it never gates persistence, so an
 * auth-rejected key stays in the field with an "invalid" pill the user
 * can fix without re-typing.
 *
 * The dialog gate fires only when the user is about to remove a key
 * whose provider is the active main STT model — yanking it out from
 * under dictation would silently break the next utterance.
 */
export function ProviderIntegrationSection({
	provider,
	keyLabel,
	keyCaption,
	placeholder,
}: ProviderIntegrationSectionProps) {
	const persistedApiKey = useSettingsStore((s) => s.settings.integrations[provider].apiKey);
	const updateIntegrations = useSettingsStore((s) => s.updateIntegrations);
	const activeModel = useSettingsStore((s) => s.settings.model?.model ?? "");
	const status = useCredentialStatus(provider);
	const tc = useTranslations("common");
	const t = useTranslations("integrations");
	const chipLevel = Math.min(useSurface() + 1, 8);

	const [dialogOpen, setDialogOpen] = useState(false);
	// The persisted key is the single source of truth — every keystroke
	// writes through to the zustand store via `updateIntegrations`, so
	// reading `persistedApiKey` directly during render is equivalent to a
	// mirrored local state but without the setState-in-effect waterfall.
	const localKey = persistedApiKey;
	const debounceRef = useRef<number | null>(null);
	const reqIdRef = useRef(0);

	useEffect(
		() => () => {
			if (debounceRef.current !== null) {
				window.clearTimeout(debounceRef.current);
			}
			// Bump the request-id so any in-flight verify resolves into the
			// stale-check branch and can't mutate verified/lastVerifiedAt or
			// the credential-status store from an unmounted instance.
			reqIdRef.current++;
		},
		[]
	);

	const runVerify = async (key: string) => {
		const credStore = useCredentialStatusStore.getState();
		const myReqId = ++reqIdRef.current;

		const trimmed = key.trim();
		if (trimmed.length === 0) {
			credStore.setStatus(provider, { status: "idle" });
			return;
		}

		credStore.setStatus(provider, { status: "verifying" });
		let response: VerifyResponse;
		try {
			response = await ipcInvoke<VerifyResponse>(IPC.INTEGRATIONS_VERIFY, {
				provider,
				apiKey: key,
			});
		} catch (err) {
			if (myReqId !== reqIdRef.current) {
				return;
			}
			const message = err instanceof Error ? err.message : String(err);
			// IPC transport failure — same semantics as `code: "network"`:
			// the key may be valid, we just couldn't reach the provider. The
			// key is already persisted (handleApiKeyType wrote through on
			// keystroke); just surface the "could not verify" pill.
			credStore.setStatus(provider, { status: "offline", lastError: message });
			return;
		}

		if (myReqId !== reqIdRef.current) {
			return;
		}

		if (response.ok) {
			updateIntegrations({
				[provider]: { verified: true, lastVerifiedAt: Date.now() },
			});
			credStore.setStatus(provider, { status: "verified" });
			return;
		}

		if (response.code === "network") {
			credStore.setStatus(provider, { status: "offline", lastError: response.message });
			return;
		}

		// Anything else (auth failure, malformed key, key_missing) — the
		// provider has explicitly rejected this value. The key stays
		// persisted so the user can fix it without re-typing, but verified
		// flips to false so the rest of the app doesn't treat it as valid.
		updateIntegrations({
			[provider]: { verified: false, lastVerifiedAt: Date.now() },
		});
		credStore.setStatus(provider, { status: "invalid", lastError: response.message });
	};

	const handleApiKeyType = (value: string) => {
		// Persist on every keystroke. The verify probe scheduled below only
		// drives the status pill (and verified/lastVerifiedAt metadata) — it
		// never gates persistence, so a quick tab switch can't lose the key.
		updateIntegrations({
			[provider]: { apiKey: value, verified: null, lastVerifiedAt: null },
		});
		// Cancel any pending probe so we don't fire stale verifications
		// against intermediate keystrokes.
		if (debounceRef.current !== null) {
			window.clearTimeout(debounceRef.current);
		}
		debounceRef.current = window.setTimeout(() => {
			debounceRef.current = null;
			runVerify(value).catch(() => undefined);
		}, VERIFY_DEBOUNCE_MS);
	};

	const requestRemoveApiKey = () => {
		const isActiveCloud = providerOf(activeModel) === provider;
		if (isActiveCloud) {
			setDialogOpen(true);
			return;
		}
		updateIntegrations({
			[provider]: { apiKey: "", verified: null, lastVerifiedAt: null },
		});
		useCredentialStatusStore.getState().setStatus(provider, { status: "idle" });
	};

	const confirmRemoveApiKey = () => {
		updateIntegrations({
			[provider]: { apiKey: "", verified: null, lastVerifiedAt: null },
		});
		useCredentialStatusStore.getState().setStatus(provider, { status: "idle" });
	};

	const hasLocalKey = localKey.trim().length > 0;
	const pill = renderStatusPill({ apiKey: localKey, chipLevel, status, t });
	const apiKeyUrl = getApiKeyUrl(provider);

	return (
		<div className="col-span-2">
			<FormControl
				label={keyLabel}
				labelTrailing={
					<div className="flex items-center gap-2">
						{pill}
						{!hasLocalKey && (
							<button
								className="text-foreground-muted text-xs underline-offset-2 hover:text-foreground-secondary hover:underline"
								onClick={() => window.open(apiKeyUrl, "_blank")}
								type="button"
							>
								{t("getApiKey")}
							</button>
						)}
					</div>
				}
				tooltip={keyCaption}
			>
				<div className="flex flex-col gap-2">
					<ElevatedSurface inline>
						<PasswordField
							hideLabel={tc("hidePassword")}
							onChange={(e) => handleApiKeyType(e.target.value)}
							placeholder={placeholder}
							revealLabel={tc("showPassword")}
							value={localKey}
						/>
					</ElevatedSurface>
					{hasLocalKey && (
						<div className="flex items-center justify-end gap-2">
							<button
								className={cn(
									"rounded border border-border px-3 py-1 text-foreground-secondary text-xs transition-colors hover:bg-surface-elevated",
									surfaceBg(chipLevel)
								)}
								onClick={requestRemoveApiKey}
								type="button"
							>
								{t("removeKey")}
							</button>
						</div>
					)}
				</div>
			</FormControl>
			<ConfirmDialog
				cancelLabel={t("cancel")}
				confirmLabel={t("remove")}
				description={t("removeKeyConfirmCloud")}
				onConfirm={confirmRemoveApiKey}
				onOpenChange={setDialogOpen}
				open={dialogOpen}
				title={t("removeKeyTitle", { provider: providerDisplayName(provider) })}
			/>
		</div>
	);
}

function renderStatusPill({
	apiKey,
	chipLevel,
	status,
	t,
}: {
	apiKey: string;
	chipLevel: number;
	status: { lastError?: string | undefined; status: string };
	t: ReturnType<typeof useTranslations>;
}) {
	if (status.status === "verifying") {
		return (
			<span
				className={cn(
					"inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-2xs text-foreground-muted",
					surfaceBg(chipLevel)
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
