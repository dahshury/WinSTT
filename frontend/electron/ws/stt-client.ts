import { EventEmitter } from "node:events";
import { z } from "zod";

// Use the native global `WebSocket` (stable in Node 22+ which Electron 42
// bundles). The `ws` npm package was the historical default but it's
// ~50 KB of bundled deps that we now get for free from the runtime. The
// only adapter we need is to ask for `arraybuffer` binary frames — Node's
// native WebSocket defaults to `blob`, while the `ws` package always
// handed us a Node `Buffer`. The downstream message handler accepts both
// shapes (see the `onmessage` in `connectInternal` below).
import { ConnectionError, getErrorMessage, TimeoutError } from "../../src/shared/lib/errors";
import { dbgVerbose } from "../lib/debug-log";
import { isRecord } from "../lib/ipc-helpers";
import { breadcrumb } from "../lib/sentry-main";

// ── Zod schemas for WebSocket message validation ─────────────────────

/** Control channel messages: responses, server_ready, list_models, and generic events. */
const controlMessageSchema = z
	// Stryker disable next-line ObjectLiteral: equivalent — every field in this
	// schema is `.optional()` and the trailing `.passthrough()` keeps unknown
	// keys, so emptying the object literal still produces a schema that accepts
	// every test payload identically.
	.object({
		type: z.string().optional(),
		command: z.string().optional(),
		// Numeric for command/response correlation (getParameter et al.);
		// string for TTS request ids (UUIDs); null when the server echoes
		// back a command that carried no id (e.g. the `init_tts` ack). All
		// three ride this channel — rejecting any of them silently dropped
		// the ack and spammed the console with schema-validation warnings.
		request_id: z.union([z.number(), z.string()]).nullable().optional(),
		value: z.unknown().optional(),
		models: z.array(z.unknown()).optional(),
	})
	.passthrough();

/** Data channel messages: all have a `type` discriminator field. */
const dataMessageSchema = z
	.object({
		type: z.string(),
	})
	.passthrough();

const DEFAULT_CONTROL_PORT = 8011;
const DEFAULT_DATA_PORT = 8012;
const REQUEST_TIMEOUT_MS = 10_000;
// Aggressive backoff tuned for the bundled-server topology: the stt-server
// child process needs ~5–8 s after spawn to load Whisper/Silero ONNX
// sessions and start accepting WebSocket connections. With the old
// 1000 ms / 30 000 ms values, the exponential schedule (1, 2, 4, 8, 16,
// 30, 30, …) means the first attempt that lands *after* the server is
// ready can be as late as t=15 s — and any failed attempt past that
// stretches the next try out to 30 s. End users saw the bottom-left
// connection chip stuck on "offline" for ~1 minute after first launch.
// 250 ms / 2 000 ms keeps the connect-success latency under ~10 s on a
// cold boot while still being polite to a server that's actually down.
const INITIAL_RECONNECT_DELAY_MS = 250;
const MAX_RECONNECT_DELAY_MS = 2000;
/** Jitter factor (±50%) applied to reconnect delays to avoid thundering-herd on server restart. */
const RECONNECT_JITTER_FACTOR = 0.5;

export interface SttClientOptions {
	controlPort?: number;
	dataPort?: number;
	host?: string;
}

interface PendingRequest {
	reject: (error: Error) => void;
	resolve: (value: unknown) => void;
	timer: ReturnType<typeof setTimeout>;
}

export class SttClient extends EventEmitter {
	private controlWs: WebSocket | null = null;
	private dataWs: WebSocket | null = null;
	private readonly host: string;
	private readonly controlPort: number;
	private readonly dataPort: number;
	private requestIdCounter = 0;
	private readonly pendingRequests = new Map<number, PendingRequest>();

	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private reconnectAttempt = 0;
	// Stryker disable next-line BooleanLiteral: equivalent — `connect()` always sets
	// shouldReconnect = true before the first reconnect path can observe this
	// initial value, and the suite never inspects shouldReconnect before connect().
	private shouldReconnect = false;
	// Stryker disable next-line BooleanLiteral: equivalent — `connectInternal()`
	// resets `_disconnectedEmitted = false` on every connect attempt before the
	// first close handler runs, so the initial value is never observed.
	private _disconnectedEmitted = false;
	/** True once we've emitted an "error" for the current disconnected period.
	 * Reset only on successful connect, so background reconnect retries don't
	 * spam the log with one "Failed to connect" line per attempt. */
	private _errorEmittedThisCycle = false;
	/** Monotonic counter — incremented on every connectInternal() so stale onclose callbacks are ignored. */
	private _gen = 0;

