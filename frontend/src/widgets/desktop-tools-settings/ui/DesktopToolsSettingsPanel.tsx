"use client";

import { Field } from "@base-ui/react/field";
import {
	Activity01Icon,
	ClipboardIcon,
	CloudIcon,
	LaptopIcon,
	MenuSquareIcon,
	TouchInteraction03Icon,
} from "@hugeicons/core-free-icons";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";
import { SettingSection } from "@/entities/setting";
import {
	appMenuReset,
	appMenuSetTemplate,
	type ContextMenuTemplateItem,
	clipboardClear,
	clipboardReadText,
	clipboardWriteText,
	contextMenuShow,
	onUpdaterStatus,
	onWindowTelemetry,
	type UpdaterStatusEntry,
	updaterClearStatusHistory,
	updaterGetStatusHistory,
	type WindowTelemetryPayload,
} from "@/shared/api/ipc-client";
import { Button } from "@/shared/ui/button";
import { FormControl } from "@/shared/ui/form-control";
import { ScrollArea } from "@/shared/ui/scroll-area";
import { TextField } from "@/shared/ui/text-field";
import { Toggle } from "@/shared/ui/toggle";
import {
	appendBounded,
	DEFAULT_APP_MENU_TEMPLATE,
	formatTimestamp,
	parseAppMenuTemplateJson,
} from "../lib/desktop-tools";

interface TelemetryRow {
	timestamp: number;
	payload: WindowTelemetryPayload;
}

const MAX_UPDATER_ENTRIES = 60;
const MAX_TELEMETRY_ENTRIES = 80;

const DEMO_CONTEXT_MENU: ContextMenuTemplateItem[] = [
	{ id: "copy", label: "Copy", accelerator: "CmdOrCtrl+C" },
	{ id: "paste", label: "Paste", accelerator: "CmdOrCtrl+V" },
	{ type: "separator" },
	{
		label: "Mode",
		submenu: [
			{ id: "mode-ptt", label: "Push to Talk", type: "radio", checked: true },
			{ id: "mode-toggle", label: "Toggle", type: "radio" },
		],
	},
];

