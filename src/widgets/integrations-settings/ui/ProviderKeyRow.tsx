import { ArrowUpRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useRef } from "react";
import { useTranslations } from "use-intl";
import { getApiKeyPrefix, getApiKeyUrl } from "@/entities/cloud-stt-provider";
import type { ClearableProvider } from "@/features/revert-cloud-on-key-removal";
import { secretHint } from "@/shared/config/settings-schema";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { ConfirmDialog } from "@/shared/ui/confirm-dialog";
import { ElevatedSurface } from "@/shared/ui/elevated-surface";
import { PasswordField, StoredSecretField } from "@/shared/ui/text-field";
import { CAPABILITY_MESSAGE } from "../lib/capability-messages";
import { maskedKeyDisplay } from "../lib/credential-display";
import type { ProviderCapability } from "../model/provider-capabilities";
import type { ProviderCredential } from "../model/use-provider-credential";

/** Compact action button shared by Replace / Remove / Test connection. */
const ACTION_CLASS = cn(
	"h-7 shrink-0 rounded-sm bg-surface-4 px-2.5 font-medium text-body-sm text-foreground-secondary ring-1 ring-divider-strong transition-colors duration-150",
	"hover:bg-surface-5 hover:text-foreground",
	"focus-visible:ring-2 focus-visible:ring-accent",
);

export interface ProviderKeyRowProps {
	capabilities: readonly ProviderCapability[];
	/** Owned by the card, not by this row: the card header's status pill reads
	 *  the same state, and two `useProviderCredential` calls would mean two
	 *  independent drafts. */
	credential: ProviderCredential;
	/** Accessible name for the editable key field, e.g. "OpenRouter API Key". */
	keyLabel: string;
	/** The provider's key-shape hint for the EDITABLE field's placeholder. The
	 *  sealed display's visible prefix comes from `getApiKeyPrefix` instead —
	 *  that one is a claim about the stored key, so it must not be translatable. */
	placeholder: string;
	provider: ClearableProvider;
	providerLabel: string;
}

/**
 * The active capabilities that gate a destructive removal — and, because the
 * confirm dialog names them, the ONLY ones its copy may claim will revert.
 *
 * Read-aloud is excluded ON PURPOSE. The gate must stay byte-for-byte identical
 * to what `planReverts` will actually rewrite, and the planner has no
 * `llmReadAloud` surface — so a read-aloud-only match would pop a dialog
 * promising a revert that never happens, and listing read-aloud alongside a real
 * match would put that same falsehood in the warning. (That the planner silently
 * leaves read-aloud pointed at a dead provider is a real gap, tracked in the
 * capability model; it is not this row's to fix.)
 */
function blockingCapabilities(
	capabilities: readonly ProviderCapability[],
): ProviderCapability[] {
	return capabilities.filter((c) => c.active && c.id !== "readAloud");
}

/**
 * The credential row for a key-backed provider — one implementation, used by
 * both OpenRouter and ElevenLabs (they previously had drifted copies).
 *
 * Four things the old rows did not do:
 *   - the sealed key shows its last-4 hint, so you can tell WHICH key is saved;
 *   - Replace edits in place instead of forcing remove-then-retype;
 *   - "Get a key" is always visible instead of sharing a slot with Remove;
 *   - "Test connection" makes the verify probe reachable on demand.
 */