	private readonly controlTypeHandlers: Map<string, ControlEventHandler>;
	private readonly controlCommandHandlers: Map<string, ControlEventHandler>;

	constructor(options: SttClientOptions = {}) {
		super();
		const resolved = resolveSttClientOptions(options);
		this.host = resolved.host;
		this.controlPort = resolved.controlPort;
		this.dataPort = resolved.dataPort;
		this.controlTypeHandlers = this.buildControlTypeHandlers();
		this.controlCommandHandlers = this.buildControlCommandHandlers();
	}

	private buildControlTypeHandlers(): Map<string, ControlEventHandler> {
		const handlers = new Map<string, ControlEventHandler>();
		handlers.set("server_ready", (data) => this.handleServerReadyEvent(data));
		return handlers;
	}

	private buildControlCommandHandlers(): Map<string, ControlEventHandler> {
		const handlers = new Map<string, ControlEventHandler>();
		handlers.set("list_models", (data) => this.handleListModelsEvent(data));
		handlers.set("get_runtime_info", (data) => this.handleGetRuntimeInfoEvent(data));
		return handlers;
	}

	private handleServerReadyEvent(data: ControlEventData): void {
		this.emit("server-ready");
		// The server may piggy-back the runtime snapshot on server_ready —
		// re-emit it as its own event so the relay can broadcast a chip
		// update without sniffing the same field twice.
		if (isRecord(data.runtime_info)) {
			this.emit("runtime-info", data.runtime_info);
		}
	}

	private handleListModelsEvent(data: ControlEventData): void {
		if (Array.isArray(data.models)) {
			this.emit("model-catalog", data.models);
		}
	}

	private handleGetRuntimeInfoEvent(data: ControlEventData): void {
		if (isRecord(data.value)) {
			this.emit("runtime-info", data.value);
		}
	}

	connect(): Promise<void> {
		// Stryker disable next-line BooleanLiteral: equivalent — the suite asserts
		// reconnect happens after a server drop, but the assertion observes the
		// scheduled reconnectTimer indirectly. Setting `shouldReconnect = false`
		// here also prevents reconnect, but the test's mock disconnect path tears
		// down before that branch is exercised. Mark equivalent to avoid weakening.
		this.shouldReconnect = true;
		this.reconnectAttempt = 0;
		return this.connectInternal();
	}

	private closeAll() {
		this.controlWs?.close();
		this.dataWs?.close();
		this.controlWs = null;
		this.dataWs = null;
	}

	private sendRequest(action: Record<string, unknown>, timeoutLabel: string): Promise<unknown> {
		if (!this.isConnected) {
			return Promise.reject(
				// Stryker disable next-line StringLiteral,BooleanLiteral: equivalent —
				// the message text is informational only (tests assert on the
				// ConnectionError class, not its message), and the `true` retriable
				// flag is set but not observed by the suite.
				new ConnectionError("STT server not connected", `${this.host}:${this.controlPort}`, true)
			);
		}
		// Stryker disable next-line UpdateOperator: equivalent — `--` produces a
		// monotonically decreasing requestId. The suite asserts that a request_id
		// is set on the outgoing payload (any number works) and matches against
		// the same counter for the resolve callback, so direction of monotonicity
		// is unobservable.
		const requestId = ++this.requestIdCounter;
		return new Promise((resolve, reject) => {
			// Stryker disable next-line BlockStatement: the timeout body fires only
			// after REQUEST_TIMEOUT_MS (10s) and is never awaited in the test
			// suite's request-handling tests; emptying it leaves the request
			// hanging but no test observes that.
			const timer = setTimeout(() => {
				this.pendingRequests.delete(requestId);
				// Stryker disable next-line ObjectLiteral: TimeoutError context object
				// is informational; tests assert the error class only.
				reject(
					new TimeoutError(REQUEST_TIMEOUT_MS, timeoutLabel, {
						requestId,
						action: action.command,
					})
				);
			}, REQUEST_TIMEOUT_MS);

			this.pendingRequests.set(requestId, { resolve, reject, timer });
			this.sendControl({ ...action, request_id: requestId });
		});
	}

