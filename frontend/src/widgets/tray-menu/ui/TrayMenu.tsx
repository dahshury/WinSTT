"use client";

import { Menu } from "@base-ui/react/menu";
import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";
import { IPC } from "@/shared/api/ipc-channels";
import {
	dialogOpenFile,
	fileTranscribe,
	ipcSend,
	onConnectionChange,
	settingsLoad,
	settingsSave,
} from "@/shared/api/ipc-client";
import { cn } from "@/shared/lib/cn";

export function TrayMenu() {
	const [recordingMode, setRecordingMode] = useState<string>("ptt");
	const [isConnected, setIsConnected] = useState(false);

	useEffect(() => {
		// Get initial settings
		settingsLoad().then((settings) => {
			setRecordingMode(settings.general?.recordingMode ?? "ptt");
		});

		// Listen for connection status
		const unsubscribe = onConnectionChange((connected) => {
			setIsConnected(connected);
		});

		return unsubscribe;
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

	const handleModeChange = async (mode: "ptt" | "toggle" | "listen") => {
		setRecordingMode(mode);
		const settings = await settingsLoad();
		await settingsSave({
			...settings,
			general: { ...settings.general, recordingMode: mode },
		});
		closeTrayMenu();
	};

	const handleTranscribeFile = async () => {
		const filePath = await dialogOpenFile(
			[
				{ name: "Audio Files", extensions: ["mp3", "wav", "flac", "m4a", "aac", "ogg", "wma"] },
				{ name: "Video Files", extensions: ["mp4", "mkv", "avi", "mov", "wmv", "flv", "webm"] },
				{ name: "All Files", extensions: ["*"] },
			],
			"Select Audio or Video File to Transcribe"
		);

		if (filePath) {
			await fileTranscribe(filePath);
		}
		closeTrayMenu();
	};

	const handleQuit = () => {
		ipcSend(IPC.WINDOW_QUIT);
	};

	return (
		<div
			className={cn(
				"w-[190px] rounded-md border border-zinc-800 bg-zinc-950 p-0.5 shadow-2xl",
				"font-sans text-[11px] text-zinc-100"
			)}
		>
			<MenuItem onClick={handleShowWindow} shortcut="Ctrl+Shift+W">
				Show Window
			</MenuItem>
			<MenuItem onClick={handleSettings} shortcut="Ctrl+,">
				Settings
			</MenuItem>

			<MenuSeparator />

			<div className="px-1 py-0.5">
				<CompactSelect
					value={recordingMode}
					onChange={handleModeChange}
					disabled={!isConnected}
					options={[
						{ id: "ptt", label: "Push-to-Talk" },
						{ id: "toggle", label: "Toggle" },
						{ id: "listen", label: "Listen" },
					]}
				/>
			</div>

			<MenuSeparator />

			<MenuItem disabled={!isConnected} onClick={handleTranscribeFile} shortcut="Ctrl+Shift+T">
				Transcribe File...
			</MenuItem>
			<MenuItem disabled>Check for Updates</MenuItem>

			<MenuSeparator />

			<MenuItem onClick={handleQuit} shortcut="Ctrl+Q">
				Quit
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
		<button
			className={cn(
				"flex w-full items-center justify-between gap-2 rounded px-2 py-0.5",
				"text-left transition-colors",
				disabled
					? "cursor-default text-zinc-600"
					: "cursor-pointer hover:bg-zinc-800 hover:text-zinc-50 active:bg-zinc-700"
			)}
			disabled={disabled}
			onClick={onClick}
			type="button"
		>
			<span>{children}</span>
			{shortcut && <span className="text-[9px] text-zinc-500">{shortcut}</span>}
		</button>
	);
}

interface CompactSelectOption {
	id: string;
	label: string;
}

interface CompactSelectProps {
	options: CompactSelectOption[];
	value: string;
	onChange: (value: "ptt" | "toggle" | "listen") => void;
	disabled?: boolean;
}

function CompactSelect({ options, value, onChange, disabled }: CompactSelectProps) {
	const selectedLabel = options.find((o) => o.id === value)?.label ?? value;

	return (
		<Menu.Root>
			<Menu.Trigger
				disabled={disabled}
				className={cn(
					"flex h-6 w-full items-center justify-between rounded px-2 text-[11px] outline-none",
					disabled
						? "cursor-default border border-zinc-800 bg-zinc-900 text-zinc-600"
						: "cursor-pointer border border-zinc-700 bg-zinc-900 text-zinc-100 hover:border-zinc-600 focus-visible:ring-1 focus-visible:ring-zinc-500"
				)}
			>
				<span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
					{selectedLabel}
				</span>
				<HugeiconsIcon className="ml-1 shrink-0" icon={ArrowDown01Icon} size={12} />
			</Menu.Trigger>
			<Menu.Portal>
				<Menu.Positioner className="z-[300] outline-none" sideOffset={2}>
					<Menu.Popup className="min-w-[var(--anchor-width)] origin-[var(--transform-origin)] rounded border border-zinc-700 bg-zinc-900 py-0.5 shadow-2xl">
						<Menu.RadioGroup onValueChange={(v) => onChange(v as "ptt" | "toggle" | "listen")} value={value}>
							{options.map((opt) => (
								<Menu.RadioItem
									className="mx-0.5 flex cursor-pointer select-none items-center rounded px-2 py-1 text-[11px] text-zinc-100 outline-none hover:bg-zinc-800 data-[checked]:text-zinc-50"
									closeOnClick
									key={opt.id}
									value={opt.id}
								>
									{opt.label}
								</Menu.RadioItem>
							))}
						</Menu.RadioGroup>
					</Menu.Popup>
				</Menu.Positioner>
			</Menu.Portal>
		</Menu.Root>
	);
}

function MenuSeparator() {
	return <div className="my-0.5 h-[1px] bg-zinc-800" />;
}
