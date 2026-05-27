import type { ReactNode } from "react";
import { surfaceClasses, surfaceHoverBg, useSurface } from "@/shared/lib/surface";
import { Button } from "@/shared/ui/button";
import { DialogShell } from "@/shared/ui/dialog-shell";

export interface OptInDialogProps {
	body: ReactNode;
	cancelLabel: string;
	confirmLabel: string;
	onCancel: () => void;
	onConfirm: () => void;
	onOpenChange: (open: boolean) => void;
	open: boolean;
	title: string;
}

/**
 * One-shot opt-in confirmation dialog. Differs from ConfirmDialog in three
 * ways:
 *   - The body accepts multi-line ReactNode (warning text usually wraps
 *     across multiple paragraphs).
 *   - The confirm button is the brand-accent action (not the destructive
 *     red); the user is consenting to a feature, not deleting anything.
 *   - Closing via Escape / backdrop click is treated as cancel, not
 *     confirm — flipping the toggle back to off requires an explicit
 *     button press.
 */
export function OptInDialog({
	open,
	onOpenChange,
	title,
	body,
	confirmLabel,
	cancelLabel,
	onConfirm,
	onCancel,
}: OptInDialogProps) {
	const handleConfirm = () => {
		onConfirm();
		onOpenChange(false);
	};

	const handleCancel = () => {
		onCancel();
		onOpenChange(false);
	};

	// Match ConfirmDialog's cancel-button substrate lift so the two dialogs
	// look identical from the same parent substrate.
	const substrate = useSurface();
	const popupLevel = Math.min(substrate + 4, 8);
	const buttonLevel = Math.min(popupLevel + 1, 8);
	const buttonHover = Math.min(popupLevel + 2, 8);

	return (
		<DialogShell
			description={body}
			onOpenChange={(next) => {
				if (next) {
					onOpenChange(true);
				} else {
					handleCancel();
				}
			}}
			open={open}
			title={title}
			width={460}
		>
			<Button
				className={`h-8 rounded-md ${surfaceClasses(buttonLevel)} px-4 font-medium text-body text-foreground-secondary transition-colors duration-150 ${surfaceHoverBg(buttonHover)}`}
				onClick={handleCancel}
			>
				{cancelLabel}
			</Button>
			<Button
				className="h-8 rounded-md bg-accent px-4 font-medium text-body text-white transition-colors duration-150 hover:bg-accent-dim"
				onClick={handleConfirm}
			>
				{confirmLabel}
			</Button>
		</DialogShell>
	);
}