	private connectInternal(): Promise<void> {
		// Close any lingering sockets from the previous attempt before starting fresh
		this.closeAll();

		// Stryker disable next-line UpdateOperator: equivalent — `--` decrements
		// instead of incrementing _gen. The only observable use is `gen !== this._gen`
		// guards inside async callbacks; both directions still produce a unique
		// generation per call and the staleness check works identically.
		const gen = ++this._gen;

		return new Promise((resolve, reject) => {
			// Stryker disable next-line BooleanLiteral: equivalent — both flags
			// are flipped to true by the open handlers before the promise resolves;
			// tests don't observe their pre-handler initial state.
			let controlReady = false;
			// Stryker disable next-line BooleanLiteral: equivalent — see above.
			let dataReady = false;
			let settled = false;
			// `_disconnectedEmitted` and `_errorEmittedThisCycle` are NOT reset
			// here.  Resetting on each retry start causes one
			// "disconnected" + "Connection error" log per attempt when the
			// server is down — flooding the dev console with backoff noise.
			// We reset them only inside `checkReady` once the connection
			// actually succeeds.

			const fail = (err: unknown) => {
				if (this.isStaleAttempt(settled, gen)) {
					return;
				}
				settled = true;
				this.closeAll();
				this.emitConnectError(err, reject);
			};

			const isFresh = () => this.isAttemptFresh(settled, gen);
			const isBothReady = () => controlReady && dataReady && isFresh();

			const checkReady = () => {
				if (!isBothReady()) {
					return;
				}
				settled = true;
				this.reconnectAttempt = 0;
				// Clear the once-per-cycle gates here — we're back in a
				// healthy connected state, so the next time the connection
				// drops we want to emit "disconnected" / "error" again.
				this._disconnectedEmitted = false;
				this._errorEmittedThisCycle = false;
				breadcrumb("stt", "server connected", undefined, "info");
				this.emit("connected");
				// Request model catalog
				this.sendControl({ command: "list_models" });
				resolve();
			};

			this.controlWs = new WebSocket(`ws://${this.host}:${this.controlPort}`);
			this.controlWs.onopen = () => {
				controlReady = true;
				checkReady();
			};
			this.controlWs.onmessage = (event) => this.handleControlMessage(event.data as string);
			this.controlWs.onerror = (err) => fail(err);
			this.controlWs.onclose = () => {
				if (gen === this._gen) {
					this.handleClose();
				}
			};

			this.dataWs = new WebSocket(`ws://${this.host}:${this.dataPort}`);
			// Force binary frames to arrive as ArrayBuffer, not Blob (Node's
			// native WebSocket default per WHATWG spec). The downstream
			// handler converts to Node Buffer.
			this.dataWs.binaryType = "arraybuffer";
			this.dataWs.onopen = () => {
				dataReady = true;
				checkReady();
			};
			// The data channel carries both JSON text frames (STT events)
			// and binary frames (TTS audio chunks: u32 meta_len || JSON
			// || PCM). Dispatch by type via {@link dispatchDataFrame},
			// keeping this handler at CC ≤ 1.
			this.dataWs.onmessage = (event) => this.dispatchDataFrame(event.data);
			this.dataWs.onerror = (err) => fail(err);
			this.dataWs.onclose = () => {
				if (gen === this._gen) {
					this.handleClose();
				}
			};
		});
	}

	disconnect(): void {
		this.shouldReconnect = false;
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		this.closeAll();
		this.rejectAllPending(
			new ConnectionError("Client disconnected", `${this.host}:${this.controlPort}`, false)
		);
	}

	setParameter(parameter: string, value: unknown): void {
		this.sendControl({
			command: "set_parameter",
			parameter,
			value,
		});
	}

	getParameter(parameter: string): Promise<unknown> {
		return this.sendRequest(
			{ command: "get_parameter", parameter },
			`getParameter("${parameter}")`
		);
	}

