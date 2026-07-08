import { Button as BaseButton } from "@base-ui/react/button";
import { Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useRef, useState } from "react";
import { useTranslations } from "use-intl";
import {
	priorityFromReorderedOptions,
	promoteDeviceNameToTop,
	useInputDevicePickerModel,
	useInputDevices,
} from "@/entities/audio-device";
import {
	onSettingsChanged,
	settingsLoad,
	settingsSave,
	windowCloseNamed,
	windowResizeNamed,
} from "@/shared/api/ipc-client";
import { cn } from "@/shared/lib/cn";
import { surfaceClasses } from "@/shared/lib/surface";
import { useEscapeToClose } from "@/shared/lib/window-effects";
import { MenuHighlightLayer } from "@/shared/ui/menu-highlight";
import {
	OptionDragHandle,
	SelectOptionContent,
	SortableOptionRows,
	StopBubble,
} from "@/shared/ui/select";

// This detached tray picker shares the same popup level used by the settings
// Select for the mic control: settings section content sits at surface-2, the
// Select self-elevates, then its popup lands on surface-5 with a surface-6
// shadow. Keeping the detached shell on that pair makes the two pickers read as
// one implementation even though the tray version lives in its own window.
const PANEL_LEVEL = 5;
const PANEL_SHADOW_LEVEL = 6;

// Dispatched by the Rust placement/close paths (windows/placement.rs). The
// window is PREWARMED (created hidden at startup) and dismissed via hide(),
// neither of which the page can observe — so visibility must be pushed in.
const DEVICE_PICKER_SHOWN_EVENT = "winstt:device-picker-shown";
const DEVICE_PICKER_HIDDEN_EVENT = "winstt:device-picker-hidden";

/** Is the picker window actually on screen? Gates the microphone level
 *  monitor: metering while hidden would hold every input device open in the
 *  background from boot (and fight the Settings mic selects over the single
 *  global monitor, flapping the devices open/closed). */
function useDevicePickerShown(): boolean {
	const [shown, setShown] = useState(false);
	useEffect(() => {
		const onShown = () => setShown(true);
		const onHidden = () => setShown(false);
		window.addEventListener(DEVICE_PICKER_SHOWN_EVENT, onShown);
		window.addEventListener(DEVICE_PICKER_HIDDEN_EVENT, onHidden);
		return () => {
			window.removeEventListener(DEVICE_PICKER_SHOWN_EVENT, onShown);
			window.removeEventListener(DEVICE_PICKER_HIDDEN_EVENT, onHidden);
		};
	}, []);
	return shown;
}

function close(): void {
	windowCloseNamed("device-picker");
}

/**
 * Renderer half of the detached input-device picker. The tray menu is a tiny
 * popup; expanding the device list inside it ballooned the window off-screen.
 * This hosts the list in its own window instead, mirrors the tray's selection
 * (`settings.audio.inputDeviceIndex`) over IPC, and reports its content size
 * back so the OS window hugs the list.
 *
 * Styled to match the app's fluidfunctionalism `Select` popup: the same
 * `MenuHighlightLayer` gliding selected (accent) / hover (neutral) pills, an
 * accent checkmark on the active device, and hugeicons rows. Because the window
 * IS the open popup (no trigger), the rows are plain buttons that drive the
 * highlight layer manually — `data-menu-option` marks each row's id (so the
 * selected pill can find the active device) and a `highlightedId` state stamps
 * `data-highlighted` on hover/focus (so the hover pill glides, exactly like Base
 * UI's `data-highlighted` does inside `Select`).
 *
 * Device rows carry a trailing grip handle: drag-sorting them persists
 * `settings.audio.inputDevicePriority` (device names, highest first), and the
 * effective mic auto-follows the topmost CONNECTED entry. Clicking a device
 * promotes it to the top of that list; clicking "System default" clears it.
 */
