import { test } from "bun:test";
import type { components } from "@spec/schema";
import fc from "fast-check";
import type { GpuInfo, ServerStatus } from "@/shared/api/models";
import { type RuntimeInfo, useConnectionStore } from "./connection-store";

type ConnectionStatus = components["schemas"]["ConnectionStatus"];

const CONNECTION_STATUSES: ConnectionStatus[] = [
	"disconnected",
	"connecting",
	"connected",
	"error",
];
const SERVER_STATUSES: ServerStatus[] = [
	"idle",
	"starting",
	"running",
	"error",
];

interface Model {
	connectionStatus: ConnectionStatus;
	gpuInfo: GpuInfo[];
	runtimeInfo: RuntimeInfo | null;
	serverStatus: ServerStatus;
}

type Real = typeof useConnectionStore;

function resetStore(): void {
	useConnectionStore.setState({
		connectionStatus: "disconnected",
		serverStatus: "idle",
		gpuInfo: [],
		runtimeInfo: null,
	});
}

function freshModel(): Model {
	return {
		connectionStatus: "disconnected",
		serverStatus: "idle",
		gpuInfo: [],
		runtimeInfo: null,
	};
}

class SetConnectionStatusCmd implements fc.Command<Model, Real> {
	readonly status: ConnectionStatus;
	constructor(status: ConnectionStatus) {
		this.status = status;
	}
	check(): boolean {
		return true;
	}
	run(m: Model, real: Real): void {
		// Snapshot the OTHER slices from the REAL store (not the model). The model
		// seeds its own fresh `[]` / `null` references that are distinct from the
		// store's initial ones, so comparing the post-call store against the model
		// would spuriously fail the "untouched" check on the very first command
		// (`[] !== []`). Capturing the store's own pre-call references makes the
		// orthogonality invariant exact: this setter must not REPLACE those refs.
		const prevServer = real.getState().serverStatus;
		const prevGpu = real.getState().gpuInfo;
		const prevRuntime = real.getState().runtimeInfo;
		real.getState().setConnectionStatus(this.status);
		m.connectionStatus = this.status;
		const s = real.getState();
		if (s.connectionStatus !== this.status) {
			throw new Error("connectionStatus mismatch");
		}
		// orthogonality: other slices untouched
		if (s.serverStatus !== prevServer) {
			throw new Error("setConnectionStatus mutated serverStatus");
		}
		if (s.gpuInfo !== prevGpu) {
			throw new Error("setConnectionStatus mutated gpuInfo");
		}
		if (s.runtimeInfo !== prevRuntime) {
			throw new Error("setConnectionStatus mutated runtimeInfo");
		}
		if (!CONNECTION_STATUSES.includes(s.connectionStatus)) {
			throw new Error("connectionStatus out of enum");
		}
	}
	toString(): string {
		return `setConn(${this.status})`;
	}
}

class SetServerStatusCmd implements fc.Command<Model, Real> {
	readonly status: ServerStatus;
	constructor(status: ServerStatus) {
		this.status = status;
	}
	check(): boolean {
		return true;
	}
	run(m: Model, real: Real): void {
		// Snapshot from the REAL store (see SetConnectionStatusCmd) so the
		// orthogonality check verifies the store didn't change, independent of the
		// model's separately-seeded references.
		const prevConn = real.getState().connectionStatus;
		real.getState().setServerStatus(this.status);
		m.serverStatus = this.status;
		const s = real.getState();
		if (s.serverStatus !== this.status) {
			throw new Error("serverStatus mismatch");
		}
		if (s.connectionStatus !== prevConn) {
			throw new Error("setServerStatus mutated connectionStatus");
		}
		if (!SERVER_STATUSES.includes(s.serverStatus)) {
			throw new Error("serverStatus out of enum");
		}
	}
	toString(): string {
		return `setServer(${this.status})`;
	}
}

