/**
 * Apple Intelligence provider adapter.
 *
 * Bridges the Electron main process to a bundled Swift CLI that calls
 * Apple's on-device `FoundationModels` framework (macOS 15+, Apple
 * Silicon only). The CLI lives at
 * `frontend/electron/resources/macos/winstt-apple-llm` and is built by
 * `tools/apple-intelligence-cli/build.sh` before electron-builder runs
 * the macOS distribution job.
 *
 * Contract (stdin/stdout JSON):
 *   stdin :  { "system": string, "user": string, "tokenLimit": number }
 *   stdout:  { "ok": true,  "text":  string } | { "ok": false, "error": string }
 *
 * This adapter wraps the CLI behind the same `(text, systemPrompt) => Promise<string>`
 * surface used by `processWithOllamaCustom` / `processWithOpenRouterCustom`
 * in llm.ts, so the existing dictation/transforms routing can dispatch to
 * Apple Intelligence with a single extra branch.
 *
 * Platform gating — `isAppleIntelligenceSupported()` returns true ONLY on
 * darwin+arm64. Renderers should hide the provider option entirely on
 * unsupported platforms; settings UIs may show it greyed-out on Intel Macs
 * (`process.platform === 'darwin' && process.arch !== 'arm64'`) with an
 * explanation that Apple Silicon is required.
 *
 * Availability check — performed lazily on the FIRST CALL only. Handy
 * observed early-init crashes when `SystemLanguageModel.default` is queried
 * during boot on macOS 26 betas; spawning the CLI lazily sidesteps that.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { dbg } from "../lib/debug-log";

/**
 * Predicate — true only on darwin+arm64. Apple Intelligence is restricted
 * to Apple Silicon; Intel Macs cannot run on-device FoundationModels at all
 * and the Swift CLI is compiled with `-target arm64-apple-macos15` (it
 * wouldn't run on x86_64 even if the framework were available).
 */
export function isAppleIntelligenceSupported(): boolean {
	return process.platform === "darwin" && process.arch === "arm64";
}

/**
 * Build the absolute path to the bundled `winstt-apple-llm` binary. In
 * production (packaged Electron app) the binary lives under
 * `process.resourcesPath/macos/`. During dev (`bun electron:dev`) the
 * source path is used — same layout `extraResources` points at —
 * so `bash tools/apple-intelligence-cli/build.sh` is enough to wire it
 * up locally.
 *
 * The resolver is split out so tests can inject a mock binary path; the
 * default behaviour is to read `process.resourcesPath`, which Bun's test
 * runner sets to `undefined`.
 */
export function resolveAppleLlmBinaryPath(): string {
	// `process.resourcesPath` is added at runtime by Electron's main process —
	// it's not part of the upstream `@types/node` Process surface, so we
	// access it via an indexed lookup to keep tsgo --strict happy.
	const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
	if (resourcesPath && typeof resourcesPath === "string") {
		return path.join(resourcesPath, "macos", "winstt-apple-llm");
	}
	// Dev fallback — repo-root-relative path; same physical file electron-builder
	// will copy via the macOS extraResources entry.
	return path.resolve(import.meta.dirname, "..", "resources", "macos", "winstt-apple-llm");
}

export interface AppleLlmRequest {
	/** System / instructions prompt fed to the FoundationModels session. */
	system: string;
	/** Word-count cap on the model's output; 0 disables truncation. */
	tokenLimit?: number;
	/** User content the model transforms. */
	user: string;
}

interface AppleLlmCliResponseOk {
	ok: true;
	text: string;
}

interface AppleLlmCliResponseErr {
	error: string;
	ok: false;
}

type AppleLlmCliResponse = AppleLlmCliResponseOk | AppleLlmCliResponseErr;

/**
 * Spawn options surface that we accept from injectable mocks. Identical to
 * the Node `child_process.spawn` signature we use in production; defining
 * it as an interface lets us swap in a Bun mock without leaking the full
 * spawn surface across the test boundary.
 */
