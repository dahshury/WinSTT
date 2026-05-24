import { existsSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";
import { app, dialog, ipcMain, shell } from "electron";
import { IPC } from "../../src/shared/api/ipc-channels";
import { dbg } from "../lib/debug-log";
import { breadcrumb, captureMainException } from "../lib/sentry-main";

interface DiagSaveResult {
	cancelled?: boolean;
	error?: string;
	ok: boolean;
	path?: string;
}

function getLogsFolder(): string {
	return app.getPath("userData");
}

async function handleOpenLogsFolder(): Promise<{ ok: boolean; error?: string }> {
	const logsPath = getLogsFolder();
	dbg("tray-menu", "Open logs folder requested:", logsPath);
	const errMessage = await shell.openPath(logsPath);
	if (errMessage) {
		dbg("tray-menu", "shell.openPath failed:", errMessage);
		breadcrumb("tray", "openPath failed", { path: logsPath, error: errMessage }, "warning");
		return { ok: false, error: errMessage };
	}
	return { ok: true };
}

function pad2(n: number): string {
	return n < 10 ? `0${n}` : String(n);
}

function formatTimestampForFilename(d: Date): string {
	const year = d.getFullYear();
	const month = pad2(d.getMonth() + 1);
	const day = pad2(d.getDate());
	const hour = pad2(d.getHours());
	const minute = pad2(d.getMinutes());
	const second = pad2(d.getSeconds());
	return `${year}${month}${day}-${hour}${minute}${second}`;
}

function bytesToMB(bytes: number): number {
	return Math.round(bytes / (1024 * 1024));
}

interface GpuFeatureStatus {
	[key: string]: string;
}

interface GpuInfoBasic {
	auxAttributes?: Record<string, unknown>;
	gpuDevice?: Record<string, unknown>[];
	machineModelName?: string;
	machineModelVersion?: string;
	[key: string]: unknown;
}

function logGpuInfoError(err: unknown): void {
	dbg("diag-bundle", "getGPUInfo failed:", err instanceof Error ? err.message : String(err));
}

function formatGpuInfo(info: GpuInfoBasic | GpuFeatureStatus | undefined): string {
	return info ? JSON.stringify(info) : "unavailable";
}

async function collectGpuInfoText(): Promise<string> {
	try {
		const info = (await app.getGPUInfo("basic")) as GpuInfoBasic | GpuFeatureStatus | undefined;
		return formatGpuInfo(info);
	} catch (err) {
		logGpuInfoError(err);
		return "unavailable";
	}
}

function orUnknown(value: string | undefined): string {
	return value ?? "unknown";
}

function buildSystemInfoLines(gpuInfo: string): string[] {
	const cpus = os.cpus();
	const firstCpu = cpus[0];
	return [
		`Generated at: ${new Date().toISOString()}`,
		`WinSTT version: ${app.getVersion()}`,
		`Electron version: ${orUnknown(process.versions.electron)}`,
		`Node version: ${orUnknown(process.versions.node)}`,
		`Chrome version: ${orUnknown(process.versions.chrome)}`,
		`Platform: ${process.platform}`,
		`Arch: ${process.arch}`,
		`OS release: ${os.release()}`,
		`Total RAM (MB): ${bytesToMB(os.totalmem())}`,
		`Free RAM (MB): ${bytesToMB(os.freemem())}`,
		`CPU model: ${orUnknown(firstCpu?.model)}`,
		`CPU count: ${cpus.length}`,
		`GPU info: ${gpuInfo}`,
	];
}

async function buildSystemInfo(): Promise<string> {
	const gpuInfo = await collectGpuInfoText();
	const lines = buildSystemInfoLines(gpuInfo);
	return `${lines.join("\n")}\n`;
}

function buildDefaultPath(): string {
	const filename = `winstt-diag-${formatTimestampForFilename(new Date())}.zip`;
	const desktop = app.getPath("desktop");
	return path.join(desktop, filename);
}

interface ZipFileEntry {
	name: string;
	source: string;
}

function collectExistingLogFiles(logsDir: string): ZipFileEntry[] {
	const candidates: ZipFileEntry[] = [
		{ name: "debug.log", source: path.join(logsDir, "debug.log") },
		{ name: "debug.old.log", source: path.join(logsDir, "debug.old.log") },
		{ name: "stt-server.log", source: path.join(logsDir, "stt-server.log") },
	];
	return candidates.filter((entry) => existsSync(entry.source));
}

interface ArchiveResult {
	bytes: number;
}

async function writeZipArchive(
	outPath: string,
	logFiles: ZipFileEntry[],
	systemInfoContent: string
): Promise<ArchiveResult> {
	// adm-zip builds the archive in memory and writes it in one shot. For
	// the diagnostic bundle (debug.log + a couple optional logs + a small
	// system-info.txt; typically 5-25 MB total), the transient memory cost
	// is negligible compared to keeping `archiver` (~1 MB of dependencies
	// inlined into main.js for streaming output we don't need).
	const zip = new AdmZip();
	for (const entry of logFiles) {
		// addLocalFile reads the file synchronously and embeds it under the
		// supplied zipPath name. We pass `""` for the zipPath so the entry
		// lives at the archive root (no leading folder), matching what the
		// previous archiver call produced via `{ name: entry.name }`.
		zip.addLocalFile(entry.source, "", entry.name);
	}
	zip.addFile("system-info.txt", Buffer.from(systemInfoContent, "utf8"));
	await zip.writeZipPromise(outPath);
	// `writeZipPromise` doesn't return the byte count; stat the resulting
	// file once so callers and the breadcrumb log still see real size data.
	const stats = statSync(outPath);
	return { bytes: stats.size };
}

function logRevealDialogError(err: unknown): void {
	dbg("diag-bundle", "Post-save dialog failed:", err instanceof Error ? err.message : String(err));
}

async function promptRevealChoice(outPath: string): Promise<number> {
	const choice = await dialog.showMessageBox({
		type: "info",
		title: "Diagnostic bundle saved",
		message: `Saved to ${outPath}`,
		buttons: ["Open folder", "OK"],
		defaultId: 1,
		cancelId: 1,
	});
	return choice.response;
}

async function maybeRevealInExplorer(outPath: string): Promise<void> {
	try {
		const response = await promptRevealChoice(outPath);
		if (response === 0) {
			shell.showItemInFolder(outPath);
		}
	} catch (err) {
		logRevealDialogError(err);
	}
}

async function promptSaveLocation(): Promise<string | null> {
	const defaultPath = buildDefaultPath();
	const saveResult = await dialog.showSaveDialog({
		title: "Save diagnostic bundle",
		defaultPath,
		filters: [{ name: "Zip", extensions: ["zip"] }],
	});
	if (saveResult.canceled || !saveResult.filePath) {
		return null;
	}
	return saveResult.filePath;
}

async function buildBundleAt(outPath: string): Promise<DiagSaveResult> {
	const logsDir = getLogsFolder();
	const logFiles = collectExistingLogFiles(logsDir);
	const systemInfo = await buildSystemInfo();
	dbg("diag-bundle", "Building diagnostic bundle:", outPath, "logFiles:", logFiles.length);
	const { bytes } = await writeZipArchive(outPath, logFiles, systemInfo);
	dbg("diag-bundle", "Wrote diagnostic bundle:", outPath, "bytes:", bytes);
	breadcrumb("tray", "diagnostic bundle saved", { bytes, files: logFiles.length });
	await maybeRevealInExplorer(outPath);
	return { ok: true, path: outPath };
}

function safeShowErrorBox(message: string): void {
	try {
		dialog.showErrorBox("Diagnostic bundle failed", message);
	} catch {
		// ignore — main concern is logging the underlying error above
	}
}

function reportSaveFailure(err: unknown): DiagSaveResult {
	const message = err instanceof Error ? err.message : String(err);
	dbg("diag-bundle", "Bundle save failed:", message);
	captureMainException(err, { source: "diag-bundle" });
	safeShowErrorBox(message);
	return { ok: false, error: message };
}

async function handleSaveBundle(): Promise<DiagSaveResult> {
	try {
		const outPath = await promptSaveLocation();
		if (!outPath) {
			return { ok: false, cancelled: true };
		}
		return await buildBundleAt(outPath);
	} catch (err) {
		return reportSaveFailure(err);
	}
}

export function setupDiagBundleHandler(): () => void {
	ipcMain.removeHandler(IPC.DIAG_OPEN_LOGS_FOLDER);
	ipcMain.removeHandler(IPC.DIAG_SAVE_BUNDLE);
	ipcMain.handle(IPC.DIAG_OPEN_LOGS_FOLDER, () => handleOpenLogsFolder());
	ipcMain.handle(IPC.DIAG_SAVE_BUNDLE, () => handleSaveBundle());
	return () => {
		ipcMain.removeHandler(IPC.DIAG_OPEN_LOGS_FOLDER);
		ipcMain.removeHandler(IPC.DIAG_SAVE_BUNDLE);
	};
}

export const __diag_bundle_test_helpers__ = {
	formatTimestampForFilename,
	bytesToMB,
	collectExistingLogFiles,
	buildSystemInfo,
	buildDefaultPath,
	writeZipArchive,
	handleOpenLogsFolder,
	handleSaveBundle,
	logGpuInfoError,
	logRevealDialogError,
	safeShowErrorBox,
	reportSaveFailure,
};
