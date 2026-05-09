import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { z } from "zod";
import { ConnectionError, getErrorMessage, TimeoutError } from "../../src/shared/lib/errors";
import { dbgVerbose } from "../lib/debug-log";

// ── Zod schemas for WebSocket message validation ─────────────────────

/** Control channel messages: responses, server_ready, list_models, and generic events. */
const controlMessageSchema = z
	.object({
		type: z.string().optional(),
		command: z.string().optional(),
		request_id: z.number().optional(),
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
const INITIAL_RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 30_000;
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
	private shouldReconnect = false;
	private _disconnectedEmitted = false;
	/** Monotonic counter — incremented on every connectInternal() so stale onclose callbacks are ignored. */
	private _gen = 0;

	constructor(options: SttClientOptions = {}) {
		super();
		this.host = options.host ?? "localhost";
		this.controlPort = options.controlPort ?? DEFAULT_CONTROL_PORT;
		this.dataPort = options.dataPort ?? DEFAULT_DATA_PORT;
	}

	connect(): Promise<void> {
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
				new ConnectionError("STT server not connected", `${this.host}:${this.controlPort}`, true)
			);
		}
		const requestId = ++this.requestIdCounter;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pendingRequests.delete(requestId);
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

		const gen = ++this._gen;

		return new Promise((resolve, reject) => {
			let controlReady = false;
			let dataReady = false;
			let settled = false;
			this._disconnectedEmitted = false;

			const fail = (err: unknown) => {
				if (settled || gen !== this._gen) {
					return;
				}
				settled = true;
				this.closeAll();
				const connError = new ConnectionError(
					`Failed to connect to STT server: ${getErrorMessage(err)}`,
					`ws://${this.host}:${this.controlPort}`,
					true,
					{ attempt: this.reconnectAttempt, originalError: err }
				);
				this.emit("error", connError);
				reject(connError);
			};

			const checkReady = () => {
				if (controlReady && dataReady && !settled && gen === this._gen) {
					settled = true;
					this.reconnectAttempt = 0;
					this.emit("connected");
					// Request model catalog
					this.sendControl({ command: "list_models" });
					resolve();
				}
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
			this.dataWs.onopen = () => {
				dataReady = true;
				checkReady();
			};
			this.dataWs.onmessage = (event) => this.handleDataMessage(event.data as string);
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
		// Only emit disconnected once per connection
		if (this._disconnectedEmitted) {
			return;
		}
		this._disconnectedEmitted = true;

		this.closeAll();
		this.rejectAllPending(
			new ConnectionError("Connection lost", `${this.host}:${this.controlPort}`, true)
		);
		this.emit("disconnected");
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

	private handleControlMessage(raw: string) {
		let json: unknown;
		try {
			json = JSON.parse(raw);
		} catch (err) {
			console.error(
				"[stt-client] Malformed control JSON:",
				raw.slice(0, 100),
				getErrorMessage(err)
			);
			return;
		}

		const parsed = controlMessageSchema.safeParse(json);
		if (!parsed.success) {
			console.warn(
				"[stt-client] Control message failed schema validation:",
				parsed.error.message,
				raw.slice(0, 100)
			);
			return;
		}

		const data = parsed.data;
		dbgVerbose("stt-ws", "control ←", raw.length > 200 ? `${raw.slice(0, 200)}…` : raw);

		if (data.request_id != null) {
			const pending = this.pendingRequests.get(data.request_id);
			if (pending) {
				clearTimeout(pending.timer);
				this.pendingRequests.delete(data.request_id);
				pending.resolve(data.value);
			}
		}
		if (data.type === "server_ready") {
			this.emit("server-ready");
		}
		if (data.command === "list_models" && Array.isArray(data.models)) {
			this.emit("model-catalog", data.models);
		}
		this.emit("control-message", data);
	}

	private handleDataMessage(raw: string) {
		let json: unknown;
		try {
			json = JSON.parse(raw);
		} catch (err) {
			console.error("[stt-client] Malformed data JSON:", raw.slice(0, 100), getErrorMessage(err));
			return;
		}

		const parsed = dataMessageSchema.safeParse(json);
		if (!parsed.success) {
			console.warn(
				"[stt-client] Data message failed schema validation (missing 'type' field):",
				parsed.error.message,
				typeof json === "object" && json !== null
					? JSON.stringify(json).slice(0, 100)
					: String(json).slice(0, 100)
			);
			return;
		}

		this.emit("data-event", parsed.data);
	}
}