type AppleLlmSpawnFn = typeof spawn;

export interface AppleLlmAdapterOptions {
	binaryPath?: string;
	spawnFn?: AppleLlmSpawnFn;
}

function isCliResponse(value: unknown): value is AppleLlmCliResponse {
	if (!value || typeof value !== "object") {
		return false;
	}
	const obj = value as Record<string, unknown>;
	if (obj.ok === true && typeof obj.text === "string") {
		return true;
	}
	if (obj.ok === false && typeof obj.error === "string") {
		return true;
	}
	return false;
}

/**
 * Parse the CLI's stdout payload. The protocol mandates a single trailing
 * newline; defensive parsing trims and tolerates leading whitespace so a
 * future BOM/printf quirk doesn't immediately break us. Returns null on
 * any malformed payload; the caller surfaces a generic protocol error.
 */
export function parseAppleLlmCliStdout(raw: string): AppleLlmCliResponse | null {
	const trimmed = raw.trim();
	if (!trimmed) {
		return null;
	}
	let json: unknown;
	try {
		json = JSON.parse(trimmed);
	} catch {
		return null;
	}
	return isCliResponse(json) ? json : null;
}

/**
 * Best-effort error class so callers see a stable type when matching
 * Apple Intelligence failures (unsupported platform, CLI missing, model
 * unavailable, decode failure). We don't extend the project's
 * `ConnectionError` because nothing about this is a network failure —
 * the CLI runs locally and on-device.
 */
export class AppleIntelligenceError extends Error {
	override readonly name = "AppleIntelligenceError";
	readonly reason: AppleIntelligenceErrorReason;
	constructor(reason: AppleIntelligenceErrorReason, message: string) {
		super(message);
		this.reason = reason;
	}
}

export type AppleIntelligenceErrorReason =
	| "unsupported-platform"
	| "binary-missing"
	| "spawn-failed"
	| "exited-with-error"
	| "protocol-error"
	| "model-unavailable"
	| "non-zero-exit";

/**
 * Promise wrapper around the Swift CLI. Default options spawn the bundled
 * binary; tests inject `spawnFn` to fake stdin/stdout without touching the
 * filesystem.
 *
 * Error policy — all failure paths reject with an `AppleIntelligenceError`,
 * never a raw Error. Callers in `llm.ts` may choose to fall back to the
 * original text on a non-fatal failure (matching the Ollama/OpenRouter
 * behaviour) or surface the error verbatim.
 */
export function callAppleIntelligenceCli(
	req: AppleLlmRequest,
	options: AppleLlmAdapterOptions = {}
): Promise<string> {
	if (!isAppleIntelligenceSupported()) {
		return Promise.reject(
			new AppleIntelligenceError(
				"unsupported-platform",
				"Apple Intelligence is only available on macOS with Apple Silicon."
			)
		);
	}
	const binaryPath = options.binaryPath ?? resolveAppleLlmBinaryPath();
	const spawnFn = options.spawnFn ?? spawn;
	return new Promise<string>((resolve, reject) => {
		runAppleLlmChild({ binaryPath, spawnFn, req, resolve, reject });
	});
}

interface RunChildArgs {
	binaryPath: string;
	reject: (err: AppleIntelligenceError) => void;
	req: AppleLlmRequest;
	resolve: (text: string) => void;
	spawnFn: AppleLlmSpawnFn;
}

