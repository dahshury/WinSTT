import { ArrowTurnBackwardIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import { useTranslations } from "use-intl";
import { ConfirmDialog } from "@/shared/ui/confirm-dialog";
import { IconButton } from "@/shared/ui/icon-button";

export interface SettingResetButtonProps {
	/**
	 * Whether the setting currently holds its schema default. The button stays
	 * visible either way (so the affordance is discoverable) but is disabled
	 * while already at the default — there is nothing to revert.
	 */
	isDefault: boolean;
	/** Restore the setting to its default value. */
	onReset: () => void;
}

/**
 * Per-setting "revert to default" affordance. Designed to sit in a
 * `FormControl`'s `labelTrailing` slot so it appears at the trailing edge of
 * the header row, just right of the info tooltip. Clicking it opens a
 * confirmation dialog before the reset is applied.
 */
export function SettingResetButton({ isDefault, onReset }: SettingResetButtonProps) {
	const tc = useTranslations("common");
	const ts = useTranslations("settings");
	const [confirmOpen, setConfirmOpen] = useState(false);
	return (
		<>
			<IconButton
				aria-label={tc("resetToDefault")}
				className={
					isDefault ? "size-6 text-foreground-muted/50 disabled:opacity-100" : "size-6 text-accent"
				}
				disabled={isDefault}
				icon={<HugeiconsIcon icon={ArrowTurnBackwardIcon} size={14} />}
				onClick={() => setConfirmOpen(true)}
				tooltip={tc("resetToDefault")}
			/>
			<ConfirmDialog
				cancelLabel={tc("cancel")}
				confirmLabel={tc("reset")}
				description={ts("resetSettingDescription")}
				onConfirm={onReset}
				onOpenChange={setConfirmOpen}
				open={confirmOpen}
				title={ts("resetSettingTitle")}
			/>
		</>
	);
}
