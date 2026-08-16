import {
	AiChat02Icon,
	AiMicIcon,
	AiVoiceGeneratorIcon,
	Books02Icon,
	Calendar03Icon,
	Delete02Icon,
	File01Icon,
	Folder01Icon,
	VoiceIdIcon,
} from "@hugeicons/core-free-icons";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslations } from "use-intl";
import type { AppDataUsageEntry } from "@/bindings";
import { commands } from "@/bindings";
import { appDataUsage, removeAppDataCategory } from "@/shared/api/ipc-client";
import { emitAppDataCategoryRemoved } from "@/shared/lib/app-data-events";
import type { SettingsTranslateFn } from "@/shared/i18n/translation-types";
import { cn } from "@/shared/lib/cn";
import { formatBytes } from "@/shared/lib/format-bytes";
import { ConfirmDialog } from "@/shared/ui/confirm-dialog";
import { ABOUT_ACTION_WIDTH, AboutActionButton } from "./AboutActionButton";
import { AboutRow } from "./AboutActionRow";

/** Category glyphs reuse the model-footprint / settings vocabulary so the
 *  storage view reads with the same language as the rest of the app. */
const CATEGORY_ICON = {
	stt: AiChat02Icon,
	tts: AiVoiceGeneratorIcon,
	voices: VoiceIdIcon,
	dictionary: Books02Icon,
	wakeword: AiMicIcon,
	history: Calendar03Icon,
	logs: File01Icon,
	other: Folder01Icon,
} as const satisfies Record<string, typeof AiChat02Icon>;

const CATEGORY_LABEL = {
	stt: "appDataUsageStt",
	tts: "appDataUsageTts",
	voices: "appDataUsageVoices",
	dictionary: "appDataUsageDictionary",
	wakeword: "appDataUsageWakeword",
	history: "appDataUsageHistory",
	logs: "appDataUsageLogs",
	other: "appDataUsageOther",
} as const satisfies Record<string, string>;

type CategoryKey = keyof typeof CATEGORY_ICON;

// "Other" is settings + misc cache — removing it would reset the app, so it has
// no per-row action (the Rust command rejects it too). Use "Reset to defaults".
function isRemovable(key: string): boolean {
	return key !== "other" && key in CATEGORY_ICON;
}

function sizeText(bytes: number): string {
	return (
		formatBytes(bytes, {
			minUnit: "KB",
			gbDecimals: 1,
			mbDecimals: 0,
			kbDecimals: 0,
		}) ?? "0 KB"
	);
}

function categoryLabel(key: string, t: SettingsTranslateFn): string {
	return key in CATEGORY_LABEL ? t(CATEGORY_LABEL[key as CategoryKey]) : key;
}

/** Holds the trailing action column open on rows that carry no action, so every
 *  size, share and meter in the list ends on the same vertical. */
function ActionColumnSpacer(): ReactNode {
	return (
		<div aria-hidden="true" className={cn(ABOUT_ACTION_WIDTH, "shrink-0")} />
	);
}

/** Sizes read as data, not prose: one muted, tabular, right-aligned column. */
function SizeText({ children }: { children: ReactNode }): ReactNode {
	return (
		<span className="shrink-0 text-body-sm text-foreground-secondary tabular-nums">
			{children}
		</span>
	);
}

function refetchAppDataUsage(
	mounted: { current: boolean },
	setEntries: (entries: AppDataUsageEntry[]) => void,
): void {
	appDataUsage()
		.then((data) => {
			if (mounted.current) {
				setEntries(data);
			}
		})
		.catch(() => {
			if (mounted.current) {
				setEntries([]);
			}
		});
}

