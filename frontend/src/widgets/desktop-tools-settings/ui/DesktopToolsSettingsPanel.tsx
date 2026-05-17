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
import { type ReactNode, useEffect, useMemo, useReducer, useState } from "react";
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
import { ElevatedSurface } from "@/shared/ui/elevated-surface";
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
	payload: WindowTelemetryPayload;
	timestamp: number;
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

function errorToMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function describeContextMenuResult(
	selectedId: string | null | undefined,
	t: ReturnType<typeof useTranslations<"desktop">>
): string {
	return selectedId ? t("contextMenuSelected", { id: selectedId }) : t("contextMenuClosed");
}

interface ApplyMenuArgs {
	menuJson: string;
	setMenuStatus: (value: string) => void;
	t: ReturnType<typeof useTranslations<"desktop">>;
}

async function applyParsedMenu(
	template: Parameters<typeof appMenuSetTemplate>[0],
	t: ReturnType<typeof useTranslations<"desktop">>,
	setMenuStatus: (value: string) => void
): Promise<void> {
	const result = await appMenuSetTemplate(template).catch((err: unknown) => err);
	if (result instanceof Error) {
		setMenuStatus(errorToMessage(result));
		return;
	}
	setMenuStatus(t("appliedMenu", { count: (result as { itemCount: number }).itemCount }));
}

async function applyMenuJsonAction({ menuJson, t, setMenuStatus }: ApplyMenuArgs): Promise<void> {
	const parsed = parseAppMenuTemplateJson(menuJson);
	if (!parsed.ok) {
		setMenuStatus(parsed.error);
		return;
	}
	await applyParsedMenu(parsed.template, t, setMenuStatus);
}

interface DemoContextMenuArgs {
	clientX: number;
	clientY: number;
	setContextStatus: (value: string) => void;
	t: ReturnType<typeof useTranslations<"desktop">>;
}

async function showDemoContextMenuAction({
	clientX,
	clientY,
	t,
	setContextStatus,
}: DemoContextMenuArgs): Promise<void> {
	const result = await contextMenuShow(DEMO_CONTEXT_MENU, clientX, clientY).catch(
		(err: unknown) => err
	);
	if (result instanceof Error) {
		setContextStatus(errorToMessage(result));
		return;
	}
	setContextStatus(
		describeContextMenuResult((result as { selectedId: string | null }).selectedId, t)
	);
}

interface UpdaterEntriesState {
	entries: UpdaterStatusEntry[];
	status: string;
}

type UpdaterEntriesAction =
	| { type: "set-entries"; entries: UpdaterStatusEntry[] }
	| { type: "append-entry"; entry: UpdaterStatusEntry }
	| { type: "set-status"; status: string };

function updaterEntriesReducer(
	state: UpdaterEntriesState,
	action: UpdaterEntriesAction
): UpdaterEntriesState {
	switch (action.type) {
		case "set-entries":
			return { ...state, entries: action.entries };
		case "append-entry":
			return {
				...state,
				entries: appendBounded(state.entries, action.entry, MAX_UPDATER_ENTRIES),
			};
		case "set-status":
			return { ...state, status: action.status };
		default:
			return state;
	}
}

function useUpdaterEntries(hasElectron: boolean): {
	entries: UpdaterStatusEntry[];
	setEntries: (value: UpdaterStatusEntry[]) => void;
	updaterStatus: string;
	setUpdaterStatus: (value: string) => void;
} {
	const [state, dispatch] = useReducer(updaterEntriesReducer, { entries: [], status: "" });

	useEffect(() => {
		if (!hasElectron) {
			return;
		}
		updaterGetStatusHistory()
			.then((items) =>
				dispatch({ type: "set-entries", entries: items.slice(-MAX_UPDATER_ENTRIES) })
			)
			.catch((error) => dispatch({ type: "set-status", status: errorToMessage(error) }));
		const unsubscribe = onUpdaterStatus((entry) => {
			dispatch({ type: "append-entry", entry });
		});
		return () => {
			unsubscribe();
		};
	}, [hasElectron]);

	return {
		entries: state.entries,
		updaterStatus: state.status,
		setEntries: (value) => dispatch({ type: "set-entries", entries: value }),
		setUpdaterStatus: (value) => dispatch({ type: "set-status", status: value }),
	};
}