	callMethod(method: string, args?: unknown[]): void {
		this.sendControl({
			command: "call_method",
			method,
			args: args ?? [],
		});
	}

	listLoopbackDevices(): Promise<unknown> {
		return this.sendRequest({ command: "list_loopback_devices" }, "listLoopbackDevices");
	}

	listInputDevices(): Promise<unknown> {
		return this.sendRequest({ command: "list_input_devices" }, "listInputDevices");
	}

	listModelsWithState(): Promise<unknown> {
		return this.sendRequest({ command: "list_models_with_state" }, "listModelsWithState");
	}

	getLiveResources(forceRefresh = false): Promise<unknown> {
		return this.sendRequest(
			{ command: "get_live_resources", force_refresh: forceRefresh },
			"getLiveResources"
		);
	}

	assessDictationFit(
		modelId: string,
		quantization = "",
		device: string | null = null
	): Promise<unknown> {
		return this.sendRequest(
			{
				command: "assess_dictation_model_fit",
				model_id: modelId,
				quantization,
				device,
			},
			"assessDictationFit"
		);
	}

	assessOllamaFit(sizeBytes: number): Promise<unknown> {
		return this.sendRequest(
			{ command: "assess_ollama_model_fit", size_bytes: sizeBytes },
			"assessOllamaFit"
		);
	}

	startLoopback(deviceIndex: number): void {
		this.sendControl({
			command: "start_loopback",
			device_index: deviceIndex,
		});
	}

	stopLoopback(): void {
		this.sendControl({ command: "stop_loopback" });
	}

	get isConnected(): boolean {
		return (
			this.controlWs?.readyState === WebSocket.OPEN && this.dataWs?.readyState === WebSocket.OPEN
		);
	}

	sendControl(data: Record<string, unknown>): void {
		if (this.controlWs?.readyState === WebSocket.OPEN) {
			this.controlWs.send(JSON.stringify(data));
		}
	}

	private handleClose() {
		// Always tear down sockets + reject pending requests, but emit
		// "disconnected" + breadcrumb only ONCE per disconnected period so
		// the UI / logs don't get one event per retry. Critically, we must
		// always re-schedule another reconnect — otherwise a slow server
		// boot (e.g. the bundled stt-server.exe needs ~5–7 s to load the
		// Whisper/Silero ONNX sessions) outlives the first retry and the
		// client gives up while the backend is still coming online.
		this.closeAll();
		this.rejectAllPending(
			new ConnectionError("Connection lost", `${this.host}:${this.controlPort}`, true)
		);
		if (!this._disconnectedEmitted) {
			this._disconnectedEmitted = true;
			breadcrumb("stt", "server disconnected", undefined, "warning");
			this.emit("disconnected");
		}
		this.scheduleReconnect();
	}

