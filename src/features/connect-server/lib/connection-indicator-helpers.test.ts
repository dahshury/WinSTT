import { describe, expect, test } from "bun:test";
import { CpuIcon, GpuIcon } from "@hugeicons/core-free-icons";
import {
	FOOTER_TOOLTIP_DELAY,
	resolveConnectionChip,
	resolveGpuChipConfig,
} from "./connection-indicator-helpers";

describe("FOOTER_TOOLTIP_DELAY", () => {
	test("is the documented 1500ms hover delay", () => {
		expect(FOOTER_TOOLTIP_DELAY).toBe(1500);
		expect(Number.isFinite(FOOTER_TOOLTIP_DELAY)).toBe(true);
	});
});

describe("resolveGpuChipConfig", () => {
	test("GPU branch yields the GpuIcon, 'GPU' label and success colour", () => {
		const cfg = resolveGpuChipConfig(true);
		expect(cfg.icon).toBe(GpuIcon);
		expect(cfg.label).toBe("GPU");
		expect(cfg.colorClass).toBe("text-success");
	});

	test("CPU branch yields the CpuIcon, 'CPU' label and dim colour", () => {
		const cfg = resolveGpuChipConfig(false);
		expect(cfg.icon).toBe(CpuIcon);
		expect(cfg.label).toBe("CPU");
		expect(cfg.colorClass).toBe("text-foreground-dim");
	});

	test("GPU and CPU configs use different icons (no copy-paste swap)", () => {
		expect(resolveGpuChipConfig(true).icon).not.toBe(
			resolveGpuChipConfig(false).icon,
		);
	});
});

describe("resolveConnectionChip", () => {
	test("maps connectionStatus 'connecting' straight to 'connecting'", () => {
		// The explicit map short-circuits BEFORE the connected/running checks,
		// so serverStatus/runtimeIsGpu are irrelevant here.
		expect(resolveConnectionChip("connecting", "running", true)).toBe(
			"connecting",
		);
		expect(resolveConnectionChip("connecting", "idle", null)).toBe(
			"connecting",
		);
	});

	test("maps connectionStatus 'error' straight to 'error'", () => {
		expect(resolveConnectionChip("error", "running", true)).toBe("error");
		expect(resolveConnectionChip("error", "idle", null)).toBe("error");
	});

	test("any non-connected, non-mapped status is 'offline'", () => {
		expect(resolveConnectionChip("disconnected", "running", true)).toBe(
			"offline",
		);
		expect(resolveConnectionChip("reconnecting", "running", true)).toBe(
			"offline",
		);
		expect(resolveConnectionChip("", "running", true)).toBe("offline");
	});

	test("connected but server not yet running stays 'connecting'", () => {
		// WS connected != recorder ready. The green chip must wait for
		// server_ready (serverStatus === "running").
		expect(resolveConnectionChip("connected", "idle", true)).toBe("connecting");
		expect(resolveConnectionChip("connected", "starting", true)).toBe(
			"connecting",
		);
	});

	test("connected + running but runtimeIsGpu null still reads 'connecting'", () => {
		// runtimeInfo.is_gpu is the authoritative GPU/CPU truth; until it
		// arrives we cannot pick the chip variant, so we hold at connecting.
		expect(resolveConnectionChip("connected", "running", null)).toBe(
			"connecting",
		);
	});

	test("connected + running + runtimeIsGpu true → 'gpu'", () => {
		expect(resolveConnectionChip("connected", "running", true)).toBe("gpu");
	});

	test("connected + running + runtimeIsGpu false → still 'gpu' (chip kind, not GPU truth)", () => {
		// resolveConnectionChip only decides WHICH chip family (offline/
		// connecting/error/gpu). The "gpu" chip is the steady-state "ready"
		// chip; whether it renders a GPU or CPU glyph is resolveGpuChipConfig's
		// job. So runtimeIsGpu===false (CPU runtime, but READY) must still
		// resolve to the "gpu" steady chip, NOT "connecting".
		expect(resolveConnectionChip("connected", "running", false)).toBe("gpu");
	});

	test("'connecting' map entry wins even though connectionStatus !== 'connected'", () => {
		// Guards the ordering: the map lookup precedes the !== "connected"
		// offline fallback. If the offline check ran first, "connecting" would
		// wrongly become "offline".
		expect(resolveConnectionChip("connecting", "running", false)).toBe(
			"connecting",
		);
	});

	test("returns one of the four ConnectionChip variants for arbitrary inputs", () => {
		const valid = new Set(["connecting", "error", "offline", "gpu"]);
		const statuses = [
			"connecting",
			"error",
			"connected",
			"disconnected",
			"weird",
			"",
		];
		const servers = ["running", "idle", ""];
		const gpus: (boolean | null)[] = [true, false, null];
		for (const c of statuses) {
			for (const s of servers) {
				for (const g of gpus) {
					expect(valid.has(resolveConnectionChip(c, s, g))).toBe(true);
				}
			}
		}
	});
});
