import { Separator } from "@base-ui/react/separator";
import {
	ArrowRight01Icon,
	Bug01Icon,
	Mic01Icon,
	Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { useEffect, useReducer, useRef, useState } from "react";
import { useTranslations } from "use-intl";
import {
	buildInputDeviceOptions,
	MicrophoneLevelMeter,
	useInputDevices,
	useMicrophoneLevels,
} from "@/entities/audio-device";
import {
	copyLastTranscript,
	fileQueuePickAndEnqueue,
	onConnectionChange,
	onSettingsChanged,
	settingsLoad,
	settingsSave,
	sttIsConnected,
	trayWindowOpenSettings,
	updaterCheckNow,
	windowCloseNamed,
	windowOpenContextPlayground,
	windowQuitApp,
	windowResizeNamed,
	windowShowMain,
} from "@/shared/api/ipc-client";
import { CONTEXT_PLAYGROUND_ENABLED } from "@/shared/config/debug-flags";
import type { RecordingMode } from "@/shared/config/recording-mode-color";
import { cn } from "@/shared/lib/cn";
import {
	SurfaceProvider,
	surfaceActivePseudoBg,
	surfaceClasses,
	surfaceHoverBg,
} from "@/shared/lib/surface";
import { Button } from "@/shared/ui/button";
import { MenuHighlightLayer } from "@/shared/ui/menu-highlight";
import { Switcher } from "@/shared/ui/switcher";

interface TrayMenuState {
	inputDeviceIndex: number | null;
	isConnected: boolean;
	receivePrereleaseUpdates: boolean;
	recordingMode: RecordingMode;
}

type TrayMenuAction =
	| {
			type: "load-settings";
			receivePrereleaseUpdates: boolean;
			recordingMode: RecordingMode;
			inputDeviceIndex: number | null;
	  }
	| { type: "set-connected"; value: boolean }
	| { type: "set-recording-mode"; value: RecordingMode };

function trayMenuReducer(
	state: TrayMenuState,
	action: TrayMenuAction,
): TrayMenuState {
	switch (action.type) {
		case "load-settings":
			return {
				...state,
				receivePrereleaseUpdates: action.receivePrereleaseUpdates,
				recordingMode: action.recordingMode,
				inputDeviceIndex: action.inputDeviceIndex,
			};
		case "set-connected":
			return { ...state, isConnected: action.value };
		case "set-recording-mode":
			return { ...state, recordingMode: action.value };
		default:
			return state;
	}
}

const INITIAL_TRAY_MENU_STATE: TrayMenuState = {
	recordingMode: "ptt",
	inputDeviceIndex: null,
	isConnected: false,
	receivePrereleaseUpdates: false,
};

function isEditableShortcutTarget(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) {
		return false;
	}
	return (
		target.isContentEditable ||
		target instanceof HTMLInputElement ||
		target instanceof HTMLTextAreaElement ||
		target instanceof HTMLSelectElement
	);
}