class SetGpuInfoCmd implements fc.Command<Model, Real> {
	readonly info: GpuInfo[];
	constructor(info: GpuInfo[]) {
		this.info = info;
	}
	check(): boolean {
		return true;
	}
	run(m: Model, real: Real): void {
		real.getState().setGpuInfo(this.info);
		m.gpuInfo = this.info;
		const s = real.getState();
		if (s.gpuInfo !== this.info) {
			throw new Error("gpuInfo mismatch");
		}
	}
	toString(): string {
		return `setGpu(${this.info.length === 0 ? "[]" : this.info[0]!.name})`;
	}
}

class SetRuntimeInfoCmd implements fc.Command<Model, Real> {
	readonly info: RuntimeInfo | null;
	constructor(info: RuntimeInfo | null) {
		this.info = info;
	}
	check(): boolean {
		return true;
	}
	run(m: Model, real: Real): void {
		real.getState().setRuntimeInfo(this.info);
		m.runtimeInfo = this.info;
		const s = real.getState();
		if (s.runtimeInfo !== this.info) {
			throw new Error("runtimeInfo mismatch");
		}
		if (this.info !== null) {
			if (typeof s.runtimeInfo?.device !== "string") {
				throw new Error("runtimeInfo.device invalid");
			}
			if (typeof s.runtimeInfo?.is_gpu !== "boolean") {
				throw new Error("runtimeInfo.is_gpu invalid");
			}
			if (!Array.isArray(s.runtimeInfo?.providers)) {
				throw new Error("runtimeInfo.providers invalid");
			}
		}
	}
	toString(): string {
		return `setRuntime(${this.info === null ? "null" : this.info.device})`;
	}
}

const gpuInfoEntryArb: fc.Arbitrary<GpuInfo> = fc.record({
	name: fc.string({ maxLength: 32 }),
	total_vram_bytes: fc.integer({ min: 0, max: 2 ** 32 }),
});

const gpuInfoArb: fc.Arbitrary<GpuInfo[]> = fc.array(gpuInfoEntryArb, {
	maxLength: 4,
});

const runtimeInfoArb: fc.Arbitrary<RuntimeInfo> = fc.record({
	device: fc.constantFrom("cpu", "cuda", "directml"),
	is_gpu: fc.boolean(),
	model: fc.option(fc.string({ maxLength: 16 }), { nil: null }),
	providers: fc.array(fc.string({ maxLength: 12 }), { maxLength: 4 }),
	realtime_model: fc.option(fc.string({ maxLength: 16 }), { nil: null }),
});

const commandsArb = fc.commands(
	[
		fc
			.constantFrom(...CONNECTION_STATUSES)
			.map((s) => new SetConnectionStatusCmd(s)),
		fc.constantFrom(...SERVER_STATUSES).map((s) => new SetServerStatusCmd(s)),
		gpuInfoArb.map((info) => new SetGpuInfoCmd(info)),
		fc
			.option(runtimeInfoArb, { nil: null })
			.map((info) => new SetRuntimeInfoCmd(info)),
	],
	{ maxCommands: 35 },
);

test("connection-store: arbitrary command sequence preserves field orthogonality and enums", () => {
	fc.assert(
		fc.property(commandsArb, (cmds) => {
			resetStore();
			fc.modelRun(
				() => ({ model: freshModel(), real: useConnectionStore }),
				cmds,
			);
		}),
		{ numRuns: 100 },
	);
});

// Idempotency: setting the same value twice yields the same state both times.
test("connection-store: setters are idempotent (same value twice == once)", () => {
	fc.assert(
		fc.property(
			fc.constantFrom(...CONNECTION_STATUSES),
			fc.constantFrom(...SERVER_STATUSES),
			(conn, server) => {
				resetStore();
				useConnectionStore.getState().setConnectionStatus(conn);
				useConnectionStore.getState().setServerStatus(server);
				const snap1 = { ...useConnectionStore.getState() };
				useConnectionStore.getState().setConnectionStatus(conn);
				useConnectionStore.getState().setServerStatus(server);
				const snap2 = { ...useConnectionStore.getState() };
				return (
					snap1.connectionStatus === snap2.connectionStatus &&
					snap1.serverStatus === snap2.serverStatus &&
					snap1.gpuInfo === snap2.gpuInfo &&
					snap1.runtimeInfo === snap2.runtimeInfo
				);
			},
		),
		{ numRuns: 60 },
	);
});
