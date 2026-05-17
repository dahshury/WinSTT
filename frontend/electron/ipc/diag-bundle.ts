import { createWriteStream, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import archiver from "archiver";
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

async function collectGpuInfoText(): Promise<string> {
	try {
		const info = (await app.getGPUInfo("basic")) as GpuInfoBasic | GpuFeatureStatus | undefined;
		if (!info) {
			return "unavailable";
		}
		return JSON.stringify(info);
	} catch (err) {
		dbg("diag-bundle", "getGPUInfo failed:", err instanceof Error ? err.message : String(err));
		return "unavailable";
	}
}

async function buildSystemInfo(): Promise<string> {
	const cpus = os.cpus();
	const firstCpu = cpus[0];
	const gpuInfo = await collectGpuInfoText();
	const lines: string[] = [
		`Generated at: ${new Date().toISOString()}`,
		`WinSTT version: ${app.getVersion()}`,
		`Electron version: ${process.versions.electron ?? "unknown"}`,
		`Node version: ${process.versions.node ?? "unknown"}`,
		`Chrome version: ${process.versions.chrome ?? "unknown"}`,
		`Platform: ${process.platform}`,
		`Arch: ${process.arch}`,
		`OS release: ${os.release()}`,
		`Total RAM (MB): ${bytesToMB(os.totalmem())}`,
		`Free RAM (MB): ${bytesToMB(os.freemem())}`,
		`CPU model: ${firstCpu?.model ?? "unknown"}`,
		`CPU count: ${cpus.length}`,
		`GPU info: ${gpuInfo}`,
	];
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

function writeZipArchive(
	outPath: string,
	logFiles: ZipFileEntry[],
	systemInfoContent: string
): Promise<ArchiveResult> {
	return new Promise<ArchiveResult>((resolve, reject) => {
		const output = createWriteStream(outPath);
		const archive = archiver("zip", { zlib: { level: 6 } });
		output.on("close", () => {
			resolve({ bytes: archive.pointer() });
		});
		output.on("error", reject);
		archive.on("error", reject);
		archive.pipe(output);
		for (const entry of logFiles) {
			archive.file(entry.source, { name: entry.name });
		}
		archive.append(systemInfoContent, { name: "system-info.txt" });
		archive.finalize().catch(reject);
	});
}

async function maybeRevealInExplorer(outPath: string): Promise<void> {
	try {
		const choice = await dialog.showMessageBox({
			type: "info",
			title: "Diagnostic bundle saved",
			message: `Saved to ${outPath}`,
			buttons: ["Open folder", "OK"],
			defaultId: 1,
			cancelId: 1,
		});
		if (choice.response === 0) {
			shell.showItemInFolder(outPath);
		}
	} catch (err) {
		dbg(
			"diag-bundle",
			"Post-save dialog failed:",
			err instanceof Error ? err.message : String(err)
		);
	}
}

async function handleSaveBundle(): Promise<DiagSaveResult> {
	try {
		const defaultPath = buildDefaultPath();
		const saveResult = await dialog.showSaveDialog({
			title: "Save diagnostic bundle",
			defaultPath,
			filters: [{ name: "Zip", extensions: ["zip"] }],
		});
		if (saveResult.canceled || !saveResult.filePath) {
			return { ok: false, cancelled: true };
		}
		const outPath = saveResult.filePath;
		const logsDir = getLogsFolder();
		const logFiles = collectExistingLogFiles(logsDir);
		const systemInfo = await buildSystemInfo();
		dbg("diag-bundle", "Building diagnostic bundle:", outPath, "logFiles:", logFiles.length);
		const { bytes } = await writeZipArchive(outPath, logFiles, systemInfo);
		dbg("diag-bundle", "Wrote diagnostic bundle:", outPath, "bytes:", bytes);
		breadcrumb("tray", "diagnostic bundle saved", { bytes, files: logFiles.length });
		await maybeRevealInExplorer(outPath);
		return { ok: true, path: outPath };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		dbg("diag-bundle", "Bundle save failed:", message);
		captureMainException(err, { source: "diag-bundle" });
		try {
			dialog.showErrorBox("Diagnostic bundle failed", message);
		} catch {
			// ignore — main concern is logging the underlying error above
		}
		return { ok: false, error: message };
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
};