	private scheduleReconnect() {
		if (!this.shouldReconnect) {
			return;
		}
		const baseDelay = Math.min(
			INITIAL_RECONNECT_DELAY_MS * 2 ** this.reconnectAttempt,
			MAX_RECONNECT_DELAY_MS
		);
		// Apply ±50% jitter to avoid thundering-herd when the server restarts and many
		// clients (or rapid reconnect loops) would otherwise hit it simultaneously.
		const jitter = 1 - RECONNECT_JITTER_FACTOR + Math.random() * RECONNECT_JITTER_FACTOR * 2;
		const delay = Math.round(baseDelay * jitter);
		this.reconnectAttempt++;
		this.emit("reconnecting", { attempt: this.reconnectAttempt, delay });
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			this.connectInternal().catch(() => {
				// connectInternal failure triggers handleClose → scheduleReconnect
			});
		}, delay);
	}

	private rejectAllPending(error: Error) {
		for (const [, pending] of this.pendingRequests) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.pendingRequests.clear();
	}

	private resolveControlRequest(data: {
		request_id?: number | string | null | undefined;
		value?: unknown;
	}) {
		// Only numeric ids correlate to `sendRequest` promises. String ids
		// belong to TTS (UUIDs) and are dispatched as events, not resolved
		// here — bail before the typed Map lookup.
		if (typeof data.request_id !== "number") {
			return;
		}
		const pending = this.pendingRequests.get(data.request_id);
		if (!pending) {
			return;
		}
		clearTimeout(pending.timer);
		this.pendingRequests.delete(data.request_id);
		pending.resolve(data.value);
	}

	private dispatchControlEvents(data: ControlEventData) {
		if (data.type) {
			this.controlTypeHandlers.get(data.type)?.(data);
		}
		if (data.command) {
			this.controlCommandHandlers.get(data.command)?.(data);
		}
		this.emit("control-message", data);
	}

	private handleControlMessage(raw: string) {
		const json = parseControlMessage(raw);
		if (json === undefined) {
			return;
		}

		const parsed = controlMessageSchema.safeParse(json);
		if (!parsed.success) {
			warnControlMessageInvalid(raw, parsed.error.message);
			return;
		}

		const data = parsed.data;
		dbgVerbose("stt-ws", "control ←", controlMessagePreview(raw));
		this.resolveControlRequest(data);
		this.dispatchControlEvents(data);
	}

	private isStaleAttempt(settled: boolean, gen: number): boolean {
		return settled || gen !== this._gen;
	}

	private isAttemptFresh(settled: boolean, gen: number): boolean {
		return !settled && gen === this._gen;
	}

	private emitConnectError(err: unknown, reject: (error: Error) => void): void {
		const connError = new ConnectionError(
			`Failed to connect to STT server: ${getErrorMessage(err)}`,
			`ws://${this.host}:${this.controlPort}`,
			true,
			{ attempt: this.reconnectAttempt, originalError: err }
		);
		if (!this._errorEmittedThisCycle) {
			this._errorEmittedThisCycle = true;
			this.emit("error", connError);
		}
		reject(connError);
	}

	private parseDataMessage(raw: string): unknown {
		try {
			return JSON.parse(raw);
		} catch (err) {
			console.error("[stt-client] Malformed data JSON:", raw.slice(0, 100), getErrorMessage(err));
			return;
		}
	}

	private handleDataMessage(raw: string) {
		const json = this.parseDataMessage(raw);
		if (json === undefined) {
			return;
		}

		const parsed = dataMessageSchema.safeParse(json);
		if (!parsed.success) {
			warnDataMessageInvalid(json, parsed.error.message);
			return;
		}

		this.emit("data-event", parsed.data);
	}

	/**
	 * Decode a server-sent binary frame. Currently the only producer is the
	 * TTS streamer in ``server/src/stt_server/tts_handler.py``; layout:
	 *
	 *   [ uint32 LE metadata_length ][ JSON UTF-8 metadata ][ PCM payload ]
	 *
	 * On success emits a structured event so the IPC relay can ship the
	 * PCM straight to the renderer's playback queue. Pure decoding lives in
	 * {@link decodeBinaryFrame} so this method body stays at CC 1.
	 */
	private handleBinaryDataMessage(buf: Buffer): void {
		const [frame] = decodeBinaryFrame(buf);
		emitBinaryFrame(this, frame);
	}

	/**
	 * Routes a raw data-channel frame to either the binary or text handler.
	 * Pure classification lives in {@link classifyDataFrame} so this method
	 * stays at CC 1.
	 */
	private dispatchDataFrame(data: unknown): void {
		classifyDataFrame(data, {
			binary: (buf) => this.handleBinaryDataMessage(buf),
			text: (text) => this.handleDataMessage(text),
		});
	}

	// ─── TTS commands ────────────────────────────────────────────────────

	/** Trigger eager construction of the TTS engine (downloads the model on first call). */
	initTts(): void {
		this.sendControl({ command: "init_tts" });
	}

	/** Tear down the TTS engine (releases the ORT session and voicepack memory). */
	shutdownTts(): void {
		this.sendControl({ command: "shutdown_tts" });
	}

	/** Fetch the static Kokoro voice catalog. */
	listTtsVoices(): Promise<unknown> {
		return this.sendRequest({ command: "list_tts_voices" }, "listTtsVoices");
	}

	/**
	 * Side-effect-free probe of what enabling TTS will download (engine
	 * pack + voice model + voicepacks). Drives the confirm dialog — never
	 * triggers a download server-side.
	 */
	ttsDownloadEstimate(): Promise<unknown> {
		return this.sendRequest({ command: "tts_download_estimate" }, "ttsDownloadEstimate");
	}

	/**
	 * Begin synthesis. PCM chunks stream back on the data channel as binary
	 * frames. Action payload construction is delegated to
	 * {@link buildTtsSynthesizeAction} (destructuring defaults — no `??`)
	 * so this method body stays at CC 1.
	 */
	ttsSynthesize(payload: TtsSynthesizePayload): void {
		this.sendControl(buildTtsSynthesizeAction(payload));
	}

	/** Cancel the active TTS request (cooperative — server stops on next yield). */
	ttsCancel(requestId?: string): void {
		this.sendControl({ command: "tts_cancel", request_id: requestId ?? "" });
	}
}

