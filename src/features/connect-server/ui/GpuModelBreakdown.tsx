import {
	AiChat02Icon,
	AiCloud01Icon,
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
import { surfaceBg } from "@/shared/lib/surface";
import type {
	BreakdownDevice,
	BreakdownRow,
	BreakdownSection,
	BreakdownStatus,
} from "../lib/runtime-model-breakdown";
import type { BreakdownPool } from "../lib/runtime-resource-fill";

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

/** Grayscale ladder for the meter's per-section slices (and the matching
 *  swatch beside each section's share %): brightest for the pipeline's lead
 *  engine, stepping down in section order. Deliberately NOT hue-coded — the
 *  footprint card stays neutral like the rest of the footer chrome. */
const SECTION_TONE = {
	stt: "bg-foreground/75",
	tts: "bg-foreground/55",
	dictionary: "bg-foreground/40",
	post: "bg-foreground/25",
} as const satisfies Record<BreakdownSection["key"], string>;

/** The "everything else" slice — the OS plus other apps' share of the pool.
 *  Hatched over a solid dim base: the stripes mark it as ambient pressure (not
 *  another WinSTT engine) while the base keeps the span reading as *used*
 *  memory — bare panel background showing through the gaps made the slice look
 *  empty. */
const SYSTEM_STRIPES: CSSProperties = {
	backgroundColor:
		"color-mix(in oklab, var(--color-foreground) 12%, transparent)",
	backgroundImage:
		"repeating-linear-gradient(135deg, color-mix(in oklab, var(--color-foreground) 24%, transparent) 0 2px, transparent 2px 5px)",
};

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
		/>
	);
}

/** The footprint panel these rows live in ({@link ModelFootprintWindow}) sits at
 *  surface level 5 — the cloud badge punches its disc out with that surface so
 *  the sign notches cleanly into the maker logo. */
const PANEL_SURFACE = 5;

/**
 * A cloud row's leading mark: the maker logo (or a bare cloud glyph when no
 * brand mark is bundled) badged with a small cloud sign, mirroring the model
 * chip elsewhere. A logo-less cloud row already reads as cloud, so it isn't
 * double-badged. Non-cloud rows just render their logo.
 */
function ModelMark({ row }: { row: BreakdownRow }): ReactNode {
	const mark = row.logoSrc ? (
		<ModelLogo src={row.logoSrc} title={row.maker} />
	) : row.cloud ? (
		<HugeiconsIcon
			aria-hidden="true"
			className="size-3.5 shrink-0 self-center text-foreground-secondary"
			icon={AiCloud01Icon}
		/>
	) : null;
	if (!mark) {
		return null;
	}
	if (!(row.cloud && row.logoSrc)) {
		return mark;
	}
	return (
		<span className="relative inline-flex shrink-0 self-center">
			{mark}
			<span
				aria-hidden="true"
				className={cn(
					"-right-1 -bottom-1 absolute inline-flex items-center justify-center rounded-full text-foreground-secondary",
					surfaceBg(PANEL_SURFACE),
				)}
			>
				<HugeiconsIcon icon={AiCloud01Icon} size={8} />
			</span>
		</span>
	);
}

/** One icon-led metric on a model's meta line: a dim glyph that carries the
 *  unit (VRAM / RAM / disk) plus the bare size, with the full phrase kept
 *  sr-only. This whole breakdown already renders INSIDE a styled popup, so a
 *  native `title` here would stack an OS tooltip over it. */
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
		<span className={cn("flex items-center gap-1", tone)}>
			<HugeiconsIcon
				aria-hidden="true"
				className="shrink-0 text-foreground-dim"
				icon={icon}
				size={11}
			/>
			<span className="tabular-nums">{size}</span>
			<span className="sr-only">{title}</span>
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
				<ModelMark row={row} />
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
	return row.name === null ? (
		<StatusEntry row={row} t={t} />
	) : (
		<ModelEntry row={row} t={t} />
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
	pools: { gpu: BreakdownPool; cpu: BreakdownPool },
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
	const pool = pools[device].usedBytes;
	if (pool <= 0) {
		return null;
	}
	return { percent: (memSum / pool) * 100, device };
}

/** One model slice of a pool meter: a pipeline section's bytes resident there. */
interface MeterSegment {
	key: BreakdownSection["key"];
	bytes: number;
}

/** Each section's runtime bytes living in `device`'s pool, in section order —
 *  the model slices of that pool's meter. Sections whose weights live on the
 *  other device (or nowhere locally) contribute no slice here. */
function segmentsForDevice(
	sections: BreakdownSection[],
	device: BreakdownDevice,
): MeterSegment[] {
	const segments: MeterSegment[] = [];
	for (const section of sections) {
		let bytes = 0;
		for (const row of section.rows) {
			if (row.device === device && row.memBytes !== null) {
				bytes += row.memBytes;
			}
		}
		if (bytes > 0) {
			segments.push({ key: section.key, bytes });
		}
	}
	return segments;
}

function segmentWidth(bytes: number, totalBytes: number): string {
	return `${Math.min(100, (bytes / totalBytes) * 100).toFixed(2)}%`;
}

/**
 * One pool's stacked meter: a slice per pipeline section (toned to match the
 * swatch beside that section's share %), then a hatched "System" slice for the
 * rest of the pool's used memory, with the free space left as bare track. The
 * System slice gets a legend line beneath — it's the one slice with no section
 * heading to explain it.
 */
