import { Mic01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useRef, useState } from "react";
import { useTranslations } from "use-intl";
import { buildInputDeviceOptions, useInputDevices } from "@/entities/audio-device";
import { IPC } from "@/shared/api/ipc-channels";
import { ipcSend, onSettingsChanged, settingsLoad, settingsSave } from "@/shared/api/ipc-client";
import { cn } from "@/shared/lib/cn";
import { surfaceClasses, surfaceHoverBg } from "@/shared/lib/surface";

// The tray menu this picker opens from sits at surface-5 (substrate 1 + 4).
// Per the surfaces model a popup opened from a surface is substrate+2, so the
// picker rides at surface-7 with the deepest drop shadow — it reads as a
// distinct floating layer instead of blending into the tray menu behind it.
const PANEL_LEVEL = 7;
const PANEL_SHADOW_LEVEL = 8;
const HOVER_LEVEL = 8;

function close(): void {
	ipcSend(IPC.DEVICE_PICKER_CLOSE);
}

/**
 * Renderer half of the detached input-device picker. The tray menu is a tiny
 * popup; expanding the device list inside it ballooned the window off-screen.
 * This hosts the list in its own window instead, mirrors the tray's selection
 * (`settings.audio.inputDeviceIndex`) over IPC, and reports its content size
 * back so the OS window hugs the list.
 */
export function DevicePickerWindow() {
	const t = useTranslations("audio");
	const { devices, defaultDevice } = useInputDevices();
	const [inputDeviceIndex, setInputDeviceIndex] = useState<number | null>(null);
	const containerRef = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		settingsLoad().then((s) => setInputDeviceIndex(s.audio?.inputDeviceIndex ?? null));
		return onSettingsChanged((s) => setInputDeviceIndex(s.audio?.inputDeviceIndex ?? null));
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
			ipcSend(IPC.DEVICE_PICKER_RESIZE, { width: r.width, height: r.height });
		};
		const observer = new ResizeObserver(report);
		observer.observe(el);
		report();
		return () => observer.disconnect();
	}, []);

	useEffect(() => {
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				close();
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, []);

	const handleSelect = async (id: string) => {
		const next = id === "default" ? null : Number.parseInt(id, 10);
		const settings = await settingsLoad();
		await settingsSave({
			...settings,
			audio: { ...settings.audio, inputDeviceIndex: next },
		});
		close();
	};

	const defaultLabel = defaultDevice
		? `${t("systemDefault")} (${defaultDevice.name})`
		: t("systemDefault");
	const { deviceOptions, currentDeviceId } = buildInputDeviceOptions(
		devices,
		inputDeviceIndex,
		defaultLabel
	);

	return (
		<div className="flex h-screen w-screen items-end overflow-hidden">
			<div
				className={cn(
					"max-h-screen w-full overflow-y-auto rounded-md p-1",
					surfaceClasses(PANEL_LEVEL, PANEL_SHADOW_LEVEL),
					"font-sans text-body-sm text-foreground"
				)}
				ref={containerRef}
			>
				{deviceOptions.map((opt) => (
					<button
						aria-pressed={opt.id === currentDeviceId}
						className={cn(
							"flex w-full items-center gap-2 truncate rounded px-3 py-1.5 text-left transition-colors",
							surfaceHoverBg(HOVER_LEVEL),
							"hover:text-foreground",
							opt.id === currentDeviceId ? "text-accent" : "text-foreground-dim"
						)}
						key={opt.id}
						onClick={() => handleSelect(opt.id)}
						type="button"
					>
						<HugeiconsIcon
							aria-hidden="true"
							className="shrink-0 text-foreground-dim"
							icon={Mic01Icon}
							size={13}
						/>
						<span className="truncate">{opt.label}</span>
					</button>
				))}
			</div>
		</div>
	);
}