export function TrayMenu() {
	const [state, dispatch] = useReducer(
		trayMenuReducer,
		INITIAL_TRAY_MENU_STATE,
	);
	const {
		recordingMode,
		inputDeviceIndex,
		isConnected,
		receivePrereleaseUpdates,
	} = state;
	const containerRef = useRef<HTMLDivElement | null>(null);
	const deviceListRef = useRef<HTMLDivElement | null>(null);
	const [devicePickerOpen, setDevicePickerOpen] = useState(false);
	const [highlightedDeviceId, setHighlightedDeviceId] = useState<string | null>(
		null,
	);
	const t = useTranslations("tray");
	const tAudio = useTranslations("audio");
	const { devices, defaultDevice } = useInputDevices();

	useEffect(() => {
		settingsLoad().then((settings) => {
			dispatch({
				type: "load-settings",
				receivePrereleaseUpdates:
					settings.general.receivePrereleaseUpdates ?? false,
				recordingMode: settings.general.recordingMode,
				inputDeviceIndex: settings.audio?.inputDeviceIndex ?? null,
			});
		});

		sttIsConnected().then((connected) =>
			dispatch({ type: "set-connected", value: connected }),
		);
		const unsubscribeConn = onConnectionChange((connected) => {
			dispatch({ type: "set-connected", value: connected });
		});
		// The device popup and About panel write settings from other windows; mirror
		// the relevant fields while the persistent tray window is up.
		const unsubscribeSettings = onSettingsChanged((s) => {
			dispatch({
				type: "load-settings",
				receivePrereleaseUpdates: s.general.receivePrereleaseUpdates ?? false,
				recordingMode: s.general.recordingMode,
				inputDeviceIndex: s.audio?.inputDeviceIndex ?? null,
			});
		});

		return () => {
			unsubscribeConn();
			unsubscribeSettings();
		};
	}, []);

	useEffect(() => {
		const el = containerRef.current;
		if (!el) {
			return;
		}
		const reportSize = () => {
			const rect = el.getBoundingClientRect();
			windowResizeNamed("tray-menu", rect.width, rect.height);
		};
		const observer = new ResizeObserver(reportSize);
		observer.observe(el);
		reportSize();
		return () => observer.disconnect();
	}, []);

	const closeTrayMenu = () => windowCloseNamed("tray-menu");

	const handleShowWindow = () => {
		windowShowMain();
		closeTrayMenu();
	};

	const handleSettings = () => {
		trayWindowOpenSettings();
		closeTrayMenu();
	};

	// Copy the most recent completed transcription to the clipboard. Reads the
	// history DB directly (no STT server needed), so it stays enabled offline.
	const handleCopyLastTranscript = async () => {
		await copyLastTranscript();
		closeTrayMenu();
	};

	const handleModeChange = async (mode: RecordingMode) => {
		dispatch({ type: "set-recording-mode", value: mode });
		const settings = await settingsLoad();
		await settingsSave({
			...settings,
			general: { ...settings.general, recordingMode: mode },
		});
	};

	// Keep the tray microphone selector inside the tray webview. The detached
	// transparent picker can become an invisible always-on-top input capture
	// window if it fails to paint, which makes the app look hung.
	const handleOpenDevicePicker = () => {
		setDevicePickerOpen((open) => !open);
	};

	const handleSelectDevice = async (id: string) => {
		const next = id === "default" ? null : Number.parseInt(id, 10);
		const settings = await settingsLoad();
		await settingsSave({
			...settings,
			audio: { ...settings.audio, inputDeviceIndex: next },
		});
		setDevicePickerOpen(false);
		closeTrayMenu();
	};

	const handleTranscribeFile = async () => {
		await fileQueuePickAndEnqueue();
		closeTrayMenu();
	};

	const handleCheckForUpdates = async () => {
		closeTrayMenu();
		await updaterCheckNow({
			includePrereleaseUpdates: receivePrereleaseUpdates,
		});
	};

	const handleOpenContextPlayground = () => {
		windowOpenContextPlayground();
	};

	const handleQuit = () => {
		windowQuitApp();
	};

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (
				event.defaultPrevented ||
				event.repeat ||
				isEditableShortcutTarget(event.target)
			) {
				return;
			}

			if (event.key === "Escape") {
				event.preventDefault();
				if (devicePickerOpen) {
					setDevicePickerOpen(false);
					return;
				}
				closeTrayMenu();
				return;
			}

			switch (event.key.toLowerCase()) {
				case "w":
					event.preventDefault();
					handleShowWindow();
					return;
				case ",":
					event.preventDefault();
					handleSettings();
					return;
				case "t":
					if (!isConnected) {
						return;
					}
					event.preventDefault();
					void handleTranscribeFile();
					return;
				case "q":
					event.preventDefault();
					handleQuit();
					return;
				default:
					return;
			}
		};

		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [devicePickerOpen, isConnected]);

	const recordingModeOptions: ReadonlyArray<{
		value: RecordingMode;
		label: string;
	}> = [
		{ value: "ptt", label: t("modePtt") },
		{ value: "toggle", label: t("modeToggle") },
		{ value: "listen", label: t("modeListen") },
		{ value: "wakeword", label: t("modeWakeWord") },
	];

	const defaultLabel = defaultDevice
		? `${tAudio("systemDefault")} (${defaultDevice.name})`
		: tAudio("systemDefault");
	const { deviceOptions, currentDeviceId, currentDeviceLabel } =
		buildInputDeviceOptions(
			devices,
			inputDeviceIndex,
			defaultLabel,
			defaultDevice?.name,
		);
	const levels = useMicrophoneLevels(
		devicePickerOpen,
		deviceOptions.map((option) => option.id),
	);

	// Match the settings window's panel treatment. The settings content card sits
	// at surface-3 with a `ring-1 ring-divider-strong` outline and `rounded-xl`
	// corners; the tray menu used a much-lighter surface-5 box with no ring, so it
	// read as a different app. Pin the menu to that same dark surface-3 base (items
	// lift on hover/active from there) and mirror the ring + rounding below.
	const menuLevel = 3;
	const hoverLevel = Math.min(menuLevel + 1, 8);
	const activeLevel = Math.min(menuLevel + 2, 8);
	const hoverBg = surfaceHoverBg(hoverLevel);
	const activeBg = surfaceActivePseudoBg(activeLevel);
	const devicePopupLevel = Math.min(menuLevel + 2, 8);
	return (
		<SurfaceProvider value={menuLevel}>
			<div
				className={cn(
					"relative flex flex-row-reverse items-start justify-end gap-2 transition-[width] duration-100 ease-out",
					devicePickerOpen ? "w-[440px]" : "w-[192px]",
				)}
				ref={containerRef}
			>
				{devicePickerOpen && (
					<div
						className={cn(
							"relative max-h-56 w-[240px] overflow-y-auto rounded-xl p-1 ring-1 ring-divider-strong",
							surfaceClasses(devicePopupLevel, 7),
							"font-sans text-body-sm text-foreground",
						)}
						ref={deviceListRef}
					>
						<MenuHighlightLayer
							containerRef={deviceListRef}
							value={currentDeviceId}
						/>
						{deviceOptions.map((option) => {
							const active = option.id === currentDeviceId;
							return (
								<Button
									aria-pressed={active}
									className={cn(
										"relative z-raised w-full justify-between gap-2 rounded px-2 py-1.5 text-left transition-colors",
										active ? "font-medium text-foreground" : "text-foreground",
										hoverBg,
										activeBg,
									)}
									data-menu-option={option.id}
									key={option.id}
									onBlur={() =>
										setHighlightedDeviceId((cur) =>
											cur === option.id ? null : cur,
										)
									}
									onClick={() => void handleSelectDevice(option.id)}
									onFocus={() => setHighlightedDeviceId(option.id)}
									onMouseEnter={() => setHighlightedDeviceId(option.id)}
									onMouseLeave={() =>
										setHighlightedDeviceId((cur) =>
											cur === option.id ? null : cur,
										)
									}
									{...(highlightedDeviceId === option.id
										? { "data-highlighted": "" }
										: {})}
								>
									<span className="flex min-w-0 items-center gap-2">
										<HugeiconsIcon
											aria-hidden="true"
											className="shrink-0 text-foreground-dim"
											icon={option.icon ?? Mic01Icon}
											size={13}
											strokeWidth={active ? 2 : 1.5}
										/>
										<span className="truncate">{option.label}</span>
									</span>
									<span className="flex shrink-0 items-center gap-1.5">
										{active ? (
											<HugeiconsIcon
												aria-hidden="true"
												className="text-accent"
												icon={Tick02Icon}
												size={13}
											/>
										) : null}
										<MicrophoneLevelMeter
											active={active}
											level={levels[option.id] ?? 0}
										/>
									</span>
								</Button>
							);
						})}
					</div>
				)}
				<div
					// FIXED compact width — ~31% narrower than the old ~280px menu. The big
					// win is the recording-mode switcher: a 4-wide text row (~270px) is now
					// a 2×2 grid (~half the width), so the menu no longer has to be wide to
					// hold it.
					//
					// Why fixed, not the old `w-max`: with `w-max` the menu shrinks to its
					// widest *non-shrinking* row (now the switcher), and the text labels —
					// which sit in `truncate` spans inside `min-w-0` flex rows — collapse and
					// ellipsize to fit that narrower box. Pinning the width to fit the real
					// labels keeps every action fully readable; only the genuinely variable
					// device name (its own `max-w`) still truncates. The width matches the
					// window's initial size (windows.rs), so the ResizeObserver settles it
					// with no first-frame jump.
					className={cn(
						"w-[192px] rounded-xl p-1 ring-1 ring-divider-strong",
						surfaceClasses(menuLevel, Math.max(menuLevel, 7)),
						"font-sans text-body-sm text-foreground",
					)}
				>
					<MenuItem
						activeBg={activeBg}
						hoverBg={hoverBg}
						onClick={handleShowWindow}
						shortcut="W"
					>
						{t("showWindow")}
					</MenuItem>
					<MenuItem
						activeBg={activeBg}
						hoverBg={hoverBg}
						onClick={handleSettings}
						shortcut=","
					>
						{t("openSettings")}
					</MenuItem>
					<MenuItem
						activeBg={activeBg}
						hoverBg={hoverBg}
						onClick={handleCopyLastTranscript}
					>
						{t("copyLastTranscript")}
					</MenuItem>

					<MenuSeparator />

					<div className="p-1">
						<Switcher
							columns={2}
							fullWidth
							onChange={handleModeChange}
							options={recordingModeOptions}
							value={recordingMode}
						/>
					</div>

					<MenuSeparator />

					<div className="relative">
						<Button
							className={cn(
								"w-full justify-between gap-2 rounded px-2.5 py-1.5 text-left transition-colors",
								hoverBg,
								"hover:text-foreground",
								activeBg,
							)}
							onClick={handleOpenDevicePicker}
						>
							<span className="flex min-w-0 items-center gap-2">
								<HugeiconsIcon
									aria-hidden="true"
									className="shrink-0 text-foreground-dim"
									icon={Mic01Icon}
									size={13}
								/>
								{/* Cap the device name so a long label (e.g. "System Default
							    (Microphone (Realtek(R) Audio))") truncates here instead of
							    eating the whole fixed-width row (keeps the chevron visible). */}
								<span className="max-w-[9rem] truncate">
									{currentDeviceLabel}
								</span>
							</span>
							<HugeiconsIcon
								aria-hidden="true"
								className={cn(
									"shrink-0 text-foreground-muted transition-transform",
									devicePickerOpen && "rotate-180",
								)}
								icon={ArrowRight01Icon}
								size={11}
							/>
						</Button>
					</div>

					<MenuSeparator />

					<MenuItem
						activeBg={activeBg}
						disabled={!isConnected}
						hoverBg={hoverBg}
						onClick={handleTranscribeFile}
						shortcut="T"
					>
						{t("transcribeFile")}
					</MenuItem>
					<MenuItem
						activeBg={activeBg}
						hoverBg={hoverBg}
						onClick={handleCheckForUpdates}
					>
						{t("checkForUpdates")}
					</MenuItem>

					{CONTEXT_PLAYGROUND_ENABLED && (
						<>
							<MenuSeparator />
							{/* eslint-disable i18next/no-literal-string -- debug-only menu item, gated off in release */}
							<MenuItem
								activeBg={activeBg}
								hoverBg={hoverBg}
								icon={Bug01Icon}
								onClick={handleOpenContextPlayground}
							>
								Context Playground (debug)
							</MenuItem>
							{/* eslint-enable i18next/no-literal-string */}
						</>
					)}

					<MenuSeparator />

					<MenuItem
						activeBg={activeBg}
						hoverBg={hoverBg}
						onClick={handleQuit}
						shortcut="Q"
					>
						{t("quit")}
					</MenuItem>
				</div>
			</div>
		</SurfaceProvider>
	);
}

