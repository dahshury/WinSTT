import { HugeiconsIcon } from "@hugeicons/react";
import type { KeyboardEvent } from "react";
import { useTranslations } from "use-intl";
import { useSettingsStore } from "@/entities/setting";
import { useOutputDevicePicker } from "@/features/listen-mode";
import {
	buildOutputDeviceOptions,
	useSoundPreview,
} from "@/features/recording-sound";
import { cn } from "@/shared/lib/cn";
import {
	surfaceBg,
	surfaceClasses,
	surfaceHoverBg,
	useSurface,
} from "@/shared/lib/surface";
import { StopBubble } from "@/shared/ui/select";
import { close } from "../lib/picker-helpers";

/**
 * Listen-mode output (loopback) device picker, hosted in the detached
 * model-picker backdrop window and opened from the footer pill. Reuses the
 * shared output-device model so a pick here writes the same settings as the
 * Settings Output tab (re-targeting the loopback capture + updating the footer
 * pill), and each row carries a play/preview button to hear the physical
 * speaker first.
 *
 * The selected/hover states are STATIC (plain surface backgrounds), not the
 * animated `MenuHighlightLayer` pill the inline mic dropdown uses: this body is
 * hosted in the heavy model-picker window, which re-renders on every model /
 * download / resource store tick, and a spring-animated pill re-measured on
 * each of those ticks flickered continuously. Static rows are immune.
 */
export function DetachedOutputDevicePicker() {
	const ta = useTranslations("audio");
	const tg = useTranslations("general");
	const recordingSoundPath = useSettingsStore(
		(s) => s.settings.general?.recordingSoundPath ?? "",
	);
	const { entries, currentId, select } = useOutputDevicePicker({
		systemDefaultLabel: ta("systemDefault"),
	});
	const soundPreview = useSoundPreview();
	// Row highlight levels sit 1–2 surfaces above the popup (which self-elevates
	// two levels above the window substrate), matching the mic dropdown's tints.
	const substrate = useSurface();
	const popupLevel = Math.min(substrate + 2, 8);
	const popupShadow = Math.max(popupLevel, 6);
	const hoverLevel = Math.min(popupLevel + 1, 8);
	const selectedLevel = Math.min(popupLevel + 2, 8);

	const options = buildOutputDeviceOptions({
		entries,
		currentId,
		playingId: soundPreview.playingId,
		soundPath: recordingSoundPath,
		toggle: soundPreview.toggle,
		playLabel: tg("soundLibraryPlay"),
		stopLabel: tg("soundLibraryStop"),
	});

	const handleSelect = async (id: string) => {
		// Await so the (possibly on-demand loopback-index) write commits before the
		// window hides — WebView2 can suspend the page's JS on hide.
		await select(id);
		close();
	};

	const handleRowKeyDown = (
		event: KeyboardEvent<HTMLDivElement>,
		id: string,
	) => {
		if (event.key === "Enter" || event.key === " ") {
			event.preventDefault();
			void handleSelect(id);
		}
	};

	return (
		// Bottom-aligned so a short list hugs the trigger; a completed click on the
		// empty area above it (the container itself, not a row) dismisses the
		// picker — same affordance as the STT cloud branch of `PickerBody`.
		<div
			className="flex h-full w-full items-end overflow-hidden"
			onPointerDown={(event) => {
				if (event.target === event.currentTarget) {
					close();
				}
			}}
		>
			{/* Rows are role="option" DIVs, NOT <button>s: each row carries a nested
			    play/preview <button>, and a <button> may not legally contain another
			    <button> — nesting them silently broke the preview click. */}
			<div
				className={cn(
					"select-popup max-h-full w-full overflow-y-auto rounded-sm py-1 font-sans text-foreground",
					surfaceClasses(popupLevel, popupShadow),
				)}
				role="listbox"
			>
				{options.map((opt) => {
					const active = opt.id === currentId;
					return (
						<div
							aria-selected={active}
							className={cn(
								"mx-1 flex w-[calc(100%-0.5rem)] cursor-pointer select-none items-center gap-1.5 rounded-xs px-2.5 py-[6px] text-left text-body text-foreground leading-normal outline-none transition-colors",
								surfaceHoverBg(hoverLevel),
								active &&
									cn(
										"font-medium ring-1 ring-foreground/[0.06] ring-inset",
										surfaceBg(selectedLevel),
									),
							)}
							key={opt.id}
							onClick={() => void handleSelect(opt.id)}
							onKeyDown={(event) => handleRowKeyDown(event, opt.id)}
							role="option"
							tabIndex={0}
						>
							{opt.icon ? (
								<HugeiconsIcon
									aria-hidden="true"
									className="shrink-0 text-foreground-muted"
									icon={opt.icon}
									size={16}
									strokeWidth={active ? 2 : 1.5}
								/>
							) : null}
							<span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
								{opt.label}
							</span>
							{opt.trailing ? (
								<StopBubble className="shrink-0">{opt.trailing}</StopBubble>
							) : null}
						</div>
					);
				})}
			</div>
		</div>
	);
}