function SegmentedMeter({
	pool,
	segments,
	t,
}: {
	pool: BreakdownPool;
	segments: MeterSegment[];
	t: StatusBarTranslateFn;
}): ReactNode {
	const modelBytes = segments.reduce((sum, segment) => sum + segment.bytes, 0);
	const systemBytes = Math.max(0, pool.usedBytes - modelBytes);
	return (
		<div className="flex flex-col gap-1">
			{/* Opening snapshots must paint at their final widths; animating from
			    the hidden window's previous sample looks like a recalculation. */}
			<div className="flex h-1 w-full gap-px overflow-hidden rounded-full bg-foreground/[0.06]">
				{segments.map((segment) => (
					<div
						className={cn("h-full shrink-0", SECTION_TONE[segment.key])}
						data-section={segment.key}
						data-slot="footprint-resource-segment"
						key={segment.key}
						style={{ width: segmentWidth(segment.bytes, pool.totalBytes) }}
					/>
				))}
				{systemBytes > 0 ? (
					<div
						className="h-full shrink-0"
						data-section="system"
						data-slot="footprint-resource-segment"
						style={{
							...SYSTEM_STRIPES,
							width: segmentWidth(systemBytes, pool.totalBytes),
						}}
					/>
				) : null}
			</div>
			{systemBytes > 0 ? (
				<div className="flex items-center justify-between gap-2 text-[9px] text-foreground-muted">
					<span className="flex items-center gap-1">
						<span
							aria-hidden="true"
							className="size-1.5 shrink-0 rounded-[2px]"
							style={SYSTEM_STRIPES}
						/>
						{t("breakdownSystem")}
					</span>
					<span className="tabular-nums">{sizeText(systemBytes)}</span>
				</div>
			) : null}
		</div>
	);
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

/** "used / total" figure with the pool's unit phrase, or `null` when the pool
 *  size is unknown (no snapshot yet). */
function poolLabel(
	t: StatusBarTranslateFn,
	device: BreakdownDevice,
	pool: BreakdownPool,
): string | null {
	if (pool.totalBytes <= 0) {
		return null;
	}
	const size = `${sizeText(pool.usedBytes)} / ${sizeText(pool.totalBytes)}`;
	return device === "cpu"
		? t("breakdownMemRam", { size })
		: t("breakdownMemVram", { size });
}

interface GpuModelBreakdownProps {
	sections: BreakdownSection[];
	/** Live used/total for both device pools; `device` picks the pool the header
	 *  leads with. The other pool gets its own smaller meter when any section's
	 *  weights live there (the always-CPU dictionary on a GPU host). */
	usage: {
		device: "gpu" | "cpu";
		pools: { gpu: BreakdownPool; cpu: BreakdownPool };
	};
	t: StatusBarTranslateFn;
}

export function GpuModelBreakdown({
	sections,
	usage,
	t,
}: GpuModelBreakdownProps): ReactNode {
	const activePool = usage.pools[usage.device];
	const usageLabel = poolLabel(t, usage.device, activePool);
	const otherDevice: BreakdownDevice = usage.device === "gpu" ? "cpu" : "gpu";
	const otherPool = usage.pools[otherDevice];
	const otherSegments = segmentsForDevice(sections, otherDevice);
	// The secondary pool only earns a meter when our models actually hold some
	// of it — otherwise it's pure system noise the sentence footer covers.
	const otherLabel =
		otherSegments.length > 0 ? poolLabel(t, otherDevice, otherPool) : null;
	return (
		<div className="flex min-w-[228px] flex-col gap-2.5 text-[11px]">
			{/* Header: live device pressure — the headline number plus a slim meter
			    stacked per consumer: one grayscale slice per pipeline section (keyed
			    by the swatches on the section headings below), a hatched System
			    slice for everything that isn't ours, bare track for free memory. */}
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
				{usageLabel ? (
					<SegmentedMeter
						pool={activePool}
						segments={segmentsForDevice(sections, usage.device)}
						t={t}
					/>
				) : null}
				{/* On a GPU host the dictionary (and any other CPU-pinned engine)
				    lives in RAM, not VRAM — give that pool its own meter so the
				    breakdown accounts for every local byte, not just the lead pool. */}
				{otherLabel ? (
					<div className="flex flex-col gap-1 pt-0.5">
						<div className="flex items-baseline justify-end">
							<span className="shrink-0 text-[10px] text-foreground-muted tabular-nums">
								{otherLabel}
							</span>
						</div>
						<SegmentedMeter pool={otherPool} segments={otherSegments} t={t} />
					</div>
				) : null}
			</div>
			<div className="h-px bg-divider" />
			{/* Per-engine footprint, one block per pipeline stage. Section glyphs
			    align to the Settings tabs; entries hang under the label. */}
			<div className="flex flex-col gap-2.5">
				{sections.map((section) => {
					const share = sectionShare(section, usage.pools);
					return (
						<div className="flex flex-col gap-1" key={section.key}>
							<div className="flex items-center justify-between gap-2">
								<div className="flex min-w-0 items-center gap-1.5">
									{/* No title — the label is visible right beside the glyph, and
									    this block already sits inside a styled popup. */}
									<span className="flex shrink-0">
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
									<span className="flex shrink-0 items-center gap-1">
										{/* Swatch keys this section to its slice of the meter(s)
										    above — same tone, same grayscale ladder. */}
										<span
											aria-hidden="true"
											className={cn(
												"size-1.5 shrink-0 rounded-[2px]",
												SECTION_TONE[section.key],
											)}
										/>
										<span className="text-[10px] text-foreground-secondary tabular-nums">
											{formatShare(share.percent)}
										</span>
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
