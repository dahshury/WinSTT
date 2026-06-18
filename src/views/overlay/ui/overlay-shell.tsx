import { Button as BaseButton } from "@base-ui/react/button";
import { sttAbortOperation } from "@/shared/api/ipc-client";
import { CHIP_SHADOW, GLASS_SURFACE } from "./overlay-shell.shared";

function cancelTranscription(): void {
	sttAbortOperation();
}

function CancelButton({ size = 16 }: { size?: number }) {
	return (
		<BaseButton
			aria-label="Cancel transcription"
			className={`relative flex shrink-0 items-center justify-center overflow-hidden rounded-full text-white/70 transition-colors hover:text-white focus:outline-none focus-visible:ring-1 focus-visible:ring-white/40 ${GLASS_SURFACE} ${CHIP_SHADOW}`}
			onClick={cancelTranscription}
			style={{ width: size, height: size, boxSizing: "border-box" }}
			type="button"
		>
			<span
				aria-hidden="true"
				className="pointer-events-none absolute inset-0 rounded-full bg-white/0 transition-colors duration-150 hover:bg-white/[0.08]"
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

function LivePulse({ isSpeaking }: { isSpeaking: boolean }) {
	return (
		<span
			aria-hidden="true"
			className="inline-block size-2 shrink-0 rounded-full bg-[oklch(62%_0.19_260)]"
			style={
				isSpeaking
					? { boxShadow: "0 0 8px 0 oklch(62% 0.19 260 / 0.7)" }
					: undefined
			}
		/>
	);
}

export { CancelButton, LivePulse };
