import { Separator } from "@base-ui/react/separator";
import {
	AppWindowIcon,
	ArrowReloadHorizontalIcon,
	ArrowRight01Icon,
	Bug01Icon,
	ClipboardCopyIcon,
	FileAudioIcon,
	Logout03Icon,
	Mic01Icon,
	Settings05Icon,
	VoiceIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { type ReactNode, useEffect, useReducer, useRef } from "react";
import { useTranslations } from "use-intl";
import {
	InlineInputDeviceList,
	useInputDevicePickerModel,
	useInputDevices,
} from "@/entities/audio-device";
import { useCatalogStore, useModelStateStore } from "@/entities/model-catalog";
import { openSettingsToSection } from "@/entities/setting";
import { resolveListenStreamingModelId } from "@/features/listen-mode";
import { useModeTransitionPending } from "@/features/recording-mode-transition";
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
import {
	focusViewInitialTarget,
	NavPopoverHeader,
	NavPopoverStage,
	useViewStack,
} from "@/shared/ui/nav-popover";
import { PendingBadge } from "@/shared/ui/pending";
import { Switcher } from "@/shared/ui/switcher";

interface TrayMenuState {
	inputDeviceIndex: number | null;
	inputDevicePriority: string[];
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
			inputDevicePriority: string[];
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
				inputDevicePriority: action.inputDevicePriority,
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
	inputDevicePriority: [],
	isConnected: false,
	receivePrereleaseUpdates: false,
};

const TRAY_MENU_OPEN_SHELL_CLASS = "tray-menu-open-shell";
const TRAY_MENU_OPEN_ANIMATION_CLASS = "tray-menu-open-enter";
const TRAY_MENU_WILL_OPEN_EVENT = "winstt:tray-menu-will-open";
const TRAY_MENU_OPENED_EVENT = "winstt:tray-menu-opened";
const TRAY_MENU_HIDDEN_EVENT = "winstt:tray-menu-hidden";

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

const closeTrayMenu = () => windowCloseNamed("tray-menu");

const handleOpenContextPlayground = () => {
	windowOpenContextPlayground();
};

const handleQuit = () => {
	windowQuitApp();
};

function handleShowWindow(): void {
	windowShowMain();
	closeTrayMenu();
}

function handleSettings(): void {
	trayWindowOpenSettings();
	closeTrayMenu();
}

async function handleCopyLastTranscript(): Promise<void> {
	await copyLastTranscript();
	closeTrayMenu();
}

async function handleTranscribeFile(): Promise<void> {
	await fileQueuePickAndEnqueue();
	closeTrayMenu();
}

async function saveInputDeviceIndex(
	inputDeviceIndex: number | null,
): Promise<void> {
	const settings = await settingsLoad();
	await settingsSave({
		audio: { ...settings.audio, inputDeviceIndex },
	});
}

async function saveInputDevicePriority(
	inputDevicePriority: string[],
): Promise<void> {
	const settings = await settingsLoad();
	await settingsSave({
		audio: { ...settings.audio, inputDevicePriority },
	});
}

function useTrayMenuRender() {
	const [state, dispatch] = useReducer(
		trayMenuReducer,
		INITIAL_TRAY_MENU_STATE,
	);
	const {
		recordingMode,
		inputDeviceIndex,
		inputDevicePriority,
		isConnected,
		receivePrereleaseUpdates,
	} = state;
	const containerRef = useRef<HTMLDivElement | null>(null);
	const t = useTranslations("tray");
	const tAudio = useTranslations("audio");
	const refreshModelState = useModelStateStore((s) => s.refresh);
	const { devices, defaultDevice } = useInputDevices();
	// Recording mode and microphone are drill-down views rather than controls
	// inlined into the menu: both used to open a popup *inside* a ~192px OS
	// window, where the popup is clipped by the window itself.
	const nav = useViewStack();
	// The single-letter shortcuts and Escape below run from a window-level
	// listener, so they read nav state through a ref written after commit.
	const navRef = useRef(nav);
	useEffect(() => {
		navRef.current = nav;
	});
	// Drilling in moves focus into the new view; without it a keyboard user is
	// left on a button that no longer exists and Tab restarts from the top.
	useEffect(() => {
		const el = containerRef.current;
		if (el !== null && nav.activeId !== null) {
			focusViewInitialTarget(el);
		}
	}, [nav.activeId]);

	useEffect(() => {
		void refreshModelState();
	}, [refreshModelState]);

	useEffect(() => {
		const resetOpenAnimation = () => {
			const el = containerRef.current;
			if (!el) {
				return;
			}
			el.classList.remove(TRAY_MENU_OPEN_ANIMATION_CLASS);
		};

		const playOpenAnimation = () => {
			const el = containerRef.current;
			if (!el) {
				return;
			}
			el.classList.remove(TRAY_MENU_OPEN_ANIMATION_CLASS);
			void el.offsetWidth;
			el.classList.add(TRAY_MENU_OPEN_ANIMATION_CLASS);
		};

		window.addEventListener(TRAY_MENU_WILL_OPEN_EVENT, resetOpenAnimation);
		window.addEventListener(TRAY_MENU_OPENED_EVENT, playOpenAnimation);
		window.addEventListener(TRAY_MENU_HIDDEN_EVENT, resetOpenAnimation);
		return () => {
			window.removeEventListener(TRAY_MENU_WILL_OPEN_EVENT, resetOpenAnimation);
			window.removeEventListener(TRAY_MENU_OPENED_EVENT, playOpenAnimation);
			window.removeEventListener(TRAY_MENU_HIDDEN_EVENT, resetOpenAnimation);
		};
	}, []);

	useEffect(() => {
		settingsLoad().then((settings) => {
			dispatch({
				type: "load-settings",
				receivePrereleaseUpdates:
					settings.general.receivePrereleaseUpdates ?? false,
				recordingMode: settings.general.recordingMode,
				inputDeviceIndex: settings.audio?.inputDeviceIndex ?? null,
				inputDevicePriority: settings.audio?.inputDevicePriority ?? [],
			});
		});

		sttIsConnected().then((connected) =>
			dispatch({ type: "set-connected", value: connected }),
		);
		const unsubscribeConn = onConnectionChange((connected) => {
			dispatch({ type: "set-connected", value: connected });
		});
		const unsubscribeSettings = onSettingsChanged((s) => {
			dispatch({
				type: "load-settings",
				receivePrereleaseUpdates: s.general.receivePrereleaseUpdates ?? false,
				recordingMode: s.general.recordingMode,
				inputDeviceIndex: s.audio?.inputDeviceIndex ?? null,
				inputDevicePriority: s.audio?.inputDevicePriority ?? [],
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

	const handleModeChange = async (mode: RecordingMode) => {
		// The switcher is already rendered disabled while a mode's model loads;
		// guard the value path too so a keyboard select can't stack a second
		// switch behind the in-flight one.
		if (modeTransition.isPending) {
			return;
		}
		const settings = await settingsLoad();
		if (mode === "listen") {
			await refreshModelState();
			const listenModelId = resolveListenStreamingModelId(
				settings.model,
				settings.quality,
				useCatalogStore.getState().models,
				useModelStateStore.getState().statesById,
			);
			if (listenModelId === null) {
				dispatch({
					type: "set-recording-mode",
					value: settings.general.recordingMode,
				});
				openSettingsToSection("model");
				closeTrayMenu();
				return;
			}
		}
		dispatch({ type: "set-recording-mode", value: mode });
		// Picking is the whole reason the view was opened, so return to the menu
		// instead of leaving the user to find the back button.
		nav.back();
		await settingsSave({
			general: { ...settings.general, recordingMode: mode },
		});
	};

	const handleCheckForUpdates = async () => {
		closeTrayMenu();
		await updaterCheckNow({
			includePrereleaseUpdates: receivePrereleaseUpdates,
		});
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
				// Escape unwinds the hierarchy first; only an Escape at the root
				// dismisses the menu.
				if (navRef.current.depth > 0) {
					navRef.current.back();
					return;
				}
				closeTrayMenu();
				return;
			}

			// The letter accelerators belong to the root menu's items. Inside a
			// sub-view they would fire actions whose rows are not even on screen.
			if (navRef.current.depth > 0) {
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
	}, [isConnected]);

	// Mode changes are process-global, so the tray reflects a switch started from
	// the settings window (or the PTT+ArrowUp gesture) exactly like its own.
	const modeTransition = useModeTransitionPending();
	const baseRecordingModeOptions: ReadonlyArray<{
		value: RecordingMode;
		disabled?: boolean;
		label: string;
	}> = [
		{ value: "ptt", label: t("modePtt") },
		{ value: "toggle", label: t("modeToggle") },
		{ value: "listen", label: t("modeListen") },
		{ value: "wakeword", label: t("modeWakeWord") },
	];
	const recordingModeOptions = modeTransition.isPending
		? baseRecordingModeOptions.map((option) => ({ ...option, disabled: true }))
		: baseRecordingModeOptions;
	const activeModeLabel =
		recordingModeOptions.find((option) => option.value === recordingMode)
			?.label ?? "";
	// Root-row summary only — `monitorOpen: false` keeps the level meters (and
	// their audio capture) off until the microphone view is actually open.
	const { currentDeviceLabel } = useInputDevicePickerModel({
		defaultDeviceName: defaultDevice?.name,
		devices,
		inputDeviceIndex,
		inputDevicePriority,
		monitorOpen: false,
		systemDefaultLabel: tAudio("systemDefault"),
	});

	const menuLevel = 3;
	const hoverLevel = Math.min(menuLevel + 1, 8);
	const activeLevel = Math.min(menuLevel + 2, 8);
	const hoverBg = surfaceHoverBg(hoverLevel);
	const activeBg = surfaceActivePseudoBg(activeLevel);
	return (
		<SurfaceProvider value={menuLevel}>
			<div
				className={cn(
					TRAY_MENU_OPEN_SHELL_CLASS,
					// The OS window is sized exactly to this shell, so the menu's
					// box-shadow spilling into the p-0.5 gutter would be cut off
					// SQUARE at the window corners. Clip the shell along a rounded
					// path — menu rounded-xl (0.75rem) + the 0.125rem gutter — so
					// all four corners of the clipped shadow stay round.
					"relative w-[196px] overflow-hidden rounded-[0.875rem] p-0.5 transition-[width] duration-100 ease-out",
				)}
				ref={containerRef}
			>
				<div
					className={cn(
						"w-[192px] rounded-xl p-1 ring-1 ring-divider-strong",
						surfaceClasses(menuLevel, Math.max(menuLevel, 7)),
						"font-sans text-body-sm text-foreground",
					)}
				>
					<NavPopoverStage
						activeKey={nav.activeId ?? "__root__"}
						direction={nav.direction}
					>
						{nav.activeId === "mode" ? (
							<>
								<NavPopoverHeader
									backLabel={t("backToMenu")}
									onBack={nav.back}
									title={t("recordingMode")}
								/>
								<div className="p-1">
									{/* 2×2, not one column: `columns={1}` falls through to the
									    single-row flex mode, whose four segments together
									    overflow the tray's 185px content width. */}
									<PendingBadge
										className="w-full"
										pending={modeTransition.isPending}
									>
										<Switcher
											columns={2}
											fullWidth
											onChange={handleModeChange}
											options={recordingModeOptions}
											value={recordingMode}
										/>
									</PendingBadge>
								</div>
							</>
						) : null}
						{nav.activeId === "microphone" ? (
							<>
								<NavPopoverHeader
									backLabel={t("backToMenu")}
									onBack={nav.back}
									title={tAudio("inputDevice")}
								/>
								<div className="p-1">
									<InlineInputDeviceList
										ariaLabel={tAudio("inputDevice")}
										inputDeviceIndex={inputDeviceIndex}
										inputDevicePriority={inputDevicePriority}
										onChange={(value) => void saveInputDeviceIndex(value)}
										onPicked={nav.back}
										onPriorityChange={(value) =>
											void saveInputDevicePriority(value)
										}
										reorderHandleLabel={tAudio("devicePriorityHandle")}
										systemDefaultLabel={tAudio("systemDefault")}
									/>
								</div>
							</>
						) : null}
						{nav.activeId === null ? (
							<>
								<MenuItem
									activeBg={activeBg}
									hoverBg={hoverBg}
									icon={AppWindowIcon}
									onClick={handleShowWindow}
									shortcut="W"
								>
									{t("showWindow")}
								</MenuItem>
								<MenuItem
									activeBg={activeBg}
									hoverBg={hoverBg}
									icon={Settings05Icon}
									onClick={handleSettings}
									shortcut=","
								>
									{t("openSettings")}
								</MenuItem>
								<MenuItem
									activeBg={activeBg}
									hoverBg={hoverBg}
									icon={ClipboardCopyIcon}
									onClick={handleCopyLastTranscript}
								>
									{t("copyLastTranscript")}
								</MenuItem>

								<MenuSeparator />

								<MenuItem
									activeBg={activeBg}
									hoverBg={hoverBg}
									icon={VoiceIcon}
									onClick={() => nav.push("mode")}
									value={activeModeLabel}
								>
									{t("recordingMode")}
								</MenuItem>
								<MenuItem
									activeBg={activeBg}
									hoverBg={hoverBg}
									icon={Mic01Icon}
									onClick={() => nav.push("microphone")}
									value={currentDeviceLabel}
								>
									{tAudio("inputDevice")}
								</MenuItem>

								<MenuSeparator />

								<MenuItem
									activeBg={activeBg}
									disabled={!isConnected}
									hoverBg={hoverBg}
									icon={FileAudioIcon}
									onClick={handleTranscribeFile}
									shortcut="T"
								>
									{t("transcribeFile")}
								</MenuItem>
								<MenuItem
									activeBg={activeBg}
									hoverBg={hoverBg}
									icon={ArrowReloadHorizontalIcon}
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
									icon={Logout03Icon}
									onClick={handleQuit}
									shortcut="Q"
								>
									{t("quit")}
								</MenuItem>
							</>
						) : null}
					</NavPopoverStage>
				</div>
			</div>
		</SurfaceProvider>
	);
}

export function TrayMenu() {
	return useTrayMenuRender();
}

interface MenuItemProps {
	activeBg: string;
	children: ReactNode;
	disabled?: boolean;
	hoverBg: string;
	icon?: IconSvgElement;
	onClick?: () => void;
	shortcut?: string;
	/** Current setting of a drill-down row. Renders in place of the shortcut,
	 *  followed by a chevron — the row's promise that there is a view behind
	 *  it. */
	value?: string;
}

function MenuItem({
	children,
	onClick,
	disabled,
	shortcut,
	hoverBg,
	activeBg,
	icon,
	value,
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
			{value === undefined ? null : (
				<span className="flex min-w-0 shrink items-center gap-0.5 text-foreground-muted">
					<span className="truncate text-[10px]">{value}</span>
					<HugeiconsIcon
						aria-hidden="true"
						className="shrink-0"
						icon={ArrowRight01Icon}
						size={12}
					/>
				</span>
			)}
			{shortcut && (
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