interface MenuItemProps {
	activeBg: string;
	children: React.ReactNode;
	disabled?: boolean;
	hoverBg: string;
	icon?: IconSvgElement;
	onClick?: () => void;
	shortcut?: string;
}

function MenuItem({
	children,
	onClick,
	disabled,
	shortcut,
	hoverBg,
	activeBg,
	icon,
}: MenuItemProps) {
	return (
		<Button
			className={cn(
				"w-full justify-between gap-2 rounded px-2.5 py-1.5 text-left transition-colors",
				disabled
					? "text-foreground-dim"
					: `${hoverBg} ${activeBg} hover:text-foreground`,
			)}
			disabled={disabled}
			onClick={onClick}
		>
			<span className="flex min-w-0 items-center gap-2">
				{icon && (
					<HugeiconsIcon
						aria-hidden="true"
						className="shrink-0 text-foreground-dim"
						icon={icon}
						size={13}
					/>
				)}
				<span className="truncate">{children}</span>
			</span>
			{shortcut && (
				// Way-smaller, non-shrinking hint column so the label (which truncates)
				// yields width first — keeps the accelerator visible without widening
				// the now-compact menu.
				<span className="shrink-0 text-[8px] tracking-tight text-foreground-muted">
					{shortcut}
				</span>
			)}
		</Button>
	);
}

function MenuSeparator() {
	return <Separator className="my-1 h-px bg-border" />;
}
