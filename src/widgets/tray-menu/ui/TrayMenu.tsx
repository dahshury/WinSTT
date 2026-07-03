import { Separator } from "@base-ui/react/separator";
import {
	AppWindowIcon,
	ArrowRight01Icon,
	ArrowReloadHorizontalIcon,
	Bug01Icon,
	ClipboardCopyIcon,
	FileAudioIcon,
	Logout03Icon,
	Mic01Icon,
	Settings05Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import {
	type MouseEvent,
	type ReactNode,
	useEffect,
	useReducer,
	useRef,
} from "react";
import { useTranslations } from "use-intl";
import {
	useInputDevicePickerModel,
	useInputDevices,
} from "@/entities/audio-device";
import { useCatalogStore, useModelStateStore } from "@/entities/model-catalog";
import { useSettingsTabStore } from "@/entities/setting";
import { resolveListenStreamingModelId } from "@/features/listen-mode";
import {
	copyLastTranscript,
	devicePickerWindowOpen,
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

function useTrayMenuRender() {
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
	const t = useTranslations("tray");
	const tAudio = useTranslations("audio");
	const { devices, defaultDevice } = useInputDevices();
	const refreshModelState = useModelStateStore((s) => s.refresh);

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
				useSettingsTabStore.getState().setActiveTab("model");
				trayWindowOpenSettings();
				closeTrayMenu();
				return;
			}
		}
		dispatch({ type: "set-recording-mode", value: mode });
		await settingsSave({
			general: { ...settings.general, recordingMode: mode },
		});
	};

	const handleOpenDevicePicker = (event: MouseEvent<HTMLButtonElement>) => {
		devicePickerWindowOpen(event.currentTarget.getBoundingClientRect());
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
	}, [isConnected]);

	const recordingModeOptions: ReadonlyArray<{
		value: RecordingMode;
		label: string;
	}> = [
		{ value: "ptt", label: t("modePtt") },
		{ value: "toggle", label: t("modeToggle") },
		{ value: "listen", label: t("modeListen") },
		{ value: "wakeword", label: t("modeWakeWord") },
	];

	const { currentDeviceIcon, currentDeviceLabel } = useInputDevicePickerModel({
		defaultDeviceName: defaultDevice?.name,
		devices,
		inputDeviceIndex,
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
									icon={currentDeviceIcon ?? Mic01Icon}
									size={13}
								/>
								<span className="max-w-[9rem] truncate">
									{currentDeviceLabel}
								</span>
							</span>
							<HugeiconsIcon
								aria-hidden="true"
								className={cn(
									"shrink-0 text-foreground-muted transition-transform",
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
