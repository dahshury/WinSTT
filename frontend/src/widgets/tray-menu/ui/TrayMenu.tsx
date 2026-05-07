"use client";

import { Separator } from "@base-ui/react/separator";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
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
	const [isConnected, setIsConnected] = useState(false);
	const containerRef = useRef<HTMLDivElement | null>(null);
	const t = useTranslations("tray");

	useEffect(() => {
		settingsLoad().then((settings) => {
			setRecordingMode(settings.general.recordingMode);
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

			<div className="px-2 py-1.5">
				<Switcher
					onChange={handleModeChange}
					options={recordingModeOptions}
					value={recordingMode}
				/>
			</div>

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
	onClick?: () => void;
	disabled?: boolean;
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