export function DevicePickerWindow() {
	const t = useTranslations("audio");
	const { devices, defaultDevice } = useInputDevices();
	const [inputDeviceIndex, setInputDeviceIndex] = useState<number | null>(null);
	const [inputDevicePriority, setInputDevicePriority] = useState<string[]>([]);
	const [highlightedId, setHighlightedId] = useState<string | null>(null);
	const [dragSorting, setDragSorting] = useState(false);
	const containerRef = useRef<HTMLDivElement | null>(null);
	const listRef = useRef<HTMLDivElement | null>(null);
	useEscapeToClose(close);

	useEffect(() => {
		settingsLoad().then((s) => {
			setInputDeviceIndex(s.audio?.inputDeviceIndex ?? null);
			setInputDevicePriority(s.audio?.inputDevicePriority ?? []);
		});
		return onSettingsChanged((s) => {
			setInputDeviceIndex(s.audio?.inputDeviceIndex ?? null);
			setInputDevicePriority(s.audio?.inputDevicePriority ?? []);
		});
	}, []);

	// Report the live content size so the main process can hug the window to
	// the list and re-anchor it above the row (device count varies).
	useEffect(() => {
		const el = containerRef.current;
		if (!el) {
			return;
		}
		const report = () => {
			const r = el.getBoundingClientRect();
			windowResizeNamed("device-picker", r.width, r.height);
		};
		const observer = new ResizeObserver(report);
		observer.observe(el);
		report();
		return () => observer.disconnect();
	}, []);

	const shown = useDevicePickerShown();
	const { deviceOptions, currentDeviceId } = useInputDevicePickerModel({
		defaultDeviceName: defaultDevice?.name,
		devices,
		inputDeviceIndex,
		inputDevicePriority,
		monitorOpen: shown,
		systemDefaultLabel: t("systemDefault"),
	});

	const handleSelect = async (id: string) => {
		const settings = await settingsLoad();
		const priority = settings.audio?.inputDevicePriority ?? [];
		const next = id === "default" ? null : Number.parseInt(id, 10);
		const name = deviceOptions.find((o) => o.id === id)?.label;
		// A click must win over the preference order: promote the chosen device
		// to the top (or clear the order entirely for "System default").
		const nextPriority =
			id === "default"
				? []
				: priority.length > 0 && name
					? promoteDeviceNameToTop(priority, name)
					: priority;
		await settingsSave({
			audio: {
				...settings.audio,
				inputDeviceIndex: next,
				inputDevicePriority: nextPriority,
			},
		});
		close();
	};

	const persistPriority = async (orderedIds: string[]) => {
		const names = priorityFromReorderedOptions(deviceOptions, orderedIds);
		setInputDevicePriority(names); // optimistic — keeps the rows where dropped
		const settings = await settingsLoad();
		await settingsSave({
			audio: { ...settings.audio, inputDevicePriority: names },
		});
	};

	return (
		<div className="flex h-screen w-screen items-end overflow-hidden">
			<div
				className={cn(
					"select-popup max-h-screen w-full overflow-y-auto rounded-lg py-1.5",
					surfaceClasses(PANEL_LEVEL, PANEL_SHADOW_LEVEL),
					"font-sans text-foreground",
				)}
				ref={containerRef}
			>
				{/* `position: relative` anchor the gliding pills measure against; rows
				    carry `data-menu-option` and scroll inside the panel together with it. */}
				<div className="relative" ref={listRef}>
					<MenuHighlightLayer containerRef={listRef} value={currentDeviceId} />
					<SortableOptionRows
						onReorder={(orderedIds) => persistPriority(orderedIds)}
						onSortingChange={setDragSorting}
						options={deviceOptions}
						renderRow={(opt) => {
							const active = opt.id === currentDeviceId;
							return (
								<div
									className="relative z-raised mx-1 flex w-[calc(100%-0.5rem)] select-none items-center rounded-lg pl-2 text-body text-foreground leading-normal"
									data-menu-option={opt.id}
									onBlur={() =>
										setHighlightedId((cur) => (cur === opt.id ? null : cur))
									}
									onFocus={() => setHighlightedId(opt.id)}
									onMouseEnter={() => {
										if (!dragSorting) {
											setHighlightedId(opt.id);
										}
									}}
									onMouseLeave={() =>
										setHighlightedId((cur) => (cur === opt.id ? null : cur))
									}
									{...(highlightedId === opt.id && !dragSorting
										? { "data-highlighted": "" }
										: {})}
								>
									{opt.sortable ? (
										<OptionDragHandle label={t("devicePriorityHandle")} />
									) : (
										<span aria-hidden="true" className="size-5 shrink-0" />
									)}
									<BaseButton
										aria-pressed={active}
										className={cn(
											"flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-lg py-2.5 pr-3 pl-2 text-left outline-none",
											active ? "font-medium" : "",
										)}
										onClick={() => handleSelect(opt.id)}
										type="button"
									>
										<SelectOptionContent active={active} option={opt} />
										{active ? (
											<HugeiconsIcon
												aria-hidden="true"
												className="shrink-0 text-accent"
												icon={Tick02Icon}
												size={16}
											/>
										) : null}
										{opt.trailing ? (
											<StopBubble className="shrink-0">
												{opt.trailing}
											</StopBubble>
										) : null}
									</BaseButton>
								</div>
							);
						}}
					/>
				</div>
			</div>
		</div>
	);
}
