import {
	AiChat02Icon,
	AiEditingIcon,
	AiVoiceGeneratorIcon,
	Books02Icon,
	CpuIcon,
	GpuIcon,
	HardDriveDownloadIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import type { CSSProperties, ReactNode } from "react";
import type { StatusBarTranslateFn } from "@/shared/i18n/translation-types";
import { cn } from "@/shared/lib/cn";
import { formatBytes } from "@/shared/lib/format-bytes";
import type {
	BreakdownDevice,
	BreakdownRow,
	BreakdownSection,
	BreakdownStatus,
} from "../lib/runtime-model-breakdown";

const SECTION_LABEL = {
	stt: "breakdownStt",
	tts: "breakdownTts",
	dictionary: "breakdownDictionary",
	post: "breakdownPost",
} as const satisfies Record<BreakdownSection["key"], string>;

/** Section glyphs mirror the Settings sidebar so the footprint card reads with
 *  the same vocabulary as the window it summarizes: Transcription, Read Aloud,
 *  Vocabulary, and Processing tabs respectively. */
const SECTION_ICON = {
	stt: AiChat02Icon,
	tts: AiVoiceGeneratorIcon,
	dictionary: Books02Icon,
	post: AiEditingIcon,
} as const satisfies Record<BreakdownSection["key"], typeof AiChat02Icon>;

const STATUS_LABEL = {
	off: "breakdownOff",
	cloud: "breakdownCloud",
	onDevice: "breakdownOnDevice",
} as const satisfies Record<BreakdownStatus, string>;

function sizeText(bytes: number): string {
	return formatBytes(bytes, { gbDecimals: 1, mbDecimals: 0 }) ?? "0 MB";
}

/** Full unit-qualified figure ("60 MB VRAM") — used as the hover/screen-reader
 *  title on the compact icon+size meta item, where the icon carries the unit. */
function memText(t: StatusBarTranslateFn, row: BreakdownRow): string | null {
	if (row.memBytes === null) {
		return null;
	}
	const size = sizeText(row.memBytes);
	return row.device === "cpu"
		? t("breakdownMemRam", { size })
		: t("breakdownMemVram", { size });
}

/** Disk size is only worth a second figure when it differs from the memory
 *  estimate — for engines whose runtime footprint we approximate *by* the
 *  on-disk weights the two numbers are identical and one suffices. */
function diskText(t: StatusBarTranslateFn, row: BreakdownRow): string | null {
	if (row.diskBytes === null || row.diskBytes === row.memBytes) {
		return null;
	}
	return t("breakdownDisk", { size: sizeText(row.diskBytes) });
}

/**
 * The maker's brand mark, painted as a monochrome silhouette via a CSS alpha
 * mask — the logo's own colors are discarded so it stays grayscale with the
 * rest of the footer chrome (same treatment as the footer model chip).
 */
function ModelLogo({
	src,
	title,
}: {
	src: string;
	title?: string | null | undefined;
}): ReactNode {
	return (
		<span
			aria-label={title ?? undefined}
			className="size-3.5 shrink-0 self-center bg-foreground-secondary [mask-image:var(--breakdown-logo)] [mask-position:center] [mask-repeat:no-repeat] [mask-size:contain] [-webkit-mask-image:var(--breakdown-logo)] [-webkit-mask-position:center] [-webkit-mask-repeat:no-repeat] [-webkit-mask-size:contain]"
			data-logo-src={src}
			style={{ "--breakdown-logo": `url("${src}")` } as CSSProperties}
			title={title ?? undefined}
		/>
	);
}

/** One icon-led metric on a model's meta line: a dim glyph that carries the
 *  unit (VRAM / RAM / disk) plus the bare size, with the full phrase on the
 *  title for hover + screen readers. Mirrors the model-picker card meta. */
function MetaFigure({
	icon,
	size,
	title,
	tone,
}: {
	icon: IconSvgElement;
	size: string;
	title: string;
	tone: string;
}): ReactNode {
	return (
		<span className={cn("flex items-center gap-1", tone)} title={title}>
			<HugeiconsIcon
				aria-hidden="true"
				className="shrink-0 text-foreground-dim"
				icon={icon}
				size={11}
			/>
			<span className="tabular-nums">{size}</span>
		</span>
	);
}

/**
 * A loaded model on its own two-line entry: the name (led by the maker logo)
 * gets the full popup width, and its metrics — quant tag, memory, disk — drop
 * to a calmer icon-led meta line beneath. Splitting the row vertically is what
 * un-crams the ≤260px tooltip.
 */
function ModelEntry({
	row,
	t,
}: {
	row: BreakdownRow;
	t: StatusBarTranslateFn;
}): ReactNode {
	const mem = memText(t, row);
	const disk = diskText(t, row);
	const memIcon = row.device === "cpu" ? CpuIcon : GpuIcon;
	return (
		<div className="flex flex-col gap-0.5">
			<div className="flex min-w-0 items-center gap-1.5">
				{row.logoSrc ? <ModelLogo src={row.logoSrc} title={row.maker} /> : null}
				<span className="truncate text-[12px] text-foreground">{row.name}</span>
				{row.live ? (
					<span className="shrink-0 text-[8.5px] text-accent uppercase tracking-wide">
						{t("breakdownLive")}
					</span>
				) : null}
			</div>
			{row.detail || mem || disk ? (
				<div className="flex items-center gap-2 text-[10px]">
					{row.detail ? (
						<span className="shrink-0 rounded-[3px] bg-foreground/[0.06] px-1 py-px text-[8.5px] text-foreground-muted uppercase leading-[1.4] tracking-wide">
							{row.detail}
						</span>
					) : null}
					{mem && row.memBytes !== null ? (
						<MetaFigure
							icon={memIcon}
							size={sizeText(row.memBytes)}
							title={mem}
							tone="text-foreground-secondary"
						/>
					) : null}
					{disk && row.diskBytes !== null ? (
						<MetaFigure
							icon={HardDriveDownloadIcon}
							size={sizeText(row.diskBytes)}
							title={disk}
							tone="text-foreground-muted"
						/>
					) : null}
				</div>
			) : null}
		</div>
	);
}

/**
 * An empty / cloud / on-device slot: one quiet line. The status word reads dim
 * when the slot is off, brighter when something's actually wired up, and any
 * free-form qualifier (provider or cloud model id) trails it in muted text.
 */
function StatusEntry({
	row,
	t,
}: {
	row: BreakdownRow;
	t: StatusBarTranslateFn;
}): ReactNode {
	return (
		<div className="flex min-w-0 items-baseline gap-1.5">
			<span
				className={cn(
					"shrink-0 text-[11px]",
					row.status === "off"
						? "text-foreground-dim"
						: "text-foreground-secondary",
				)}
			>
				{row.status ? t(STATUS_LABEL[row.status]) : ""}
			</span>
			{row.detail ? (
				<span className="min-w-0 truncate text-[10px] text-foreground-muted">
					{row.detail}
				</span>
			) : null}
		</div>
	);
}

function Row({
	row,
	t,
}: {
	row: BreakdownRow;
	t: StatusBarTranslateFn;
}): ReactNode {
	return row.name !== null ? (
		<ModelEntry row={row} t={t} />
	) : (
		<StatusEntry row={row} t={t} />
	);
}

/**
 * A section's combined runtime footprint as a share of the live *used* memory
 * on the device its weights live in — VRAM for GPU rows, RAM for CPU rows (the
 * dictionary always runs on CPU even on a GPU host, so it's measured against
 * RAM). `null` when the section has no local footprint or the pool is unknown.
 */
function sectionShare(
	section: BreakdownSection,
	usedByDevice: { gpu: number; cpu: number },
): { percent: number; device: BreakdownDevice } | null {
	let memSum = 0;
	let device: BreakdownDevice | null = null;
	for (const row of section.rows) {
		if (row.memBytes !== null && row.device) {
			memSum += row.memBytes;
			device = row.device;
		}
	}
	if (device === null || memSum <= 0) {
		return null;
	}
	const pool = usedByDevice[device];
	if (pool <= 0) {
		return null;
	}
	return { percent: (memSum / pool) * 100, device };
}

/** Sub-1% footprints round to "<1%" rather than a misleading "0%"; everything
 *  else is a whole-number percent capped at 100 (an estimate can momentarily
 *  exceed the measured-used figure). */
function formatShare(percent: number): string {
	if (percent < 1) {
		return "<1%";
	}
	return `${Math.min(100, Math.round(percent))}%`;
}

interface GpuModelBreakdownProps {
	sections: BreakdownSection[];
	/** Live total VRAM/RAM usage on the active device, for the header line. */
	usage: {
		device: "gpu" | "cpu";
		totalBytes: number;
		usedBytes: number;
		/** Live used bytes per device, so each section's footprint can be shown as
		 *  a share of the pool its weights actually live in (VRAM vs RAM). */
		usedByDevice: { gpu: number; cpu: number };
	};
	t: StatusBarTranslateFn;
}

export function GpuModelBreakdown({
	sections,
	usage,
	t,
}: GpuModelBreakdownProps): ReactNode {
	const usageText =
		usage.totalBytes > 0
			? `${sizeText(usage.usedBytes)} / ${sizeText(usage.totalBytes)}`
			: null;
	const usagePercent =
		usage.totalBytes > 0
			? Math.max(0, Math.min(100, (usage.usedBytes / usage.totalBytes) * 100))
			: 0;
	const usageLabel =
		usageText === null
			? null
			: usage.device === "cpu"
				? t("breakdownMemRam", { size: usageText })
				: t("breakdownMemVram", { size: usageText });
	return (
		<div className="flex min-w-[228px] flex-col gap-2.5 text-[11px]">
			{/* Header: live device pressure — the headline number plus a slim,
			    grayscale meter that echoes the footer chip's own fill bar. */}
			<div className="flex flex-col gap-1.5">
				<div className="flex items-baseline justify-between gap-3">
					<span className="font-medium text-[9.5px] text-foreground-muted uppercase tracking-[0.08em]">
						{t("breakdownTitle")}
					</span>
					{usageLabel ? (
						<span className="shrink-0 text-[10px] text-foreground-secondary tabular-nums">
							{usageLabel}
						</span>
					) : null}
				</div>
				{usageText ? (
					<div className="h-[3px] w-full overflow-hidden rounded-full bg-foreground/[0.06]">
						<div
							className="h-full rounded-full bg-gradient-to-r from-foreground/25 to-foreground/45 transition-[width] duration-500 ease-out"
							style={{ width: `${usagePercent}%` }}
						/>
					</div>
				) : null}
			</div>
			<div className="h-px bg-divider" />
			{/* Per-engine footprint, one block per pipeline stage. Section glyphs
			    align to the Settings tabs; entries hang under the label. */}
			<div className="flex flex-col gap-2.5">
				{sections.map((section) => {
					const share = sectionShare(section, usage.usedByDevice);
					return (
						<div className="flex flex-col gap-1" key={section.key}>
							<div className="flex items-center justify-between gap-2">
								<div className="flex min-w-0 items-center gap-1.5">
									<span
										className="flex shrink-0"
										title={t(SECTION_LABEL[section.key])}
									>
										<HugeiconsIcon
											className="text-foreground-dim"
											disableSecondaryOpacity={true}
											icon={SECTION_ICON[section.key]}
											size={11}
										/>
									</span>
									<span className="font-medium text-[9px] text-foreground-muted uppercase tracking-[0.07em]">
										{t(SECTION_LABEL[section.key])}
									</span>
								</div>
								{share ? (
									<span className="shrink-0 text-[10px] text-foreground-secondary tabular-nums">
										{formatShare(share.percent)}
									</span>
								) : null}
							</div>
							{section.rows.length > 0 ? (
								<div className="flex flex-col gap-1.5 ps-[18px]">
									{section.rows.map((row) => (
										<Row key={row.key} row={row} t={t} />
									))}
								</div>
							) : null}
						</div>
					);
				})}
			</div>
		</div>
	);
}
