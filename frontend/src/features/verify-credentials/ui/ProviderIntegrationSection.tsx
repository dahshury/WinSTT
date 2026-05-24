"use client";

import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { useCredentialStatus, useCredentialStatusStore } from "@/entities/cloud-stt-credential";
import { getApiKeyUrl, providerDisplayName, providerOf } from "@/entities/cloud-stt-provider";
import { useSettingsStore } from "@/entities/setting";
import { IPC } from "@/shared/api/ipc-channels";
import { ipcInvoke } from "@/shared/api/ipc-client";
import type { CloudSttErrorCode, CloudSttProvider } from "@/shared/api/models";
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
 * Validation is automatic: the typed value is held in local component
 * state and only written to `settings.integrations[provider].apiKey`
 * once the provider's auth endpoint accepts it. A clearly-invalid key
 * never reaches disk. A network failure during verification is
 * indistinguishable from a valid key behind a flaky connection, so we
 * persist optimistically in that case and surface a "could not verify"
 * pill so the user can retry by re-typing.
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

	const [dialogOpen, setDialogOpen] = useState(false);
	// Local typed value. Mirrors the persisted key on mount and whenever the
	// store changes externally (e.g. cross-window sync, Remove confirmed).
	// Diverges from persisted only while the user is mid-edit; never persisted
	// until verification confirms (or a network error makes us optimistic).
	const [localKey, setLocalKey] = useState(persistedApiKey);
	const debounceRef = useRef<number | null>(null);
	const reqIdRef = useRef(0);

	useEffect(() => {
		setLocalKey(persistedApiKey);
	}, [persistedApiKey]);

	useEffect(
		() => () => {
			if (debounceRef.current !== null) {
				window.clearTimeout(debounceRef.current);
			}
		},
		[]
	);

	const runVerify = async (key: string) => {
		const credStore = useCredentialStatusStore.getState();
		const myReqId = ++reqIdRef.current;

		const trimmed = key.trim();
		if (trimmed.length === 0) {
			// User cleared the field — persist the clear (intentional removal).
			updateIntegrations({
				[provider]: { apiKey: "", verified: null, lastVerifiedAt: null },
			});
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
			// IPC transport failure — same semantics as `code: "network"`: the
			// key may be valid, we just couldn't reach the provider. Persist
			// optimistically so the user isn't stuck unable to save during an
			// outage, and surface the "could not verify" pill so they know.
			updateIntegrations({
				[provider]: { apiKey: key, verified: null, lastVerifiedAt: null },
			});
			credStore.setStatus(provider, { status: "offline", lastError: message });
			return;
		}

		if (myReqId !== reqIdRef.current) {
			return;
		}

		if (response.ok) {
			updateIntegrations({
				[provider]: { apiKey: key, verified: true, lastVerifiedAt: Date.now() },
			});
			credStore.setStatus(provider, { status: "verified" });
			return;
		}

		if (response.code === "network") {
			updateIntegrations({
				[provider]: { apiKey: key, verified: null, lastVerifiedAt: null },
			});
			credStore.setStatus(provider, { status: "offline", lastError: response.message });
			return;
		}

		// Anything else (auth failure, malformed key, key_missing) — the
		// provider has explicitly rejected this value. Do NOT persist; keep
		// the typed garbage visible in the local input so the user can fix
		// it without re-typing from scratch.
		credStore.setStatus(provider, { status: "invalid", lastError: response.message });
	};

	const handleChange = (value: string) => {
		setLocalKey(value);
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

	const handleRemoveClick = () => {
		const isActiveCloud = providerOf(activeModel) === provider;
		if (isActiveCloud) {
			setDialogOpen(true);
			return;
		}
		setLocalKey("");
		updateIntegrations({
			[provider]: { apiKey: "", verified: null, lastVerifiedAt: null },
		});
		useCredentialStatusStore.getState().setStatus(provider, { status: "idle" });
	};

	const handleRemoveConfirm = () => {
		setLocalKey("");
		updateIntegrations({
			[provider]: { apiKey: "", verified: null, lastVerifiedAt: null },
		});
		useCredentialStatusStore.getState().setStatus(provider, { status: "idle" });
	};

	const hasLocalKey = localKey.trim().length > 0;
	const pill = renderStatusPill({ apiKey: localKey, status, t });
	const apiKeyUrl = getApiKeyUrl(provider);

	return (
		<div className="col-span-2">
			<FormControl
				caption={keyCaption}
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
			>
				<div className="flex flex-col gap-2">
					<ElevatedSurface inline>
						<PasswordField
							hideLabel={tc("hidePassword")}
							onChange={(e) => handleChange(e.target.value)}
							placeholder={placeholder}
							revealLabel={tc("showPassword")}
							value={localKey}
						/>
					</ElevatedSurface>
					{hasLocalKey && (
						<div className="flex items-center justify-end gap-2">
							<button
								className="rounded border border-border bg-surface-tertiary px-3 py-1 text-foreground-secondary text-xs transition-colors hover:bg-surface-elevated"
								onClick={handleRemoveClick}
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
				onConfirm={handleRemoveConfirm}
				onOpenChange={setDialogOpen}
				open={dialogOpen}
				title={t("removeKeyTitle", { provider: providerDisplayName(provider) })}
			/>
		</div>
	);
}

function renderStatusPill({
	apiKey,
	status,
	t,
}: {
	apiKey: string;
	status: { lastError?: string | undefined; status: string };
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
