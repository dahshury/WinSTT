import { describe, expect, test } from "bun:test";
import type { SystemInfoEntry } from "@/shared/api/ipc-client";
import { assessOllamaFit } from "./hardware-fit";

const GB = 1_000_000_000;

function gpuSystem(vramBytes: number, ramBytes = 32 * GB): SystemInfoEntry {
	return {
		gpus: [{ name: "RTX 4090", total_vram_bytes: vramBytes }],
		total_ram_bytes: ramBytes,
	};
}

function cpuOnlySystem(ramBytes: number): SystemInfoEntry {
	return { gpus: [], total_ram_bytes: ramBytes };
}

describe("assessOllamaFit", () => {
	test("returns fits=true with target=undefined when sizeBytes is zero (no info to flag)", () => {
		const res = assessOllamaFit(0, gpuSystem(8 * GB));
		expect(res.fits).toBe(true);
		expect(res.target).toBeUndefined();
		expect(res.shortfall).toBeUndefined();
	});

	test("returns fits=true with target=undefined when systemInfo is null (no info yet)", () => {
		const res = assessOllamaFit(2 * GB, null);
		expect(res.fits).toBe(true);
		expect(res.target).toBeUndefined();
		expect(res.shortfall).toBe("unknown");
	});

	test("fits on GPU when the largest VRAM covers size + headroom", () => {
		// 2 GB model → required = 2*1.2 + 1 = 3.4 GB. An 8 GB GPU clearly covers it.
		const res = assessOllamaFit(2 * GB, gpuSystem(8 * GB));
		expect(res.fits).toBe(true);
		expect(res.target).toBe("gpu");
	});

	test("does not fall back to CPU when GPU present but too small (flags VRAM shortfall)", () => {
		// 8 GB model → required ≈ 8*1.2 + 1 = 10.6 GB. A 6 GB GPU can't host it,
		// even though the system might have plenty of RAM. We flag VRAM rather
		// than silently saying "fine" because the user explicitly has a GPU and
		// would expect Ollama to use it.
		const res = assessOllamaFit(8 * GB, gpuSystem(6 * GB, 64 * GB));
		expect(res.fits).toBe(false);
		expect(res.target).toBeUndefined();
		expect(res.shortfall).toBe("vram");
		expect(res.availableBytes).toBe(6 * GB);
	});

	test("fits on CPU on GPU-less host when 70% of RAM covers size + headroom", () => {
		// 2 GB model → required ≈ 3.4 GB. 70% of 16 GB ≈ 11.2 GB, ample.
		const res = assessOllamaFit(2 * GB, cpuOnlySystem(16 * GB));
		expect(res.fits).toBe(true);
		expect(res.target).toBe("cpu");
	});

	test("flags RAM shortfall on GPU-less host when 70% of RAM isn't enough", () => {
		// 10 GB model → required ≈ 13 GB. 70% of 8 GB = 5.6 GB, nowhere near.
		const res = assessOllamaFit(10 * GB, cpuOnlySystem(8 * GB));
		expect(res.fits).toBe(false);
		expect(res.target).toBeUndefined();
		expect(res.shortfall).toBe("ram");
	});

	test("picks the largest GPU's VRAM when multiple GPUs are present", () => {
		// Two GPUs — only the bigger one matters for the fit decision because
		// Ollama loads each layer onto one device.
		const sys: SystemInfoEntry = {
			gpus: [
				{ name: "iGPU", total_vram_bytes: 1 * GB },
				{ name: "RTX 4070", total_vram_bytes: 12 * GB },
			],
			total_ram_bytes: 32 * GB,
		};
		const res = assessOllamaFit(8 * GB, sys);
		expect(res.fits).toBe(true);
		expect(res.target).toBe("gpu");
		expect(res.availableBytes).toBe(12 * GB);
	});
});
