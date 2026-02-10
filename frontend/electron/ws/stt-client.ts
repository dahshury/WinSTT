import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { dbg } from "../lib/debug-log";

const DEFAULT_CONTROL_PORT = 8011;
const DEFAULT_DATA_PORT = 8012;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RECONNECT_DELAY_MS = 30_000;

export interface SttClientOptions {
	controlPort?: number;
	dataPort?: number;
	host?: string;
}

interface PendingRequest {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
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

	private connectInternal(): Promise<void> {
		// Close any lingering sockets from the previous attempt before starting fresh
		this.controlWs?.close();
		this.dataWs?.close();
		this.controlWs = null;
		this.dataWs = null;

		const gen = ++this._gen;

		return new Promise((resolve, reject) => {
			let controlReady = false;
			let dataReady = false;
			let settled = false;
			this._disconnectedEmitted = false;

			const cleanup = () => {
				this.controlWs?.close();
				this.dataWs?.close();
				this.controlWs = null;
				this.dataWs = null;
			};

			const fail = (err: unknown) => {
				if (settled || gen !== this._gen) {
					return;
				}
				settled = true;
				cleanup();
				this.emit("error", err);
				reject(err);
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

	disconnect() {
		this.shouldReconnect = false;
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		this.controlWs?.close();
		this.dataWs?.close();
		this.controlWs = null;
		this.dataWs = null;
		this.rejectAllPending(new Error("Client disconnected"));
	}

	setParameter(parameter: string, value: unknown) {
		this.sendControl({
			command: "set_parameter",
			parameter,
			value,
		});
	}

	getParameter(parameter: string): Promise<unknown> {
		if (!this.isConnected) {
			return Promise.reject(new Error("Not connected"));
		}
		const requestId = ++this.requestIdCounter;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pendingRequests.delete(requestId);
				reject(new Error(`getParameter("${parameter}") timed out after ${REQUEST_TIMEOUT_MS}ms`));
			}, REQUEST_TIMEOUT_MS);

			this.pendingRequests.set(requestId, { resolve, reject, timer });
			this.sendControl({
				command: "get_parameter",
				parameter,
				request_id: requestId,
			});
		});
	}

	callMethod(method: string, args?: unknown[]) {
		this.sendControl({
			command: "call_method",
			method,
			args: args ?? [],
		});
	}

	listLoopbackDevices(): Promise<unknown> {
		if (!this.isConnected) {
			return Promise.reject(new Error("Not connected"));
		}
		const requestId = ++this.requestIdCounter;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pendingRequests.delete(requestId);
				reject(new Error(`listLoopbackDevices timed out after ${REQUEST_TIMEOUT_MS}ms`));
			}, REQUEST_TIMEOUT_MS);

			this.pendingRequests.set(requestId, { resolve, reject, timer });
			this.sendControl({
				command: "list_loopback_devices",
				request_id: requestId,
			});
		});
	}

	startLoopback(deviceIndex: number) {
		this.sendControl({
			command: "start_loopback",
			device_index: deviceIndex,
		});
	}

	stopLoopback() {
		this.sendControl({ command: "stop_loopback" });
	}

	get isConnected(): boolean {
		return (
			this.controlWs?.readyState === WebSocket.OPEN && this.dataWs?.readyState === WebSocket.OPEN
		);
	}

	sendControl(data: Record<string, unknown>) {
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

		this.controlWs?.close();
		this.dataWs?.close();
		this.controlWs = null;
		this.dataWs = null;
		this.rejectAllPending(new Error("Connection lost"));
		this.emit("disconnected");
		this.scheduleReconnect();
	}

	private scheduleReconnect() {
		if (!this.shouldReconnect) {
			return;
		}
		const delay = Math.min(1000 * 2 ** this.reconnectAttempt, MAX_RECONNECT_DELAY_MS);
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
		try {
			const data = JSON.parse(raw) as Record<string, unknown>;
			dbg("stt-ws", "control ←", raw.length > 200 ? `${raw.slice(0, 200)}…` : raw);
			if (data.request_id != null) {
				const pending = this.pendingRequests.get(data.request_id as number);
				if (pending) {
					clearTimeout(pending.timer);
					this.pendingRequests.delete(data.request_id as number);
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
		} catch (err) {
			console.warn("[stt-client] Malformed control message:", raw, err);
		}
	}

	private handleDataMessage(raw: string) {
		let data: Record<string, unknown>;
		try {
			data = JSON.parse(raw) as Record<string, unknown>;
		} catch (err) {
			console.warn("[stt-client] Malformed data message:", raw, err);
			return;
		}
		this.emit("data-event", data);
	}
}