export function ProviderKeyRow({
	capabilities,
	credential,
	keyLabel,
	placeholder,
	provider,
	providerLabel,
}: ProviderKeyRowProps) {
	const t = useTranslations("integrations");
	const tc = useTranslations("common");

	// One list drives BOTH the gate and the warning copy. Naming every ACTIVE
	// capability here instead would promise reverts the planner does not perform
	// (read-aloud), i.e. state a falsehood about a destructive action.
	const blocking = blockingCapabilities(capabilities);
	const blockingLabels = blocking.map((c) => t(CAPABILITY_MESSAGE[c.id]));
	const hint = secretHint(credential.storedKey);
	// Cancelling the inline editor unmounts the focused field and mounts a
	// non-focusable sealed one, so focus would fall to `document.body` and Tab
	// would restart at the top of the page. Hand it back to the control that
	// opened the editor — but only when the cancel came from the keyboard, so a
	// click elsewhere is never yanked back.
	const replaceButtonRef = useRef<HTMLElement>(null);
	const restoreFocusRef = useRef(false);
	useEffect(() => {
		if (credential.sealed && restoreFocusRef.current) {
			restoreFocusRef.current = false;
			replaceButtonRef.current?.focus();
		}
	}, [credential.sealed]);
	const rejected =
		credential.persistedVerified === false ||
		credential.live.status === "invalid";

	return (
		<div className="flex flex-col gap-2">
			<div className="flex items-center gap-2">
				<div className="min-w-0 flex-1">
					<ElevatedSurface inline>
						{credential.sealed ? (
							<StoredSecretField
								aria-label={
									hint
										? t("savedKeyAria", { last4: hint })
										: t("savedKeyNoHintAria")
								}
								invalid={rejected}
								maskedValue={maskedKeyDisplay(
									getApiKeyPrefix(provider),
									credential.storedKey,
								)}
							/>
						) : (
							<PasswordField
								aria-label={keyLabel}
								hideLabel={tc("hidePassword")}
								onBlur={(event) => {
									// The reveal eye lives inside this field's own wrapper —
									// clicking it must not count as leaving the field.
									const next = event.relatedTarget;
									if (
										next &&
										event.currentTarget.parentElement?.contains(next as Node)
									) {
										return;
									}
									if (credential.editableValue.trim().length === 0) {
										credential.cancelReplace();
										return;
									}
									credential.endEditing();
								}}
								onChange={(e) => credential.onType(e.target.value)}
								onKeyDown={(event) => {
									// Only claim Escape when there IS an edit to cancel; an
									// untouched empty field must let the window's own Escape
									// handler through.
									if (event.key !== "Escape" || !credential.editing) {
										return;
									}
									// `useEscapeToClose` (SettingsPage) listens on `window` and
									// only stands down for `defaultPrevented` events or an open
									// dialog/menu/listbox layer — neither applies to an inline
									// editor — so without this the cancel would ALSO close the
									// Settings window.
									event.preventDefault();
									event.stopPropagation();
									// Only arm the hand-off when a key is registered: with no key
									// the row keeps the editable field, so there is no Replace
									// button to land on and a stale flag would steal focus from a
									// later, unrelated seal.
									restoreFocusRef.current = credential.hasKey;
									credential.cancelReplace();
								}}
								placeholder={placeholder}
								ref={credential.inputRef}
								revealLabel={tc("showPassword")}
								value={credential.editableValue}
							/>
						)}
					</ElevatedSurface>
				</div>
				{credential.sealed ? (
					<Button
						className={ACTION_CLASS}
						onClick={credential.startReplace}
						ref={replaceButtonRef}
					>
						{t("replaceKey")}
					</Button>
				) : null}
				{credential.hasKey ? (
					<Button
						className={ACTION_CLASS}
						onClick={() => credential.requestRemove(blocking.length > 0)}
					>
						{t("removeKey")}
					</Button>
				) : null}
			</div>

			<div className="flex flex-wrap items-center justify-between gap-2">
				{/* window.open, not the anchor's own navigation: a Tauri webview would
				    otherwise try to render the provider's site inside the app window.
				    The anchor stays an anchor so it keeps link semantics and the
				    external-link affordance the old 12px text button never had. */}
				<a
					className="inline-flex items-center gap-1 text-body-sm text-foreground-muted underline-offset-4 transition-colors hover:text-foreground-secondary hover:underline"
					href={getApiKeyUrl(provider)}
					onClick={(event) => {
						event.preventDefault();
						window.open(
							getApiKeyUrl(provider),
							"_blank",
							"noopener,noreferrer",
						);
					}}
					rel="noopener noreferrer"
					target="_blank"
				>
					{t("getApiKey")}
					<HugeiconsIcon
						aria-hidden="true"
						icon={ArrowUpRight01Icon}
						size={11}
					/>
				</a>
				<Button
					className={ACTION_CLASS}
					disabled={!credential.hasKey}
					onClick={credential.testConnection}
				>
					{t("testConnection")}
				</Button>
			</div>

			<ConfirmDialog
				cancelLabel={t("cancel")}
				confirmLabel={t("remove")}
				description={
					blockingLabels.length > 0
						? t("removeKeyWarnsActive", { features: blockingLabels.join(", ") })
						: t("removeKeyConfirm", { provider: providerLabel })
				}
				onConfirm={credential.confirmRemove}
				onOpenChange={credential.setRemoveDialogOpen}
				open={credential.removeDialogOpen}
				title={t("removeKeyTitle")}
			/>
		</div>
	);
}
