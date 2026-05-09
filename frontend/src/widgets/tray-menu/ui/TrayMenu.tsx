"use client";

import { Separator } from "@base-ui/react/separator";
import { ArrowDown01Icon, Mic01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState } from "react";
import { useInputDevices } from "@/entities/audio-device";
import { IPC } from "@/shared/api/ipc-channels";
import {
	dialogOpenFile,
	fileTranscribe,
	ipcSend,
	onConnectionChange,
	settingsLoad,
	settingsSave,
	sttIsConnected,
} from "@/shared/api/ipc-client";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { Switcher } from "@/shared/ui/switcher";

type RecordingMode = "ptt" | "toggle" | "listen";

export function TrayMenu() {
	const [recordingMode, setRecordingMode] = useState<RecordingMode>("ptt");
	const [inputDeviceIndex, setInputDeviceIndex] = useState<number | null>(null);
	const [isDeviceListOpen, setIsDeviceListOpen] = useState(false);
	const [isConnected, setIsConnected] = useState(false);
	const containerRef = useRef<HTMLDivElement | null>(null);
	const t = useTranslations("tray");
	const tAudio = useTranslations("audio");
	const { devices, defaultDevice } = useInputDevices();

	useEffect(() => {
		settingsLoad().then((settings) => {
			setRecordingMode(settings.general.recordingMode);
			setInputDeviceIndex(settings.audio?.inputDeviceIndex ?? null);
		});

		// Get initial connection state + listen for changes
		sttIsConnected().then((connected) => setIsConnected(connected));
		const unsubscribe = onConnectionChange((connected) => {
			setIsConnected(connected);
		});

		return unsubscribe;
	}, []);

	useEffect(() => {
		const el = containerRef.current;
		if (!el) {
			return;
		}
		const reportSize = () => {
			const rect = el.getBoundingClientRect();
			ipcSend(IPC.TRAY_MENU_RESIZE, { width: rect.width, height: rect.height });
		};
		const observer = new ResizeObserver(reportSize);
		observer.observe(el);
		reportSize();
		return () => observer.disconnect();
	}, []);

	const closeTrayMenu = () => ipcSend(IPC.TRAY_MENU_CLOSE);

	const handleShowWindow = () => {
		ipcSend(IPC.WINDOW_SHOW);
		closeTrayMenu();
	};

	const handleSettings = () => {
		ipcSend(IPC.WINDOW_OPEN_SETTINGS);
		closeTrayMenu();
	};

	const handleModeChange = async (mode: RecordingMode) => {
		setRecordingMode(mode);
		const settings = await settingsLoad();
		await settingsSave({
			...settings,
			general: { ...settings.general, recordingMode: mode },
		});
	};

	const handleDeviceChange = async (id: string) => {
		const next = id === "default" ? null : Number.parseInt(id, 10);
		setInputDeviceIndex(next);
		setIsDeviceListOpen(false);
		const settings = await settingsLoad();
		await settingsSave({
			...settings,
			audio: { ...settings.audio, inputDeviceIndex: next },
		});
	};

	const handleTranscribeFile = async () => {
		const filePath = await dialogOpenFile(
			[
				{ name: t("audioFiles"), extensions: ["mp3", "wav", "flac", "m4a", "aac", "ogg", "wma"] },
				{ name: t("videoFiles"), extensions: ["mp4", "mkv", "avi", "mov", "wmv", "flv", "webm"] },
				{ name: t("allFiles"), extensions: ["*"] },
			],
			t("selectFileTitle")
		);

		if (filePath) {
			await fileTranscribe(filePath);
		}
		closeTrayMenu();
	};

	const handleQuit = () => {
		ipcSend(IPC.WINDOW_QUIT);
	};

	const recordingModeOptions: ReadonlyArray<{ value: RecordingMode; label: string }> = [
		{ value: "ptt", label: t("modePtt") },
		{ value: "toggle", label: t("modeToggle") },
		{ value: "listen", label: t("modeListen") },
	];

	const { deviceOptions, currentDeviceId, currentDeviceLabel } = useMemo(() => {
		const defaultLabel = defaultDevice
			? `${tAudio("systemDefault")} (${defaultDevice.name})`
			: tAudio("systemDefault");
		const opts: { id: string; label: string }[] = [{ id: "default", label: defaultLabel }];
		for (const d of devices) {
			opts.push({ id: String(d.index), label: d.name });
		}
		const id = inputDeviceIndex == null ? "default" : String(inputDeviceIndex);
		const found = opts.find((o) => o.id === id);
		return {
			deviceOptions: opts,
			currentDeviceId: id,
			currentDeviceLabel: found?.label ?? defaultLabel,
		};
	}, [devices, defaultDevice, inputDeviceIndex, tAudio]);

	return (
		<div
			className={cn(
				"w-fit rounded-md border border-border bg-surface p-1 shadow-2xl",
				"font-sans text-body-sm text-foreground"
			)}
			ref={containerRef}
		>
			<MenuItem onClick={handleShowWindow} shortcut="Ctrl+Shift+W">
				{t("showWindow")}
			</MenuItem>
			<MenuItem onClick={handleSettings} shortcut="Ctrl+,">
				{t("openSettings")}
			</MenuItem>

			<MenuSeparator />

			<div className="p-1">
				<Switcher
					fullWidth
					onChange={handleModeChange}
					options={recordingModeOptions}
					value={recordingMode}
				/>
			</div>

			<MenuSeparator />

			<Button
				aria-expanded={isDeviceListOpen}
				className={cn(
					"w-full justify-between gap-3 rounded px-3 py-1.5 text-left transition-colors",
					"hover:bg-surface-hover hover:text-foreground active:bg-surface-active"
				)}
				onClick={() => setIsDeviceListOpen((v) => !v)}
			>
				<span className="flex min-w-0 items-center gap-2">
					<HugeiconsIcon
						aria-hidden="true"
						className="shrink-0 text-foreground-dim"
						icon={Mic01Icon}
						size={13}
					/>
					<span className="truncate">{currentDeviceLabel}</span>
				</span>
				<HugeiconsIcon
					aria-hidden="true"
					className={cn(
						"shrink-0 text-foreground-muted transition-transform",
						isDeviceListOpen && "rotate-180"
					)}
					icon={ArrowDown01Icon}
					size={11}
				/>
			</Button>
			{isDeviceListOpen && (
				<div className="mx-1 mt-0.5 max-h-48 overflow-y-auto rounded-sm border border-border bg-surface-secondary py-0.5">
					{deviceOptions.map((opt) => (
						<Button
							aria-pressed={opt.id === currentDeviceId}
							className={cn(
								"w-full justify-start truncate rounded px-2 py-1 text-left text-2xs transition-colors hover:bg-surface-hover",
								opt.id === currentDeviceId ? "text-accent" : "text-foreground-dim"
							)}
							key={opt.id}
							onClick={() => handleDeviceChange(opt.id)}
						>
							<span className="truncate">{opt.label}</span>
						</Button>
					))}
				</div>
			)}

			<MenuSeparator />

			<MenuItem disabled={!isConnected} onClick={handleTranscribeFile} shortcut="Ctrl+Shift+T">
				{t("transcribeFile")}
			</MenuItem>
			<MenuItem disabled>{t("checkForUpdates")}</MenuItem>

			<MenuSeparator />

			<MenuItem onClick={handleQuit} shortcut="Ctrl+Q">
				{t("quit")}
			</MenuItem>
		</div>
	);
}

interface MenuItemProps {
	children: React.ReactNode;
	disabled?: boolean;
	onClick?: () => void;
	shortcut?: string;
}

function MenuItem({ children, onClick, disabled, shortcut }: MenuItemProps) {
	return (
		<Button
			className={cn(
				"w-full justify-between gap-3 rounded px-3 py-1.5 text-left transition-colors",
				disabled
					? "text-foreground-dim"
					: "hover:bg-surface-hover hover:text-foreground active:bg-surface-active"
			)}
			disabled={disabled}
			onClick={onClick}
		>
			<span>{children}</span>
			{shortcut && <span className="text-[10px] text-foreground-muted">{shortcut}</span>}
		</Button>
	);
}

function MenuSeparator() {
	return <Separator className="my-1 h-px bg-border" />;
}