export function DesktopToolsSettingsPanel() {
	const t = useTranslations("desktop");
	const [menuJson, setMenuJson] = useState(() =>
		JSON.stringify(DEFAULT_APP_MENU_TEMPLATE, null, 2)
	);
	const [menuStatus, setMenuStatus] = useState<string>("");
	const [contextStatus, setContextStatus] = useState<string>(t("contextMenuInitial"));
	const [clipboardInput, setClipboardInput] = useState("");
	const [clipboardStatus, setClipboardStatus] = useState<string>("");
	const [updaterEntries, setUpdaterEntries] = useState<UpdaterStatusEntry[]>([]);
	const [updaterStatus, setUpdaterStatus] = useState<string>("");
	const [telemetryEnabled, setTelemetryEnabled] = useState(true);
	const [telemetryRows, setTelemetryRows] = useState<TelemetryRow[]>([]);
	const hasElectron = typeof window !== "undefined" && window.electronAPI != null;

	const updaterEntriesDesc = useMemo(
		() => [...updaterEntries].sort((a, b) => b.timestamp - a.timestamp),
		[updaterEntries]
	);

	useEffect(() => {
		if (!hasElectron) {
			return;
		}

		updaterGetStatusHistory()
			.then((entries) => {
				setUpdaterEntries(entries.slice(-MAX_UPDATER_ENTRIES));
			})
			.catch((error) => {
				setUpdaterStatus(error instanceof Error ? error.message : String(error));
			});

		const unsubscribeUpdater = onUpdaterStatus((entry) => {
			setUpdaterEntries((prev) => appendBounded(prev, entry, MAX_UPDATER_ENTRIES));
		});

		return () => {
			unsubscribeUpdater();
		};
	}, [hasElectron]);

	useEffect(() => {
		if (!(hasElectron && telemetryEnabled)) {
			return;
		}

		const unsubscribeTelemetry = onWindowTelemetry((payload) => {
			setTelemetryRows((prev) =>
				appendBounded(
					prev,
					{
						timestamp: Date.now(),
						payload,
					},
					MAX_TELEMETRY_ENTRIES
				)
			);
		});

		return () => {
			unsubscribeTelemetry();
		};
	}, [hasElectron, telemetryEnabled]);

	const handleApplyMenuJson = async () => {
		const parsed = parseAppMenuTemplateJson(menuJson);
		if (!parsed.ok) {
			setMenuStatus(parsed.error);
			return;
		}
		try {
			const result = await appMenuSetTemplate(parsed.template);
			setMenuStatus(t("appliedMenu", { count: result.itemCount }));
		} catch (error) {
			setMenuStatus(error instanceof Error ? error.message : String(error));
		}
	};

	const handleResetMenu = async () => {
		try {
			await appMenuReset();
			setMenuStatus(t("menuReset"));
		} catch (error) {
			setMenuStatus(error instanceof Error ? error.message : String(error));
		}
	};

	const handleDemoContextMenu = async (clientX: number, clientY: number) => {
		try {
			const result = await contextMenuShow(DEMO_CONTEXT_MENU, clientX, clientY);
			setContextStatus(
				result.selectedId
					? t("contextMenuSelected", { id: result.selectedId })
					: t("contextMenuClosed")
			);
		} catch (error) {
			setContextStatus(error instanceof Error ? error.message : String(error));
		}
	};

	const handleReadClipboard = async () => {
		try {
			const value = await clipboardReadText();
			setClipboardInput(value);
			setClipboardStatus(t("clipboardLoaded"));
		} catch (error) {
			setClipboardStatus(error instanceof Error ? error.message : String(error));
		}
	};

	const handleWriteClipboard = async () => {
		try {
			await clipboardWriteText(clipboardInput);
			setClipboardStatus(t("clipboardUpdated"));
		} catch (error) {
			setClipboardStatus(error instanceof Error ? error.message : String(error));
		}
	};

	const handleClearClipboard = async () => {
		try {
			await clipboardClear();
			setClipboardInput("");
			setClipboardStatus(t("clipboardCleared"));
		} catch (error) {
			setClipboardStatus(error instanceof Error ? error.message : String(error));
		}
	};

	const handleRefreshUpdaterHistory = async () => {
		try {
			const history = await updaterGetStatusHistory();
			setUpdaterEntries(history.slice(-MAX_UPDATER_ENTRIES));
			setUpdaterStatus(t("updaterRefreshed"));
		} catch (error) {
			setUpdaterStatus(error instanceof Error ? error.message : String(error));
		}
	};

	const handleClearUpdaterHistory = async () => {
		try {
			await updaterClearStatusHistory();
			setUpdaterEntries([]);
			setUpdaterStatus(t("updaterCleared"));
		} catch (error) {
			setUpdaterStatus(error instanceof Error ? error.message : String(error));
		}
	};

	return (
		<div className="flex flex-col gap-5">
			<SettingSection icon={LaptopIcon} title={t("title")}>
				<div className="px-1 py-2 text-body-sm text-foreground-dim">
					{hasElectron ? t("active") : t("unavailable")}
				</div>
			</SettingSection>

			<SettingSection icon={MenuSquareIcon} title={t("menuEditor")}>
				<div className="grid grid-cols-2 gap-x-4 gap-y-3 py-2">
					<div className="col-span-2">
						<FormControl caption={t("menuJsonCaption")} label={t("menuJsonLabel")}>
							<Field.Control
								className="h-40 w-full resize-y rounded border border-border bg-surface px-2 py-1.5 font-mono text-body-sm outline-none focus-visible:ring-2 focus-visible:ring-accent"
								onChange={(event) => setMenuJson(event.target.value)}
								render={<textarea />}
								spellCheck={false}
								value={menuJson}
							/>
						</FormControl>
					</div>
					<div className="col-span-2 flex flex-wrap gap-2">
						<Button
							className="rounded-md border border-accent bg-accent px-3 py-1.5 text-body-sm text-white hover:bg-accent-dim"
							disabled={!hasElectron}
							onClick={handleApplyMenuJson}
						>
							{t("applyJson")}
						</Button>
						<Button
							className="rounded-md border border-border bg-surface px-3 py-1.5 text-body-sm hover:bg-surface-hover"
							onClick={() => setMenuJson(JSON.stringify(DEFAULT_APP_MENU_TEMPLATE, null, 2))}
						>
							{t("loadDemo")}
						</Button>
						<Button
							className="rounded-md border border-border bg-surface px-3 py-1.5 text-body-sm hover:bg-surface-hover"
							disabled={!hasElectron}
							onClick={handleResetMenu}
						>
							{t("resetMenu")}
						</Button>
					</div>
					{menuStatus && (
						<div className="col-span-2 rounded border border-border bg-surface px-2 py-1 text-foreground-secondary text-xs-tight">
							{menuStatus}
						</div>
					)}
				</div>
			</SettingSection>

			<SettingSection icon={TouchInteraction03Icon} title={t("contextMenuTitle")}>
				<div className="grid grid-cols-2 gap-x-4 gap-y-3 py-2">
					<div className="col-span-2">
						<Button
							className="rounded border border-border border-dashed bg-surface px-3 py-4 text-body-sm text-foreground-dim"
							onContextMenu={async (event) => {
								event.preventDefault();
								await handleDemoContextMenu(event.clientX, event.clientY);
							}}
						>
							{t("contextMenuHint")}
						</Button>
					</div>
					<div className="col-span-2">
						<Button
							className="rounded-md border border-border bg-surface px-3 py-1.5 text-body-sm hover:bg-surface-hover"
							disabled={!hasElectron}
							onClick={async () => {
								await handleDemoContextMenu(48, 48);
							}}
						>
							{t("openContextMenu")}
						</Button>
					</div>
					<div className="col-span-2 rounded border border-border bg-surface px-2 py-1 text-foreground-secondary text-xs-tight">
						{contextStatus}
					</div>
				</div>
			</SettingSection>

			<SettingSection icon={ClipboardIcon} title={t("clipboardTitle")}>
				<div className="grid grid-cols-2 gap-x-4 gap-y-3 py-2">
					<div className="col-span-2">
						<FormControl caption={t("clipboardCaption")} label={t("clipboardLabel")}>
							<TextField
								onChange={(event) => setClipboardInput(event.target.value)}
								placeholder={t("clipboardPlaceholder")}
								value={clipboardInput}
							/>
						</FormControl>
					</div>
					<div className="col-span-2 flex flex-wrap gap-2">
						<Button
							className="rounded-md border border-border bg-surface px-3 py-1.5 text-body-sm hover:bg-surface-hover"
							disabled={!hasElectron}
							onClick={handleReadClipboard}
						>
							{t("readClipboard")}
						</Button>
						<Button
							className="rounded-md border border-border bg-surface px-3 py-1.5 text-body-sm hover:bg-surface-hover"
							disabled={!hasElectron}
							onClick={handleWriteClipboard}
						>
							{t("writeClipboard")}
						</Button>
						<Button
							className="rounded-md border border-border bg-surface px-3 py-1.5 text-body-sm hover:bg-surface-hover"
							disabled={!hasElectron}
							onClick={handleClearClipboard}
						>
							{t("clearClipboard")}
						</Button>
					</div>
					{clipboardStatus && (
						<div className="col-span-2 rounded border border-border bg-surface px-2 py-1 text-foreground-secondary text-xs-tight">
							{clipboardStatus}
						</div>
					)}
				</div>
			</SettingSection>

			<SettingSection icon={CloudIcon} title={t("updaterTitle")}>
				<div className="grid grid-cols-2 gap-x-4 gap-y-3 py-2">
					<div className="col-span-2 flex flex-wrap gap-2">
						<Button
							className="rounded-md border border-border bg-surface px-3 py-1.5 text-body-sm hover:bg-surface-hover"
							disabled={!hasElectron}
							onClick={handleRefreshUpdaterHistory}
						>
							{t("refreshHistory")}
						</Button>
						<Button
							className="rounded-md border border-border bg-surface px-3 py-1.5 text-body-sm hover:bg-surface-hover"
							disabled={!hasElectron}
							onClick={handleClearUpdaterHistory}
						>
							{t("clearHistory")}
						</Button>
					</div>
					{updaterStatus && (
						<div className="col-span-2 rounded border border-border bg-surface px-2 py-1 text-foreground-secondary text-xs-tight">
							{updaterStatus}
						</div>
					)}
					<ScrollArea className="col-span-2 max-h-44 rounded border border-border bg-surface">
						{updaterEntriesDesc.length === 0 ? (
							<div className="px-3 py-2 text-foreground-dim text-xs-tight">
								{t("noUpdaterEntries")}
							</div>
						) : (
							<ul className="divide-y divide-border">
								{updaterEntriesDesc.map((entry, index) => (
									<li
										className="px-3 py-2 text-xs-tight"
										key={`${entry.timestamp}-${entry.status}-${index}`}
									>
										<div className="font-mono text-foreground-muted">
											{formatTimestamp(entry.timestamp)}
										</div>
										<div className="text-foreground-secondary">
											{entry.status}
											{entry.version ? ` • v${entry.version}` : ""}
											{entry.message ? ` • ${entry.message}` : ""}
										</div>
									</li>
								))}
							</ul>
						)}
					</ScrollArea>
				</div>
			</SettingSection>

			<SettingSection icon={Activity01Icon} title={t("telemetryTitle")}>
				<div className="grid grid-cols-2 gap-x-4 gap-y-3 py-2">
					<FormControl caption={t("telemetryCaption")} label={t("telemetryLabel")}>
						<Toggle checked={telemetryEnabled} onCheckedChange={setTelemetryEnabled} />
					</FormControl>
					<FormControl caption={t("telemetryClearCaption")} label={t("telemetryClear")}>
						<Button
							className="h-8 rounded-md border border-border bg-surface px-3 py-1.5 text-body-sm hover:bg-surface-hover"
							onClick={() => setTelemetryRows([])}
						>
							{t("clearEvents")}
						</Button>
					</FormControl>
					<ScrollArea className="col-span-2 max-h-52 rounded border border-border bg-surface">
						{telemetryRows.length === 0 ? (
							<div className="px-3 py-2 text-foreground-dim text-xs-tight">{t("noTelemetry")}</div>
						) : (
							<ul className="divide-y divide-border">
								{[...telemetryRows]
									.sort((a, b) => b.timestamp - a.timestamp)
									.map((row, index) => (
										<li
											className="px-3 py-2 text-xs-tight"
											key={`${row.timestamp}-${row.payload.event}-${index}`}
										>
											<div className="font-mono text-foreground-muted">
												{formatTimestamp(row.timestamp)}
											</div>
											<div className="text-foreground-secondary">
												{row.payload.event} • x:{row.payload.bounds.x} y:{row.payload.bounds.y} w:
												{row.payload.bounds.width} h:{row.payload.bounds.height}
											</div>
										</li>
									))}
							</ul>
						)}
					</ScrollArea>
				</div>
			</SettingSection>
		</div>
	);
}