function useTelemetryRows(
	hasElectron: boolean,
	telemetryEnabled: boolean
): {
	rows: TelemetryRow[];
	setRows: React.Dispatch<React.SetStateAction<TelemetryRow[]>>;
} {
	const [rows, setRows] = useState<TelemetryRow[]>([]);

	useEffect(() => {
		const active = hasElectron && telemetryEnabled;
		if (!active) {
			return;
		}
		const unsubscribe = onWindowTelemetry((payload) => {
			setRows((prev) =>
				appendBounded(prev, { timestamp: Date.now(), payload }, MAX_TELEMETRY_ENTRIES)
			);
		});
		return () => {
			unsubscribe();
		};
	}, [hasElectron, telemetryEnabled]);

	return { rows, setRows };
}

interface OverviewSectionProps {
	hasElectron: boolean;
	t: ReturnType<typeof useTranslations<"desktop">>;
}

function OverviewSection({ hasElectron, t }: OverviewSectionProps): ReactNode {
	return (
		<SettingSection icon={LaptopIcon} title={t("title")}>
			<div className="px-1 py-2 text-body-sm text-foreground-dim">
				{hasElectron ? t("active") : t("unavailable")}
			</div>
		</SettingSection>
	);
}

interface StatusBlockProps {
	message: string;
}

/** Single status block shared by the menu / clipboard / updater sections.
 *  Null-renders on empty message so callers can pass through their state
 *  variable without an outer guard. */
function StatusBlock({ message }: StatusBlockProps): ReactNode {
	if (!message) {
		return null;
	}
	return (
		<div className="col-span-2 rounded border border-border bg-surface px-2 py-1 text-foreground-secondary text-xs-tight">
			{message}
		</div>
	);
}

interface MenuEditorSectionProps {
	hasElectron: boolean;
	menuJson: string;
	menuStatus: string;
	setMenuJson: (value: string) => void;
	setMenuStatus: (value: string) => void;
	t: ReturnType<typeof useTranslations<"desktop">>;
}

function MenuEditorSection({
	hasElectron,
	menuJson,
	menuStatus,
	setMenuJson,
	setMenuStatus,
	t,
}: MenuEditorSectionProps): ReactNode {
	const handleApply = () => applyMenuJsonAction({ menuJson, t, setMenuStatus });
	const handleLoadDemo = () => setMenuJson(JSON.stringify(DEFAULT_APP_MENU_TEMPLATE, null, 2));
	const handleReset = async () => {
		const result = await appMenuReset().catch((err: unknown) => err);
		setMenuStatus(result instanceof Error ? errorToMessage(result) : t("menuReset"));
	};

	return (
		<SettingSection icon={MenuSquareIcon} title={t("menuEditor")}>
			<div className="flex flex-col divide-y divide-surface-1">
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
						onClick={handleApply}
					>
						{t("applyJson")}
					</Button>
					<Button
						className="rounded-md border border-border bg-surface px-3 py-1.5 text-body-sm hover:bg-surface-hover"
						onClick={handleLoadDemo}
					>
						{t("loadDemo")}
					</Button>
					<Button
						className="rounded-md border border-border bg-surface px-3 py-1.5 text-body-sm hover:bg-surface-hover"
						disabled={!hasElectron}
						onClick={handleReset}
					>
						{t("resetMenu")}
					</Button>
				</div>
				<StatusBlock message={menuStatus} />
			</div>
		</SettingSection>
	);
}

interface ContextMenuSectionProps {
	contextStatus: string;
	hasElectron: boolean;
	setContextStatus: (value: string) => void;
	t: ReturnType<typeof useTranslations<"desktop">>;
}

function ContextMenuSection({
	contextStatus,
	hasElectron,
	setContextStatus,
	t,
}: ContextMenuSectionProps): ReactNode {
	const handleAtCoords = async (clientX: number, clientY: number) => {
		await showDemoContextMenuAction({ clientX, clientY, t, setContextStatus });
	};
	const handleContextEvent = async (event: React.MouseEvent) => {
		event.preventDefault();
		await handleAtCoords(event.clientX, event.clientY);
	};
	const handleOpenButton = async () => {
		await handleAtCoords(48, 48);
	};

	return (
		<SettingSection icon={TouchInteraction03Icon} title={t("contextMenuTitle")}>
			<div className="flex flex-col divide-y divide-surface-1">
				<div className="col-span-2">
					<Button
						className="rounded border border-border border-dashed bg-surface px-3 py-4 text-body-sm text-foreground-dim"
						onContextMenu={handleContextEvent}
					>
						{t("contextMenuHint")}
					</Button>
				</div>
				<div className="col-span-2">
					<Button
						className="rounded-md border border-border bg-surface px-3 py-1.5 text-body-sm hover:bg-surface-hover"
						disabled={!hasElectron}
						onClick={handleOpenButton}
					>
						{t("openContextMenu")}
					</Button>
				</div>
				<div className="col-span-2 rounded border border-border bg-surface px-2 py-1 text-foreground-secondary text-xs-tight">
					{contextStatus}
				</div>
			</div>
		</SettingSection>
	);
}