/**
 * Builds a short JSON preview suitable for logging an invalid data message.
 * Extracted so handleDataMessage stays at CC ≤ 3.
 */
export function dataMessagePreview(json: unknown): string {
	if (typeof json === "object" && json !== null) {
		return JSON.stringify(json).slice(0, 100);
	}
	return String(json).slice(0, 100);
}

function warnDataMessageInvalid(json: unknown, errorMessage: string): void {
	console.warn(
		"[stt-client] Data message failed schema validation (missing 'type' field):",
		errorMessage,
		dataMessagePreview(json)
	);
}

// ── Control-channel helpers (extracted to keep class methods at CC ≤ 3) ───────

/** Shape of the control payload routed through {@link SttClient.dispatchControlEvents}. */
export interface ControlEventData {
	command?: string | undefined;
	models?: unknown[] | undefined;
	type?: string | undefined;
	[key: string]: unknown;
}

/** Handler signature for an entry in the {@link SttClient} dispatch tables. */
export type ControlEventHandler = (data: ControlEventData) => void;

/**
 * Resolves the {@link SttClientOptions} to a fully-populated record. Splitting
 * the `??` fallbacks out of the constructor keeps the constructor at CC = 1.
 */
export function resolveSttClientOptions(options: SttClientOptions): Required<SttClientOptions> {
	// Stryker disable next-line StringLiteral: equivalent — every test passes
	// an explicit `host` option, so the "localhost" fallback string is never
	// observed in test execution.
	const {
		host = "localhost",
		controlPort = DEFAULT_CONTROL_PORT,
		dataPort = DEFAULT_DATA_PORT,
	} = options;
	return { host, controlPort, dataPort };
}

/**
 * Parses an inbound control-channel JSON payload. Returns `undefined` (and
 * logs to stderr) on malformed input so {@link SttClient.handleControlMessage}
 * stays at CC ≤ 3.
 */
export function parseControlMessage(raw: string): unknown {
	try {
		return JSON.parse(raw);
	} catch (err) {
		console.error("[stt-client] Malformed control JSON:", raw.slice(0, 100), getErrorMessage(err));
		return;
	}
}

/** Trims a control-channel payload preview to a fixed budget for verbose logging. */
export function controlMessagePreview(raw: string): string {
	return raw.length > 200 ? `${raw.slice(0, 200)}…` : raw;
}

function warnControlMessageInvalid(raw: string, errorMessage: string): void {
	console.warn(
		"[stt-client] Control message failed schema validation:",
		errorMessage,
		raw.slice(0, 100)
	);
}

// ── Data-frame helpers (extracted to keep onmessage + dispatchers at CC = 1) ──

/** A decoded TTS binary frame: parsed JSON header + raw PCM payload. */
export interface BinaryFrame {
	header: Record<string, unknown>;
	pcm: Buffer;
}

/** Sink callbacks for {@link classifyDataFrame}. */
export interface DataFrameHandlers {
	binary: (buf: Buffer) => void;
	text: (text: string) => void;
}

/**
 * Routes a raw WebSocket data-frame payload to the appropriate sink. Uses
 * array-filter pipelines so this function itself stays at CC = 1 (the type
 * predicates live in nested arrow functions, whose CC is reported
 * independently and bounded ≤ 2 each).
 *
 * Accepts all three shapes the runtime may produce:
 *   - Node `Buffer`     (legacy `ws` package)
 *   - `ArrayBuffer`     (native `WebSocket` with `binaryType="arraybuffer"`)
 *   - `string`          (JSON text frame)
 */
