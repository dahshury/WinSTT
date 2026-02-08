"use client";

import {
	CloudIcon,
	CpuIcon,
	GpuIcon,
	Plug01Icon,
	WifiDisconnected01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useConnectionStore } from "../model/connection-store";

const RE_VENDOR = /^(NVIDIA|AMD|Intel)\s+/i;
const RE_FAMILY = /^(GeForce|Radeon|Instinct)\s+/i;
const RE_BUS = /[-\s](?:SXM\d?|PCIe|PCI-E|NVLink)[-\s]?\d*\w*/gi;
const RE_MEM = /[-\s]\d+\s?GB$/i;
const RE_SUPER = /\bSUPER\b/i;
const RE_LAPTOP = /\bLAPTOP\s*GPU\b/i;

/** Shorten a GPU/CPU name to its essential model identifier. */
function shortenGpuName(raw: string): string {
	let name = raw.trim();
	name = name.replace(RE_VENDOR, "");
	name = name.replace(RE_FAMILY, "");
	name = name.replace(RE_BUS, "");
	name = name.replace(RE_MEM, "");
	name = name.replace(RE_SUPER, "S");
	name = name.replace(RE_LAPTOP, "");
	return name.trim() || raw.trim();
}

export function ConnectionIndicator() {
	const status = useConnectionStore((s) => s.connectionStatus);
	const gpuInfo = useConnectionStore((s) => s.gpuInfo);

	if (status === "connecting") {
		return (
			<div className="flex items-center gap-1">
				<HugeiconsIcon color="var(--color-warning)" icon={CloudIcon} size={12} />
				<span className="font-medium text-[10px]" style={{ color: "var(--color-warning)" }}>
					CONNECTING
				</span>
			</div>
		);
	}

	if (status === "error") {
		return (
			<div className="flex items-center gap-1">
				<HugeiconsIcon color="var(--color-error)" icon={Plug01Icon} size={12} />
				<span className="font-medium text-[10px]" style={{ color: "var(--color-error)" }}>
					ERROR
				</span>
			</div>
		);
	}

	if (status !== "connected" || !gpuInfo) {
		return (
			<div className="flex items-center gap-1">
				<HugeiconsIcon color="var(--color-error)" icon={WifiDisconnected01Icon} size={12} />
				<span className="font-medium text-[10px]" style={{ color: "var(--color-error)" }}>
					OFFLINE
				</span>
			</div>
		);
	}

	const isGpu = gpuInfo.available;
	const icon = isGpu ? GpuIcon : CpuIcon;
	const color = isGpu ? "var(--color-success)" : "var(--color-foreground-dim)";
	const label = isGpu ? "GPU" : "CPU";
	const shortName = shortenGpuName(gpuInfo.name);

	return (
		<div className="flex items-center gap-1">
			<HugeiconsIcon color={color} icon={icon} size={12} />
			<span className="font-medium text-[10px]" style={{ color }}>
				{label}
			</span>
			<span className="text-[9px] text-foreground-dim/60">{shortName}</span>
		</div>
	);
}