interface ClipboardSectionProps {
	clipboardInput: string;
	clipboardStatus: string;
	hasElectron: boolean;
	setClipboardInput: (value: string) => void;
	setClipboardStatus: (value: string) => void;
	t: ReturnType<typeof useTranslations<"desktop">>;
}

function ClipboardSection({
	clipboardInput,
	clipboardStatus,
	hasElectron,
	setClipboardInput,
	setClipboardStatus,
	t,
}: ClipboardSectionProps): ReactNode {
	const handleRead = async () => {
		const result = await clipboardReadText().catch((err: unknown) => err);
		if (result instanceof Error) {
			setClipboardStatus(errorToMessage(result));
			return;
		}
		setClipboardInput(result as string);
		setClipboardStatus(t("clipboardLoaded"));
	};
	const handleWrite = async () => {
		const result = await clipboardWriteText(clipboardInput).catch((err: unknown) => err);
		setClipboardStatus(result instanceof Error ? errorToMessage(result) : t("clipboardUpdated"));
	};
	const handleClear = async () => {
		const result = await clipboardClear().catch((err: unknown) => err);
		if (result instanceof Error) {
			setClipboardStatus(errorToMessage(result));
			return;
		}
		setClipboardInput("");
		setClipboardStatus(t("clipboardCleared"));
	};

	return (
		<SettingSection icon={ClipboardIcon} title={t("clipboardTitle")}>
			<div className="flex flex-col divide-y divide-surface-1">
				<div className="col-span-2">
					<FormControl caption={t("clipboardCaption")} label={t("clipboardLabel")}>
						<ElevatedSurface inline>
							<TextField
								onChange={(event) => setClipboardInput(event.target.value)}
								placeholder={t("clipboardPlaceholder")}
								value={clipboardInput}
							/>
						</ElevatedSurface>
					</FormControl>
				</div>
				<div className="col-span-2 flex flex-wrap gap-2">
					<Button
						className="rounded-md border border-border bg-surface px-3 py-1.5 text-body-sm hover:bg-surface-hover"
						disabled={!hasElectron}
						onClick={handleRead}
					>
						{t("readClipboard")}
					</Button>
					<Button
						className="rounded-md border border-border bg-surface px-3 py-1.5 text-body-sm hover:bg-surface-hover"
						disabled={!hasElectron}
						onClick={handleWrite}
					>
						{t("writeClipboard")}
					</Button>
					<Button
						className="rounded-md border border-border bg-surface px-3 py-1.5 text-body-sm hover:bg-surface-hover"
						disabled={!hasElectron}
						onClick={handleClear}
					>
						{t("clearClipboard")}
					</Button>
				</div>
				<StatusBlock message={clipboardStatus} />
			</div>
		</SettingSection>
	);
}

interface UpdaterEntryRowProps {
	entry: UpdaterStatusEntry;
	keyText: string;
}

function describeUpdaterEntry(entry: UpdaterStatusEntry): string {
	const versionPart = entry.version ? ` • v${entry.version}` : "";
	const messagePart = entry.message ? ` • ${entry.message}` : "";
	return `${entry.status}${versionPart}${messagePart}`;
}

function UpdaterEntryRow({ entry, keyText }: UpdaterEntryRowProps): ReactNode {
	return (
		<li className="px-3 py-2 text-xs-tight" key={keyText}>
			<div className="font-mono text-foreground-muted">{formatTimestamp(entry.timestamp)}</div>
			<div className="text-foreground-secondary">{describeUpdaterEntry(entry)}</div>
		</li>
	);
}

interface UpdaterEntriesProps {
	entries: UpdaterStatusEntry[];
	t: ReturnType<typeof useTranslations<"desktop">>;
}

function UpdaterEntries({ entries, t }: UpdaterEntriesProps): ReactNode {
	if (entries.length === 0) {
		return (
			<div className="px-3 py-2 text-foreground-dim text-xs-tight">{t("noUpdaterEntries")}</div>
		);
	}
	return (
		<ul className="divide-y divide-border">
			{entries.map((entry) => (
				<UpdaterEntryRow
					entry={entry}
					key={`${entry.timestamp}-${entry.status}`}
					keyText={`${entry.timestamp}-${entry.status}`}
				/>
			))}
		</ul>
	);
}

