import { Button as BaseButton } from "@base-ui/react/button";
import { useState } from "react";
import { useTranslations } from "use-intl";
import { commands } from "@/bindings";
import { sttAbortOperation } from "@/shared/api/ipc-client";
import { CHIP_SHADOW, GLASS_SURFACE } from "./overlay-shell.shared";

function cancelTranscription(): void {
	sttAbortOperation();
}

function CancelButton({ size = 16 }: { size?: number }) {
	return (
		<BaseButton
			aria-label="Cancel transcription"
			className={`relative flex shrink-0 items-center justify-center overflow-hidden rounded-full text-overlay-foreground/70 transition-colors hover:text-overlay-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-overlay-foreground/40 ${GLASS_SURFACE} ${CHIP_SHADOW}`}
			onClick={cancelTranscription}
			style={{ width: size, height: size, boxSizing: "border-box" }}
			type="button"
		>
			<span
				aria-hidden="true"
				className="pointer-events-none absolute inset-0 rounded-full bg-overlay-foreground/0 transition-colors duration-150 hover:bg-overlay-foreground/[0.08]"
			/>
			<svg
				aria-hidden="true"
				className="relative"
				fill="none"
				height={Math.round(size * 0.55)}
				stroke="currentColor"
				strokeLinecap="round"
				strokeWidth={2}
				viewBox="0 0 24 24"
				width={Math.round(size * 0.55)}
				xmlns="http://www.w3.org/2000/svg"
			>
				<line x1="6" x2="18" y1="6" y2="18" />
				<line x1="6" x2="18" y1="18" y2="6" />
			</svg>
		</BaseButton>
	);
}

function SkipPostProcessingButton() {
	const tOnboarding = useTranslations("onboarding");
	const tStatus = useTranslations("statusBar");
	const [requested, setRequested] = useState(false);
	const label = `${tOnboarding("skip")} ${tStatus("breakdownPost")}`;

	const skipPostProcessing = () => {
		if (requested) {
			return;
		}
		setRequested(true);
		void commands.sttSkipPostProcessing(true).then(
			(accepted) => {
				if (!accepted) {
					setRequested(false);
				}
			},
			() => setRequested(false),
		);
	};

	return (
		<BaseButton
			aria-label={`${label} (Alt+S)`}
			className="inline-flex h-6 items-center gap-1.5 rounded-md border border-overlay-foreground/15 bg-overlay-foreground/[0.07] px-2 font-medium text-[10px] text-overlay-foreground/75 transition-colors hover:border-overlay-foreground/25 hover:bg-overlay-foreground/[0.12] hover:text-overlay-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-overlay-foreground/40 disabled:cursor-wait disabled:opacity-55"
			data-overlay-skip-post-processing="true"
			disabled={requested}
			onClick={skipPostProcessing}
			title={`${label} — Alt+S`}
			type="button"
		>
			<span>{label}</span>
			<kbd className="rounded border border-overlay-foreground/20 bg-overlay-foreground/[0.08] px-1 py-0.5 font-mono text-[9px] leading-none text-overlay-foreground/85 shadow-sm">
				{"Alt+S"}
			</kbd>
		</BaseButton>
	);
}

function LivePulse({ isSpeaking }: { isSpeaking: boolean }) {
	return (
		<span
			aria-hidden="true"
			className="inline-block size-2 shrink-0 rounded-full bg-accent"
			style={
				isSpeaking
					? { boxShadow: "0 0 8px 0 var(--color-accent-hairline)" }
					: undefined
			}
		/>
	);
}

export { CancelButton, LivePulse, SkipPostProcessingButton };