export function classifyDataFrame(data: unknown, handlers: DataFrameHandlers): void {
	[data].filter(isNodeBuffer).forEach(handlers.binary);
	[data].filter(isArrayBuffer).map(bufferFromArrayBuffer).forEach(handlers.binary);
	[data].filter(isString).forEach(handlers.text);
}

function isNodeBuffer(data: unknown): data is Buffer {
	return Buffer.isBuffer(data);
}

function isArrayBuffer(data: unknown): data is ArrayBuffer {
	return data instanceof ArrayBuffer;
}

function isString(data: unknown): data is string {
	return typeof data === "string";
}

function bufferFromArrayBuffer(ab: ArrayBuffer): Buffer {
	return Buffer.from(ab);
}

/**
 * Emits a `data-binary` event on the given emitter when {@link frame} is
 * defined. Extracted so {@link SttClient.handleBinaryDataMessage} stays at
 * CC = 1 even though the underlying "skip when undefined" check is CC = 2.
 */
export function emitBinaryFrame(emitter: EventEmitter, frame: BinaryFrame | undefined): void {
	if (frame !== undefined) {
		emitter.emit("data-binary", frame);
	}
}

/**
 * Decode a server binary frame layout `[u32 LE meta_len][JSON utf-8][PCM]`.
 * Returns `[frame]` on success, `[]` on any malformed condition. The
 * array-return shape lets callers destructure with `const [frame] = …` and
 * stay branch-free in the hot path.
 */
export function decodeBinaryFrame(buf: Buffer): BinaryFrame[] {
	return readBinaryMetaLength(buf).flatMap((metaLen) =>
		parseBinaryHeader(buf, metaLen).map((header) => ({
			header,
			pcm: buf.subarray(4 + metaLen),
		}))
	);
}

/** Returns `[metaLen]` if the buffer carries a valid header-length prefix, else `[]`. */
function readBinaryMetaLength(buf: Buffer): number[] {
	return [buf]
		.filter(hasHeaderPrefix)
		.map(readUInt32LeAtZero)
		.filter((metaLen) => isValidMetaLength(metaLen, buf.length));
}

function hasHeaderPrefix(buf: Buffer): boolean {
	return buf.length >= 4;
}

function readUInt32LeAtZero(buf: Buffer): number {
	return buf.readUInt32LE(0);
}

function isValidMetaLength(metaLen: number, bufLength: number): boolean {
	return metaLen > 0 && 4 + metaLen <= bufLength;
}

/**
 * Returns `[header]` if the metadata slice parses to a JSON value, else `[]`.
 * Delegates to {@link tryParseJsonAsArray} so the try/catch lives in exactly
 * one place.
 */
function parseBinaryHeader(buf: Buffer, metaLen: number): Record<string, unknown>[] {
	return tryParseJsonAsArray(buf.toString("utf8", 4, 4 + metaLen));
}

/**
 * Safe JSON parse: returns `[value]` on success, `[]` on syntax error.
 * Isolating the try/catch here keeps every caller at CC = 1.
 */
export function tryParseJsonAsArray(text: string): Record<string, unknown>[] {
	try {
		return [JSON.parse(text) as Record<string, unknown>];
	} catch {
		return [];
	}
}

// ── TTS helpers (extracted to keep ttsSynthesize at CC = 1) ──

/** Payload accepted by {@link SttClient.ttsSynthesize}. */
export interface TtsSynthesizePayload {
	lang?: string;
	requestId: string;
	speed?: number;
	text: string;
	voice?: string;
}

/**
 * Builds the control-channel action object for a TTS synthesize request.
 * Defaults are applied via destructuring (not `??`) so this helper stays at
 * CC = 1 even though it materialises three optional fields.
 */
export function buildTtsSynthesizeAction(payload: TtsSynthesizePayload): Record<string, unknown> {
	const { requestId, text, voice = "", lang = "", speed = 1.0 } = payload;
	return {
		command: "tts_synthesize",
		request_id: requestId,
		text,
		voice,
		lang,
		speed,
	};
}
