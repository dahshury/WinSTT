import {
	CheckmarkCircle02Icon,
	KeyboardIcon,
	Mic01Icon,
	RefreshIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { useTranslations } from "use-intl";
import type {
	PermissionGrantState,
	PermissionPreflightStatus,
} from "@/bindings";
import { cn } from "@/shared/lib/cn";
import { ElevatedSurface } from "@/shared/ui/elevated-surface";
import { Spinner } from "@/shared/ui/spinner";

interface PermissionPreflightPanelProps {
	busy: boolean;
	error: string | null;
	onRequestAccessibility: () => void;
	onRequestMicrophone: () => void;
	onRetry: () => void;
	status: PermissionPreflightStatus | null;
}

/** Focused setup/recovery surface shared by first-run and returning users. */
export function PermissionPreflightPanel({
	busy,
	error,
	onRequestAccessibility,
	onRequestMicrophone,
	onRetry,
	status,
}: PermissionPreflightPanelProps) {
	const t = useTranslations("onboarding");

	if (!status) {
		return (
			<div className="flex h-full items-center justify-center px-6 text-center">
				<div className="flex max-w-sm flex-col items-center gap-3">
					<span className="flex size-10 items-center justify-center rounded-md bg-surface-4 text-foreground-muted ring-1 ring-divider">
						{busy ? (
							<Spinner className="size-4 border" />
						) : (
							<HugeiconsIcon icon={RefreshIcon} size={17} />
						)}
					</span>
					<h1 className="font-semibold text-foreground text-title">
						{busy ? t("permissionChecking") : t("permissionCheckFailed")}
					</h1>
					{error ? (
						<p className="text-body-sm text-error leading-snug">{error}</p>
					) : null}
					{busy ? null : (
						<PermissionButton disabled={false} onClick={onRetry}>
							{t("permissionRetry")}
						</PermissionButton>
					)}
				</div>
			</div>
		);
	}

	return (
		<div className="flex h-full items-center justify-center overflow-y-auto px-6 py-8">
			<div className="flex w-full max-w-xl flex-col gap-5">
				<div className="text-center">
					<h1 className="font-semibold text-foreground text-title leading-tight">
						{t("permissionTitle")}
					</h1>
					<p className="mx-auto mt-2 max-w-lg text-body-sm text-foreground-muted leading-relaxed">
						{t("permissionBody")}
					</p>
				</div>

				<div className="flex flex-col gap-3">
					{status.microphone === "not_required" ? null : (
						<PermissionRow
							busy={busy}
							description={t("permissionMicrophoneBody")}
							icon={Mic01Icon}
							onRequest={onRequestMicrophone}
							state={status.microphone}
							title={t("permissionMicrophoneTitle")}
						/>
					)}
					{status.accessibility === "not_required" ? null : (
						<PermissionRow
							busy={busy}
							description={t("permissionAccessibilityBody")}
							icon={KeyboardIcon}
							onRequest={onRequestAccessibility}
							state={status.accessibility}
							title={t("permissionAccessibilityTitle")}
						/>
					)}
				</div>

				{error ? (
					<p className="text-center text-body-sm text-error">{error}</p>
				) : null}
			</div>
		</div>
	);
}

function PermissionRow({
	busy,
	description,
	icon,
	onRequest,
	state,
	title,
}: {
	busy: boolean;
	description: string;
	icon: IconSvgElement;
	onRequest: () => void;
	state: PermissionGrantState;
	title: string;
}) {
	const t = useTranslations("onboarding");
	const granted = state === "granted";
	return (
		<ElevatedSurface className="overflow-hidden">
			<div className="flex items-center gap-4 px-4 py-4">
				<span
					className={cn(
						"flex size-10 shrink-0 items-center justify-center rounded-md ring-1",
						granted
							? "bg-success/12 text-success ring-success/25"
							: "bg-accent/12 text-accent ring-accent/30",
					)}
				>
					<HugeiconsIcon
						icon={granted ? CheckmarkCircle02Icon : icon}
						size={18}
					/>
				</span>
				<div className="min-w-0 flex-1">
					<h2 className="font-semibold text-body text-foreground">{title}</h2>
					<p className="mt-1 text-body-sm text-foreground-muted leading-snug">
						{description}
					</p>
				</div>
				{granted ? (
					<span className="shrink-0 font-medium text-success text-xs">
						{t("permissionGranted")}
					</span>
				) : (
					<PermissionButton disabled={busy} onClick={onRequest}>
						{busy ? t("permissionChecking") : t("permissionGrant")}
					</PermissionButton>
				)}
			</div>
		</ElevatedSurface>
	);
}

function PermissionButton({
	children,
	disabled,
	onClick,
}: {
	children: React.ReactNode;
	disabled: boolean;
	onClick: () => void;
}) {
	return (
		<button
			className="inline-flex h-9 shrink-0 items-center justify-center rounded-md bg-accent px-3 font-semibold text-on-accent text-sm transition-colors hover:bg-accent-hover disabled:cursor-wait disabled:opacity-60"
			disabled={disabled}
			onClick={onClick}
			type="button"
		>
			{children}
		</button>
	);
}