interface UpdaterSectionProps {
	entries: UpdaterStatusEntry[];
	entriesDesc: UpdaterStatusEntry[];
	hasElectron: boolean;
	setEntries: (value: UpdaterStatusEntry[]) => void;
	setUpdaterStatus: (value: string) => void;
	t: ReturnType<typeof useTranslations<"desktop">>;
	updaterStatus: string;
}

function UpdaterSection({
	entriesDesc,
	hasElectron,
	setEntries,
	setUpdaterStatus,
	t,
	updaterStatus,
}: UpdaterSectionProps): ReactNode {
	const handleRefresh = async () => {
		const result = await updaterGetStatusHistory().catch((err: unknown) => err);
		if (result instanceof Error) {
			setUpdaterStatus(errorToMessage(result));
			return;
		}
		setEntries((result as UpdaterStatusEntry[]).slice(-MAX_UPDATER_ENTRIES));
		setUpdaterStatus(t("updaterRefreshed"));
	};
	const handleClear = async () => {
		const result = await updaterClearStatusHistory().catch((err: unknown) => err);
		if (result instanceof Error) {
			setUpdaterStatus(errorToMessage(result));
			return;
		}
		setEntries([]);
		setUpdaterStatus(t("updaterCleared"));
	};

	return (
		<SettingSection icon={CloudIcon} title={t("updaterTitle")}>
			<div className="flex flex-col divide-y divide-surface-1">
				<div className="col-span-2 flex flex-wrap gap-2">
					<Button
						className="rounded-md border border-border bg-surface px-3 py-1.5 text-body-sm hover:bg-surface-hover"
						disabled={!hasElectron}
						onClick={handleRefresh}
					>
						{t("refreshHistory")}
					</Button>
					<Button
						className="rounded-md border border-border bg-surface px-3 py-1.5 text-body-sm hover:bg-surface-hover"
						disabled={!hasElectron}
						onClick={handleClear}
					>
						{t("clearHistory")}
					</Button>
				</div>
				<StatusBlock message={updaterStatus} />
				<ScrollArea className="col-span-2 max-h-44 rounded border border-border bg-surface">
					<UpdaterEntries entries={entriesDesc} t={t} />
				</ScrollArea>
			</div>
		</SettingSection>
	);
}

interface TelemetryRowItemProps {
	keyText: string;
	row: TelemetryRow;
}

function describeTelemetryRow(row: TelemetryRow): string {
	const { event, bounds } = row.payload;
	return `${event} • x:${bounds.x} y:${bounds.y} w:${bounds.width} h:${bounds.height}`;
}

function TelemetryRowItem({ row, keyText }: TelemetryRowItemProps): ReactNode {
	return (
		<li className="px-3 py-2 text-xs-tight" key={keyText}>
			<div className="font-mono text-foreground-muted">{formatTimestamp(row.timestamp)}</div>
			<div className="text-foreground-secondary">{describeTelemetryRow(row)}</div>
		</li>
	);
}

interface TelemetryListProps {
	rows: TelemetryRow[];
	t: ReturnType<typeof useTranslations<"desktop">>;
}

function TelemetryList({ rows, t }: TelemetryListProps): ReactNode {
	if (rows.length === 0) {
		return <div className="px-3 py-2 text-foreground-dim text-xs-tight">{t("noTelemetry")}</div>;
	}
	const sortedRows = rows.toSorted((a, b) => b.timestamp - a.timestamp);
	return (
		<ul className="divide-y divide-border">
			{sortedRows.map((row) => (
				<TelemetryRowItem
					key={`${row.timestamp}-${row.payload.event}`}
					keyText={`${row.timestamp}-${row.payload.event}`}
					row={row}
				/>
			))}
		</ul>
	);
}

interface TelemetrySectionProps {
	rows: TelemetryRow[];
	setRows: React.Dispatch<React.SetStateAction<TelemetryRow[]>>;
	setTelemetryEnabled: (value: boolean) => void;
	t: ReturnType<typeof useTranslations<"desktop">>;
	telemetryEnabled: boolean;
}

function TelemetrySection({
	rows,
	setRows,
	setTelemetryEnabled,
	t,
	telemetryEnabled,
}: TelemetrySectionProps): ReactNode {
	return (
		<SettingSection icon={Activity01Icon} title={t("telemetryTitle")}>
			<div className="flex flex-col divide-y divide-surface-1">
				<FormControl
					caption={t("telemetryCaption")}
					label={t("telemetryLabel")}
					labelAddon={<Toggle checked={telemetryEnabled} onCheckedChange={setTelemetryEnabled} />}
				/>
				<FormControl caption={t("telemetryClearCaption")} label={t("telemetryClear")}>
					<Button
						className="h-8 rounded-md border border-border bg-surface px-3 py-1.5 text-body-sm hover:bg-surface-hover"
						onClick={() => setRows([])}
					>
						{t("clearEvents")}
					</Button>
				</FormControl>
				<ScrollArea className="col-span-2 max-h-52 rounded border border-border bg-surface">
					<TelemetryList rows={rows} t={t} />
				</ScrollArea>
			</div>
		</SettingSection>
	);
}