function UsageRow({
	entry,
	total,
	t,
	onRemove,
}: {
	entry: AppDataUsageEntry;
	total: number;
	t: SettingsTranslateFn;
	onRemove: (entry: AppDataUsageEntry) => void;
}): ReactNode {
	const known = entry.key in CATEGORY_ICON;
	const percent = total > 0 ? Math.round((entry.bytes / total) * 100) : 0;
	const label = categoryLabel(entry.key, t);
	return (
		<AboutRow
			action={
				isRemovable(entry.key) ? (
					<AboutActionButton
						ariaLabel={t("appDataUsageRemoveAria", { item: label })}
						icon={Delete02Icon}
						onClick={() => onRemove(entry)}
					>
						{t("appDataUsageRemove")}
					</AboutActionButton>
				) : (
					<ActionColumnSpacer />
				)
			}
			ariaLabel={label}
			leadingIcon={
				known ? CATEGORY_ICON[entry.key as CategoryKey] : Folder01Icon
			}
			title={label}
			value={
				<SizeText>
					{sizeText(entry.bytes)}
					<span className="ml-1.5 text-foreground-muted">{percent}%</span>
				</SizeText>
			}
		>
			<div className="mt-0.5 h-1.5 overflow-hidden rounded-full bg-foreground/[0.06]">
				<div
					className="h-full rounded-full bg-gradient-to-r from-foreground/25 to-foreground/40"
					style={{ width: `${percent}%` }}
				/>
			</div>
		</AboutRow>
	);
}

/**
 * The disk-usage half of the Application data section: a total, then one row
 * per non-empty category carrying its share and its own removal action.
 *
 * Rendered as a bare fragment of rows — NOT a self-contained card — so the rows
 * land directly in the section's divided list and read as the same kind of
 * thing as the destructive rows below them. Sibling of the model-footprint
 * breakdown, applied to on-disk app data.
 */
export function AppDataUsageBreakdown(): ReactNode {
	const t = useTranslations("settings");
	const tc = useTranslations("common");
	const [entries, setEntries] = useState<AppDataUsageEntry[] | null>(null);
	const [pending, setPending] = useState<AppDataUsageEntry | null>(null);
	const mounted = useRef(true);

	useEffect(() => {
		mounted.current = true;
		refetchAppDataUsage(mounted, setEntries);
		return () => {
			mounted.current = false;
		};
	}, []);

	const handleConfirm = async () => {
		const key = pending?.key;
		setPending(null);
		if (!key) {
			return;
		}
		try {
			// History is cleared via its own command (deletes rows + their WAVs);
			// every other category goes through the per-category cleanup command.
			if (key === "history") {
				await commands.historyClear();
			} else {
				await removeAppDataCategory(key);
			}
			// The files are gone; whoever keeps a record of them has to drop it too,
			// or the feature goes on offering entries that name nothing on disk.
			emitAppDataCategoryRemoved(key);
		} catch {
			// Best-effort: the refetch below reflects whatever was actually freed.
		}
		refetchAppDataUsage(mounted, setEntries);
	};

	const all = entries ?? [];
	const total = all.reduce((acc, e) => acc + e.bytes, 0);
	const rows = all.filter((e) => e.bytes > 0).sort((a, b) => b.bytes - a.bytes);

	// Still loading, or nothing on disk yet — contribute no rows. The section
	// itself does not collapse: its destructive group renders regardless.
	if (entries === null || total <= 0) {
		return null;
	}

	const pendingLabel = pending ? categoryLabel(pending.key, t) : "";

	return (
		<>
			<ConfirmDialog
				cancelLabel={tc("cancel")}
				confirmLabel={t("appDataUsageRemove")}
				description={
					<div className="flex flex-col gap-2">
						<p>
							{t("appDataUsageRemoveDescription", {
								item: pendingLabel,
								size: pending ? sizeText(pending.bytes) : "",
							})}
						</p>
						<p className="font-medium text-error">
							{t("permanentActionWarning")}
						</p>
					</div>
				}
				onConfirm={handleConfirm}
				onOpenChange={(open) => {
					if (!open) {
						setPending(null);
					}
				}}
				open={pending !== null}
				title={t("appDataUsageRemoveTitle", { item: pendingLabel })}
			/>
			{/* The total is a row like any other (minus the category glyph, so it
			    reads as the parent of the indented rows under it) — that keeps it
			    on the same baseline grid and its size in the same column as the
			    per-category sizes. */}
			<AboutRow
				action={<ActionColumnSpacer />}
				title={t("appDataUsageTitle")}
				value={
					<SizeText>
						{t("appDataTotalUsed", { size: sizeText(total) })}
					</SizeText>
				}
			/>
			{rows.map((entry) => (
				<UsageRow
					entry={entry}
					key={entry.key}
					onRemove={setPending}
					t={t}
					total={total}
				/>
			))}
		</>
	);
}