function runAppleLlmChild(args: RunChildArgs): void {
	const { binaryPath, spawnFn, req, resolve, reject } = args;
	let child: ReturnType<AppleLlmSpawnFn>;
	try {
		child = spawnFn(binaryPath, [], { stdio: ["pipe", "pipe", "pipe"] });
	} catch (err) {
		reject(
			new AppleIntelligenceError(
				"spawn-failed",
				`Failed to spawn Apple Intelligence CLI at ${binaryPath}: ${stringifyError(err)}`
			)
		);
		return;
	}

	const stdoutChunks: string[] = [];
	const stderrChunks: string[] = [];
	child.stdout?.setEncoding("utf8");
	child.stderr?.setEncoding("utf8");
	child.stdout?.on("data", (chunk: string) => stdoutChunks.push(chunk));
	child.stderr?.on("data", (chunk: string) => stderrChunks.push(chunk));

	child.on("error", (err: Error) => {
		dbg("apple-intelligence", "spawn error", err.message);
		reject(
			new AppleIntelligenceError(
				err.message.includes("ENOENT") ? "binary-missing" : "spawn-failed",
				`Apple Intelligence CLI failed to start: ${err.message}`
			)
		);
	});

	child.on("close", (code: number | null) => {
		const stdout = stdoutChunks.join("");
		const stderr = stderrChunks.join("");
		finalizeAppleLlmChild({ code, stdout, stderr, resolve, reject });
	});

	const payload = JSON.stringify({
		system: req.system,
		user: req.user,
		tokenLimit: req.tokenLimit ?? 0,
	});
	try {
		child.stdin?.end(payload);
	} catch (err) {
		reject(
			new AppleIntelligenceError(
				"spawn-failed",
				`Failed to write to Apple Intelligence CLI stdin: ${stringifyError(err)}`
			)
		);
	}
}

interface FinalizeArgs {
	code: number | null;
	reject: (err: AppleIntelligenceError) => void;
	resolve: (text: string) => void;
	stderr: string;
	stdout: string;
}

function finalizeAppleLlmChild(args: FinalizeArgs): void {
	const { code, stdout, stderr, resolve, reject } = args;
	const parsed = parseAppleLlmCliStdout(stdout);
	if (!parsed) {
		reject(
			new AppleIntelligenceError(
				code === 0 ? "protocol-error" : "non-zero-exit",
				buildProtocolErrorMessage(code, stdout, stderr)
			)
		);
		return;
	}
	if (parsed.ok) {
		resolve(parsed.text);
		return;
	}
	// `parsed.ok === false` — the CLI cleanly reported failure (model
	// unavailable, decode failure, sandbox error, …). Classify the
	// common availability error here so the UI can show a tailored
	// hint ("Enable Apple Intelligence in Settings → Apple Intelligence").
	const reason = parsed.error.toLowerCase().includes("not currently available")
		? "model-unavailable"
		: "exited-with-error";
	reject(new AppleIntelligenceError(reason, parsed.error));
}

function buildProtocolErrorMessage(code: number | null, stdout: string, stderr: string): string {
	const parts: string[] = [
		`Apple Intelligence CLI returned an invalid response (exit ${code ?? "null"})`,
	];
	if (stderr.trim()) {
		parts.push(`stderr: ${stderr.trim()}`);
	}
	if (stdout.trim()) {
		parts.push(`stdout: ${stdout.trim()}`);
	}
	return parts.join(" | ");
}

function stringifyError(err: unknown): string {
	if (err instanceof Error) {
		return err.message;
	}
	return String(err);
}

/**
 * Public helper: classify whether Apple Intelligence is currently
 * SELECTABLE for the active platform. Renderers may use this via IPC to
 * decide whether to render the provider option at all (Windows/Linux),
 * render it greyed-out (Intel Macs), or render it normally (Apple
 * Silicon). The actual `SystemLanguageModel.default.availability` check
 * deliberately stays inside the Swift CLI — querying it from Node would
 * require a separate native binding and risks the early-init crash that
 * Handy hit on macOS 26 betas.
 */
export type AppleIntelligencePlatformState = "supported" | "intel-mac" | "non-darwin";

export function getAppleIntelligencePlatformState(): AppleIntelligencePlatformState {
	if (process.platform !== "darwin") {
		return "non-darwin";
	}
	if (process.arch !== "arm64") {
		return "intel-mac";
	}
	return "supported";
}