function detectElectron(): boolean {
	return typeof window !== "undefined" && window.electronAPI != null;
}

interface PanelState {
	clipboardInput: string;
	clipboardStatus: string;
	contextStatus: string;
	menuJson: string;
	menuStatus: string;
	telemetryEnabled: boolean;
}

type PanelAction =
	| { type: "menu-json"; value: string }
	| { type: "menu-status"; value: string }
	| { type: "context-status"; value: string }
	| { type: "clipboard-input"; value: string }
	| { type: "clipboard-status"; value: string }
	| { type: "telemetry-enabled"; value: boolean };

function panelReducer(state: PanelState, action: PanelAction): PanelState {
	switch (action.type) {
		case "menu-json":
			return { ...state, menuJson: action.value };
		case "menu-status":
			return { ...state, menuStatus: action.value };
		case "context-status":
			return { ...state, contextStatus: action.value };
		case "clipboard-input":
			return { ...state, clipboardInput: action.value };
		case "clipboard-status":
			return { ...state, clipboardStatus: action.value };
		case "telemetry-enabled":
			return { ...state, telemetryEnabled: action.value };
		default:
			return state;
	}
}

export function DesktopToolsSettingsPanel() {
	const t = useTranslations("desktop");
	const [state, dispatch] = useReducer(
		panelReducer,
		null,
		(): PanelState => ({
			menuJson: JSON.stringify(DEFAULT_APP_MENU_TEMPLATE, null, 2),
			menuStatus: "",
			contextStatus: t("contextMenuInitial"),
			clipboardInput: "",
			clipboardStatus: "",
			telemetryEnabled: true,
		})
	);
	const setMenuJson = (value: string) => dispatch({ type: "menu-json", value });
	const setMenuStatus = (value: string) => dispatch({ type: "menu-status", value });
	const setContextStatus = (value: string) => dispatch({ type: "context-status", value });
	const setClipboardInput = (value: string) => dispatch({ type: "clipboard-input", value });
	const setClipboardStatus = (value: string) => dispatch({ type: "clipboard-status", value });
	const setTelemetryEnabled = (value: boolean) => dispatch({ type: "telemetry-enabled", value });
	const hasElectron = detectElectron();

	const { entries, setEntries, updaterStatus, setUpdaterStatus } = useUpdaterEntries(hasElectron);
	const { rows, setRows } = useTelemetryRows(hasElectron, state.telemetryEnabled);

	const updaterEntriesDesc = useMemo(
		() => entries.toSorted((a, b) => b.timestamp - a.timestamp),
		[entries]
	);

	return (
		<div className="flex flex-col gap-2">
			<OverviewSection hasElectron={hasElectron} t={t} />
			<MenuEditorSection
				hasElectron={hasElectron}
				menuJson={state.menuJson}
				menuStatus={state.menuStatus}
				setMenuJson={setMenuJson}
				setMenuStatus={setMenuStatus}
				t={t}
			/>
			<ContextMenuSection
				contextStatus={state.contextStatus}
				hasElectron={hasElectron}
				setContextStatus={setContextStatus}
				t={t}
			/>
			<ClipboardSection
				clipboardInput={state.clipboardInput}
				clipboardStatus={state.clipboardStatus}
				hasElectron={hasElectron}
				setClipboardInput={setClipboardInput}
				setClipboardStatus={setClipboardStatus}
				t={t}
			/>
			<UpdaterSection
				entries={entries}
				entriesDesc={updaterEntriesDesc}
				hasElectron={hasElectron}
				setEntries={setEntries}
				setUpdaterStatus={setUpdaterStatus}
				t={t}
				updaterStatus={updaterStatus}
			/>
			<TelemetrySection
				rows={rows}
				setRows={setRows}
				setTelemetryEnabled={setTelemetryEnabled}
				t={t}
				telemetryEnabled={state.telemetryEnabled}
			/>
		</div>
	);
}

export const __desktop_tools_settings_panel_test_helpers__ = {
	errorToMessage,
	describeContextMenuResult,
	applyMenuJsonAction,
	showDemoContextMenuAction,
	detectElectron,
	describeUpdaterEntry,
	describeTelemetryRow,
};
